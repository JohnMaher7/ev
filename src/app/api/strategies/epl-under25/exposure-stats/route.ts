import { NextRequest, NextResponse } from 'next/server';

import { config } from '@/lib/config';
import { supabaseAdmin } from '@/lib/supabase';

type StrategyKey = typeof config.strategies.eplUnder25.key | typeof config.strategies.eplUnder25GoalReact.key;

type StrategyTradeRow = {
  id: string;
  strategy_key: StrategyKey;
  betfair_event_id: string | null;
  kickoff_at: string | null;
  back_price: number | null;
  lay_price: number | null;
  realised_pnl: number | null;
  pnl: number | null;
  status: string;
  competition_name: string | null;
};

type TradeEventRow = {
  trade_id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
};

type ExposureStat = {
  strategy_key: StrategyKey;
  setting_key: 'lay_ticks_below_back' | 'profit_target_pct';
  setting_value: number;
  average_exposure_seconds: number;
  total_trades: number;
  losing_trades_excluded: number;
  net_pnl: number;
};

const STRATEGY_KEYS: StrategyKey[] = [config.strategies.eplUnder25.key, config.strategies.eplUnder25GoalReact.key];

const SETTLED_STATUSES = ['hedged', 'completed'] as const;

const REQUIRED_EVENT_TYPES = [
  // epl_under25 (pre-match hedge)
  'LAY_PLACED',
  'LAY_MATCHED',
  'LAY_MATCHED_DURING_GOAL',
  // epl_under25_goalreact (goal reactive)
  'POSITION_ENTERED',
  'PROFIT_TARGET_HIT',
] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getEventTimestampMs(event: TradeEventRow): number | null {
  const payloadTs = event.payload && typeof event.payload === 'object' ? event.payload.timestamp : undefined;
  if (typeof payloadTs === 'string') {
    const parsed = parseIsoMs(payloadTs);
    if (parsed != null) return parsed;
  }
  return parseIsoMs(event.occurred_at);
}

function getTickStep(price: number): number {
  // Betfair tick ladder (decimal odds)
  // 1.01-2.00: 0.01; 2.02-3.00: 0.02; 3.05-4.00: 0.05; 4.1-6.0: 0.1; 6.2-10.0: 0.2
  // 10.5-20.0: 0.5; 21-30: 1; 32-50: 2; 55-100: 5; 110-1000: 10
  const bands: Array<{ max: number; step: number }> = [
    { max: 2.0, step: 0.01 },
    { max: 3.0, step: 0.02 },
    { max: 4.0, step: 0.05 },
    { max: 6.0, step: 0.1 },
    { max: 10.0, step: 0.2 },
    { max: 20.0, step: 0.5 },
    { max: 30.0, step: 1.0 },
    { max: 50.0, step: 2.0 },
    { max: 100.0, step: 5.0 },
    { max: 1000.0, step: 10.0 },
  ];
  const p = Math.max(1.01, Math.min(price, 1000));
  return (bands.find((b) => p <= b.max) || bands[bands.length - 1]).step;
}

function normalizePrice(price: number): number {
  // Float-safe normalization for odds-like numbers.
  // Two decimals is enough for all tick sizes up to 0.01/0.02/0.05/0.1/0.2/0.5.
  return Number(price.toFixed(2));
}

function prevTick(price: number): number {
  const step = getTickStep(price);
  const next = price - step;
  return Math.max(1.01, normalizePrice(next));
}

function inferTicksBelow(backPrice: number, layPrice: number): number | null {
  const from = normalizePrice(backPrice);
  const to = normalizePrice(layPrice);
  if (to > from) return null;

  let ticks = 0;
  let current = from;
  while (ticks < 2000 && current > to) {
    current = prevTick(current);
    ticks += 1;
  }
  return Math.abs(current - to) <= 1e-9 ? ticks : null;
}

function inferProfitTargetPct(backPrice: number, layPrice: number): number | null {
  if (layPrice <= 0) return null;
  const raw = (backPrice / layPrice - 1) * 100;
  if (!Number.isFinite(raw)) return null;
  // Profit targets are expected to be positive. If we detect a non-positive value,
  // treat it as "unknown" to avoid mis-bucketing stop-loss trades into 0%.
  const rounded = Math.round(raw);
  return rounded > 0 ? rounded : null;
}

function getTradeRealisedPnl(trade: StrategyTradeRow): number | null {
  if (isFiniteNumber(trade.realised_pnl)) return trade.realised_pnl;
  if (isFiniteNumber(trade.pnl)) return trade.pnl;
  return null;
}

function getFirstEvent(events: TradeEventRow[], eventTypes: string[]): TradeEventRow | null {
  for (const ev of events) {
    if (!eventTypes.includes(ev.event_type)) continue;
    return ev;
  }
  return null;
}

function getFirstEventMs(events: TradeEventRow[], eventTypes: string[]): number | null {
  for (const ev of events) {
    if (!eventTypes.includes(ev.event_type)) continue;
    const ts = getEventTimestampMs(ev);
    if (ts != null) return ts;
  }
  return null;
}

function inferSettingValueFromEvents(trade: StrategyTradeRow, tradeEvents: TradeEventRow[]): number | null {
  if (trade.strategy_key === config.strategies.eplUnder25.key) {
    const layPlaced = getFirstEvent(tradeEvents, ['LAY_PLACED']);
    const payload = layPlaced?.payload || {};
    const layPrice = payload && typeof payload === 'object' && isFiniteNumber(payload.price) ? payload.price : null;

    const greenUp = payload && typeof payload === 'object' ? (payload.green_up_calc as Record<string, unknown> | undefined) : undefined;
    const backMatchedPrice = greenUp && isFiniteNumber(greenUp.back_matched_price) ? greenUp.back_matched_price : null;

    if (backMatchedPrice != null && layPrice != null) {
      return inferTicksBelow(backMatchedPrice, layPrice);
    }

    // Fallback: best-effort from trade row (may be mutated later, so prefer event above)
    if (isFiniteNumber(trade.back_price) && isFiniteNumber(trade.lay_price)) {
      return inferTicksBelow(trade.back_price, trade.lay_price);
    }
    return null;
  }

  // Goal reactive: infer profit target from POSITION_ENTERED (entry back + target lay).
  const entered = getFirstEvent(tradeEvents, ['POSITION_ENTERED']);
  const payload = entered?.payload || {};
  const entryPrice = payload && typeof payload === 'object' && isFiniteNumber(payload.entry_price) ? payload.entry_price : null;
  const targetLayPrice = payload && typeof payload === 'object' && isFiniteNumber(payload.lay_price) ? payload.lay_price : null;

  if (entryPrice != null && targetLayPrice != null) {
    return inferProfitTargetPct(entryPrice, targetLayPrice);
  }

  // Fallback: best-effort from trade row (avoid bucketing into 0% via inferProfitTargetPct safeguards)
  if (isFiniteNumber(trade.back_price) && isFiniteNumber(trade.lay_price)) {
    return inferProfitTargetPct(trade.back_price, trade.lay_price);
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const strategyKey = searchParams.get('strategy_key');
    const competitionName = searchParams.get('competition_name');
    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');
    const limit = parseInt(searchParams.get('limit') || '1000', 10);

    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({ success: true, data: [] satisfies ExposureStat[] });
    }

    const keys: StrategyKey[] = strategyKey && STRATEGY_KEYS.includes(strategyKey as StrategyKey)
      ? [strategyKey as StrategyKey]
      : STRATEGY_KEYS;

    const statuses = status ? [status] : Array.from(SETTLED_STATUSES);

    let tradeQuery = supabaseAdmin
      .from('strategy_trades')
      .select('id,strategy_key,betfair_event_id,kickoff_at,back_price,lay_price,realised_pnl,pnl,status,competition_name')
      .in('strategy_key', keys)
      .in('status', statuses)
      .order('kickoff_at', { ascending: false })
      .limit(Number.isFinite(limit) ? limit : 1000);

    if (dateFrom) {
      tradeQuery = tradeQuery.gte('kickoff_at', dateFrom);
    }
    if (dateTo) {
      tradeQuery = tradeQuery.lte('kickoff_at', dateTo);
    }

    const { data: tradesRaw, error: tradeErr } = await tradeQuery;
    if (tradeErr) throw new Error(tradeErr.message);

    const trades = (tradesRaw || []) as StrategyTradeRow[];
    if (trades.length === 0) {
      return NextResponse.json({ success: true, data: [] satisfies ExposureStat[] });
    }

    // Enrich competition_name from fixtures when filtering by competition (mirrors trades endpoint).
    let filteredTrades = trades;
    if (competitionName) {
      const eventIds = trades.map((t) => t.betfair_event_id).filter(Boolean) as string[];
      const uniqueEventIds = Array.from(new Set(eventIds));
      if (uniqueEventIds.length > 0) {
        const { data: fixtures, error: fixtureErr } = await supabaseAdmin
          .from('strategy_fixtures')
          .select('betfair_event_id, competition, strategy_key')
          .in('strategy_key', keys)
          .in('betfair_event_id', uniqueEventIds);

        if (fixtureErr) throw new Error(fixtureErr.message);

        const fixtureMap = new Map<string, { competition: string | null }>();
        (fixtures || []).forEach((f) => {
          fixtureMap.set(`${String(f.strategy_key)}-${String(f.betfair_event_id)}`, { competition: f.competition ?? null });
        });

        filteredTrades = trades.filter((trade) => {
          const tradeCompetition = trade.competition_name;
          const isPlaceholderCompetition =
            !tradeCompetition || tradeCompetition === 'Multiple Leagues' || tradeCompetition === 'Unknown';
          const fixtureCompetition = trade.betfair_event_id
            ? fixtureMap.get(`${trade.strategy_key}-${trade.betfair_event_id}`)?.competition
            : null;
          const resolvedCompetition = (isPlaceholderCompetition ? fixtureCompetition : tradeCompetition) || tradeCompetition || fixtureCompetition;
          return resolvedCompetition === competitionName;
        });
      } else {
        filteredTrades = [];
      }
    }

    if (filteredTrades.length === 0) {
      return NextResponse.json({ success: true, data: [] satisfies ExposureStat[] });
    }

    const tradeIds = filteredTrades.map((t) => t.id);

    const { data: eventsRaw, error: eventsErr } = await supabaseAdmin
      .from('strategy_trade_events')
      .select('trade_id,event_type,occurred_at,payload')
      .in('trade_id', tradeIds)
      .in('event_type', Array.from(REQUIRED_EVENT_TYPES))
      .order('occurred_at', { ascending: true });

    if (eventsErr) throw new Error(eventsErr.message);

    const events = (eventsRaw || []) as TradeEventRow[];
    const eventsByTradeId = new Map<string, TradeEventRow[]>();
    for (const ev of events) {
      const arr = eventsByTradeId.get(ev.trade_id) || [];
      arr.push(ev);
      eventsByTradeId.set(ev.trade_id, arr);
    }

    const agg = new Map<
      string,
      {
        strategy_key: StrategyKey;
        setting_key: ExposureStat['setting_key'];
        setting_value: number;
        sum_exposure_seconds: number;
        trades_counted: number;
        losing_trades_excluded: number;
        sum_pnl: number;
      }
    >();

    for (const trade of filteredTrades) {
      const pnl = getTradeRealisedPnl(trade);
      const isLosing = pnl != null ? pnl < 0 : false;

      const setting_key: ExposureStat['setting_key'] =
        trade.strategy_key === config.strategies.eplUnder25.key ? 'lay_ticks_below_back' : 'profit_target_pct';

      const tradeEvents = eventsByTradeId.get(trade.id) || [];
      const setting = inferSettingValueFromEvents(trade, tradeEvents);

      if (setting == null) {
        // Can't attribute to a settings bucket (legacy trades missing events, etc.)
        continue;
      }

      const groupKey = `${trade.strategy_key}|${setting_key}|${setting}`;
      const existing =
        agg.get(groupKey) || {
          strategy_key: trade.strategy_key,
          setting_key,
          setting_value: setting,
          sum_exposure_seconds: 0,
          trades_counted: 0,
          losing_trades_excluded: 0,
          sum_pnl: 0,
        };

      if (pnl != null) {
        existing.sum_pnl += pnl;
      }

      if (isLosing) {
        existing.losing_trades_excluded += 1;
        agg.set(groupKey, existing);
        continue;
      }

      let exposureSeconds: number | null = null;
      if (trade.strategy_key === config.strategies.eplUnder25.key) {
        const kickoffMs = parseIsoMs(trade.kickoff_at);
        const layMatchedMs = getFirstEventMs(tradeEvents, ['LAY_MATCHED', 'LAY_MATCHED_DURING_GOAL']);
        if (kickoffMs != null && layMatchedMs != null) {
          exposureSeconds = Math.max(0, Math.floor((layMatchedMs - kickoffMs) / 1000));
        }
      } else {
        const entryMs = getFirstEventMs(tradeEvents, ['POSITION_ENTERED']);
        const layMatchedMs = getFirstEventMs(tradeEvents, ['PROFIT_TARGET_HIT']);
        if (entryMs != null && layMatchedMs != null && layMatchedMs >= entryMs) {
          exposureSeconds = Math.floor((layMatchedMs - entryMs) / 1000);
        }
      }

      // Exclude when lay never matched (no matching event for win flow).
      if (exposureSeconds == null) {
        agg.set(groupKey, existing);
        continue;
      }

      existing.sum_exposure_seconds += exposureSeconds;
      existing.trades_counted += 1;
      agg.set(groupKey, existing);
    }

    const out: ExposureStat[] = Array.from(agg.values())
      .filter((row) => row.trades_counted > 0 || row.losing_trades_excluded > 0)
      .map((row) => {
        const avg = row.trades_counted > 0 ? row.sum_exposure_seconds / row.trades_counted : 0;
        return {
          strategy_key: row.strategy_key,
          setting_key: row.setting_key,
          setting_value: row.setting_value,
          average_exposure_seconds: Math.round(avg),
          total_trades: row.trades_counted,
          losing_trades_excluded: row.losing_trades_excluded,
          net_pnl: Number(row.sum_pnl.toFixed(2)),
        };
      })
      .sort((a, b) => {
        if (a.strategy_key !== b.strategy_key) return a.strategy_key.localeCompare(b.strategy_key);
        if (a.setting_key !== b.setting_key) return a.setting_key.localeCompare(b.setting_key);
        return a.setting_value - b.setting_value;
      });

    return NextResponse.json({ success: true, data: out });
  } catch (error) {
    console.error('[api][epl-under25][exposure-stats][GET]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

