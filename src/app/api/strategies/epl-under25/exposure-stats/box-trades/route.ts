import { NextRequest, NextResponse } from 'next/server';

import { config } from '@/lib/config';
import { supabaseAdmin } from '@/lib/supabase';

type StrategyKey = typeof config.strategies.eplUnder25.key | typeof config.strategies.eplUnder25GoalReact.key;

type StrategyTradeRow = {
  id: string;
  strategy_key: StrategyKey;
  betfair_event_id: string | null;
  kickoff_at: string | null;
  competition_name: string | null;
  back_price: number | null;
  lay_price: number | null;
  realised_pnl: number | null;
  pnl: number | null;
  status: string;
};

type TradeEventRow = {
  trade_id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
};

const STRATEGY_KEYS: StrategyKey[] = [config.strategies.eplUnder25.key, config.strategies.eplUnder25GoalReact.key];
const SETTLED_STATUSES = ['hedged', 'completed'] as const;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlaceholderCompetition(name: string | null): boolean {
  return !name || name === 'Multiple Leagues' || name === 'Unknown';
}

function getTickStep(price: number): number {
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
  const rounded = Math.round(raw);
  return rounded > 0 ? rounded : null;
}

function getFirstEvent(events: TradeEventRow[], eventTypes: string[]): TradeEventRow | null {
  for (const ev of events) {
    if (!eventTypes.includes(ev.event_type)) continue;
    return ev;
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

    if (isFiniteNumber(trade.back_price) && isFiniteNumber(trade.lay_price)) {
      return inferTicksBelow(trade.back_price, trade.lay_price);
    }
    return null;
  }

  const entered = getFirstEvent(tradeEvents, ['POSITION_ENTERED']);
  const payload = entered?.payload || {};
  const entryPrice = payload && typeof payload === 'object' && isFiniteNumber(payload.entry_price) ? payload.entry_price : null;
  const targetLayPrice = payload && typeof payload === 'object' && isFiniteNumber(payload.lay_price) ? payload.lay_price : null;

  if (entryPrice != null && targetLayPrice != null) {
    return inferProfitTargetPct(entryPrice, targetLayPrice);
  }

  if (isFiniteNumber(trade.back_price) && isFiniteNumber(trade.lay_price)) {
    return inferProfitTargetPct(trade.back_price, trade.lay_price);
  }
  return null;
}

async function fetchFixtureCompetitionMap(strategyKeys: StrategyKey[], eventIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (!supabaseAdmin) return map;
  if (eventIds.length === 0) return map;

  const uniqueEventIds = Array.from(new Set(eventIds));
  for (const batch of chunk(uniqueEventIds, 500)) {
    const { data, error } = await supabaseAdmin
      .from('strategy_fixtures')
      .select('betfair_event_id, competition, strategy_key')
      .in('strategy_key', strategyKeys)
      .in('betfair_event_id', batch);
    if (error) throw new Error(error.message);

    (data || []).forEach((f) => {
      map.set(`${String(f.strategy_key)}-${String(f.betfair_event_id)}`, (f.competition ?? null) as string | null);
    });
  }

  return map;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategyKeyRaw = searchParams.get('strategy_key');
    const settingKey = searchParams.get('setting_key'); // 'lay_ticks_below_back' | 'profit_target_pct'
    const settingValueRaw = searchParams.get('setting_value');
    const competitionName = searchParams.get('competition_name');
    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');

    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({ success: true, data: [] as string[] });
    }

    if (!strategyKeyRaw || !STRATEGY_KEYS.includes(strategyKeyRaw as StrategyKey)) {
      return NextResponse.json({ success: false, error: 'Missing/invalid strategy_key' }, { status: 400 });
    }
    if (settingKey !== 'lay_ticks_below_back' && settingKey !== 'profit_target_pct') {
      return NextResponse.json({ success: false, error: 'Missing/invalid setting_key' }, { status: 400 });
    }

    const settingValue = settingValueRaw ? Number(settingValueRaw) : NaN;
    if (!Number.isFinite(settingValue)) {
      return NextResponse.json({ success: false, error: 'Missing/invalid setting_value' }, { status: 400 });
    }

    const strategyKey = strategyKeyRaw as StrategyKey;
    const expectedSettingKey = strategyKey === config.strategies.eplUnder25.key ? 'lay_ticks_below_back' : 'profit_target_pct';
    if (settingKey !== expectedSettingKey) {
      return NextResponse.json({ success: false, error: 'setting_key does not match strategy_key' }, { status: 400 });
    }

    let q = supabaseAdmin
      .from('strategy_trades')
      .select('id,strategy_key,betfair_event_id,kickoff_at,competition_name,back_price,lay_price,realised_pnl,pnl,status')
      .eq('strategy_key', strategyKey)
      .in('status', Array.from(SETTLED_STATUSES))
      .not('kickoff_at', 'is', null)
      // Ensure P&L present => “settled trade”
      .or('realised_pnl.not.is.null,pnl.not.is.null')
      .order('kickoff_at', { ascending: false })
      .limit(5000);

    if (dateFrom) q = q.gte('kickoff_at', dateFrom);
    if (dateTo) q = q.lte('kickoff_at', dateTo);

    const { data: tradesRaw, error: tradeErr } = await q;
    if (tradeErr) throw new Error(tradeErr.message);
    const trades = (tradesRaw || []) as StrategyTradeRow[];

    if (trades.length === 0) {
      return NextResponse.json({ success: true, data: [] as string[] });
    }

    // Resolve competition from fixtures (mirrors other endpoints), then filter by competition_name.
    const fixtureMap = await fetchFixtureCompetitionMap(
      [strategyKey],
      trades.map((t) => t.betfair_event_id).filter(Boolean) as string[],
    );

    const filteredTrades = competitionName
      ? trades.filter((t) => {
          const fixtureCompetition = t.betfair_event_id ? fixtureMap.get(`${t.strategy_key}-${t.betfair_event_id}`) : null;
          const resolvedCompetition = (isPlaceholderCompetition(t.competition_name) ? fixtureCompetition : t.competition_name) || fixtureCompetition;
          return resolvedCompetition === competitionName;
        })
      : trades;

    if (filteredTrades.length === 0) {
      return NextResponse.json({ success: true, data: [] as string[] });
    }

    const tradeIds = filteredTrades.map((t) => t.id);
    const requiredEventTypes = strategyKey === config.strategies.eplUnder25.key ? ['LAY_PLACED'] : ['POSITION_ENTERED'];

    const { data: eventsRaw, error: eventsErr } = await supabaseAdmin
      .from('strategy_trade_events')
      .select('trade_id,event_type,occurred_at,payload')
      .in('trade_id', tradeIds)
      .in('event_type', requiredEventTypes)
      .order('occurred_at', { ascending: true });

    if (eventsErr) throw new Error(eventsErr.message);
    const events = (eventsRaw || []) as TradeEventRow[];

    const eventsByTradeId = new Map<string, TradeEventRow[]>();
    for (const ev of events) {
      const arr = eventsByTradeId.get(ev.trade_id) || [];
      arr.push(ev);
      eventsByTradeId.set(ev.trade_id, arr);
    }

    const ids: string[] = [];
    for (const trade of filteredTrades) {
      const evs = eventsByTradeId.get(trade.id) || [];
      const inferred = inferSettingValueFromEvents(trade, evs);
      if (inferred == null) continue;
      if (inferred === settingValue) ids.push(trade.id);
    }

    return NextResponse.json({ success: true, data: ids });
  } catch (error) {
    console.error('[api][epl-under25][exposure-stats][box-trades][GET]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

