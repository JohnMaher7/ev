import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

// Support all three strategies
const STRATEGY_KEYS = [
  config.strategies.eplUnder25.key,
  config.strategies.eplUnder25GoalReact.key,
  config.strategies.eplOver25Breakout.key,
];

type StrategyKey = typeof config.strategies.eplUnder25.key | typeof config.strategies.eplUnder25GoalReact.key | typeof config.strategies.eplOver25Breakout.key;

const SETTLED_STATUSES = ['hedged', 'completed'] as const;

type TradeRow = {
  id: string;
  strategy_key: StrategyKey;
  betfair_event_id: string | null;
  kickoff_at: string | null;
  competition_name: string | null;
  event_name: string | null;
  back_price: number | null;
  lay_price: number | null;
} & Record<string, unknown>;

type FixtureRow = {
  betfair_event_id: string;
  strategy_key: StrategyKey;
  home: string | null;
  away: string | null;
  competition: string | null;
};

type TradeEventRow = {
  trade_id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPayloadNumber(payload: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!payload) return null;
  const v = payload[key];
  return isFiniteNumber(v) ? v : null;
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

function demoTrades() {
  const now = Date.now();
  return [
    {
      id: 'demo-trade-1',
      strategy_key: config.strategies.eplUnder25.key,
      event_id: 'demo-event',
      betfair_event_id: '30000012345',
      betfair_market_id: '1.234567890',
      selection_id: 123456,
      runner_name: 'Under 2.5 Goals',
      kickoff_at: new Date(now + 30 * 60 * 1000).toISOString(),
      status: 'scheduled',
      back_price: null,
      back_size: null,
      lay_price: null,
      lay_size: null,
      pnl: null,
      margin: null,
      commission_paid: null,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      last_error: null,
      home: 'Man City',
      away: 'Arsenal',
      competition: 'English Premier League',
      competition_name: 'English Premier League',
      event_name: 'Man City v Arsenal',
      back_price_snapshot: null,
      back_stake: null,
      total_stake: null,
      realised_pnl: null,
      settled_at: null,
    },
    {
      id: 'demo-trade-2',
      strategy_key: config.strategies.eplUnder25.key,
      event_id: 'demo-event-2',
      betfair_event_id: '30000067890',
      betfair_market_id: '1.987654321',
      selection_id: 987654,
      runner_name: 'Under 2.5 Goals',
      kickoff_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      status: 'hedged',
      back_price: 2.08,
      back_size: 10,
      lay_price: 1.9,
      lay_size: 11,
      pnl: 2.1,
      margin: 0.21,
      commission_paid: 0.22,
      created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      last_error: null,
      home: 'Liverpool',
      away: 'Chelsea',
      competition: 'English Premier League',
      competition_name: 'English Premier League',
      event_name: 'Liverpool v Chelsea',
      back_price_snapshot: 2.08,
      back_stake: 10,
      total_stake: 21,
      realised_pnl: 2.1,
      settled_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-trade-3',
      strategy_key: config.strategies.eplUnder25GoalReact.key,
      event_id: 'demo-event-3',
      betfair_event_id: '30000011111',
      betfair_market_id: '1.111111111',
      selection_id: 111111,
      runner_name: 'Under 2.5 Goals',
      kickoff_at: new Date(now - 30 * 60 * 1000).toISOString(),
      status: 'live',
      back_price: 3.2,
      back_size: 100,
      lay_price: null,
      lay_size: null,
      pnl: null,
      margin: null,
      commission_paid: null,
      created_at: new Date(now - 60 * 60 * 1000).toISOString(),
      updated_at: new Date(now - 5 * 60 * 1000).toISOString(),
      last_error: null,
      home: 'Tottenham',
      away: 'Newcastle',
      competition: 'English Premier League',
      competition_name: 'English Premier League',
      event_name: 'Tottenham v Newcastle',
      back_price_snapshot: 3.2,
      back_stake: 100,
      total_stake: 100,
      realised_pnl: null,
      settled_at: null,
    },
  ];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const strategyKey = searchParams.get('strategy_key'); // Filter by specific strategy
    const boxSettingKey = searchParams.get('box_setting_key');
    const boxSettingValueRaw = searchParams.get('box_setting_value');
    const competitionName = searchParams.get('competition_name');
    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');
    const cursor = searchParams.get('cursor');
    const ids = searchParams.get('ids');
    // Increase limit when no filters are applied (to show all trades)
    const hasFilters = !!(status || strategyKey || boxSettingKey || boxSettingValueRaw || competitionName || dateFrom || dateTo || cursor || ids);
    const defaultLimit = hasFilters ? 50 : 1000; // Show more when no filters
    const limit = parseInt(searchParams.get('limit') || String(defaultLimit), 10);

    // If requesting competition names, handle it early
    const getCompetitionNames = searchParams.get('get_competition_names') === 'true';
    if (getCompetitionNames && (config.demoMode || !supabaseAdmin)) {
      const demoCompetitions = ['English Premier League'];
      return NextResponse.json({ success: true, data: [], cursor: null, competitionNames: demoCompetitions });
    }

    if (config.demoMode || !supabaseAdmin) {
      let demoData = demoTrades();

      // Apply filters to demo data
      if (status) {
        demoData = demoData.filter(t => t.status === status);
      }
      if (strategyKey) {
        demoData = demoData.filter(t => t.strategy_key === strategyKey);
      }
      if (competitionName) {
        demoData = demoData.filter(t => t.competition_name === competitionName);
      }
      if (dateFrom) {
        demoData = demoData.filter(t => t.kickoff_at && t.kickoff_at >= dateFrom);
      }
      if (dateTo) {
        demoData = demoData.filter(t => t.kickoff_at && t.kickoff_at <= dateTo);
      }

      // Sort by kickoff_at descending (most recent first)
      demoData.sort((a, b) => {
        const aTime = a.kickoff_at ? new Date(a.kickoff_at).getTime() : 0;
        const bTime = b.kickoff_at ? new Date(b.kickoff_at).getTime() : 0;
        return bTime - aTime;
      });

      return NextResponse.json({ success: true, data: demoData, cursor: null });
    }

    const isBoxFilterActive = !!(boxSettingKey && boxSettingValueRaw);
    if (isBoxFilterActive) {
      // Box filter is a table-only affordance triggered by the Exposure stat cards.
      // It must be stable and must not require passing large id lists via querystring.
      if (!strategyKey || !STRATEGY_KEYS.includes(strategyKey as StrategyKey)) {
        return NextResponse.json(
          { success: false, error: 'Missing/invalid strategy_key for box filter' },
          { status: 400 },
        );
      }
      const strategyKeyValue = strategyKey as StrategyKey;

      if (boxSettingKey !== 'lay_ticks_below_back' && boxSettingKey !== 'profit_target_pct') {
        return NextResponse.json(
          { success: false, error: 'Missing/invalid box_setting_key' },
          { status: 400 },
        );
      }

      const expectedBoxKey =
        strategyKeyValue === config.strategies.eplUnder25.key ? 'lay_ticks_below_back' : 'profit_target_pct';
      if (boxSettingKey !== expectedBoxKey) {
        return NextResponse.json(
          { success: false, error: 'box_setting_key does not match strategy_key' },
          { status: 400 },
        );
      }

      const desiredValue = Number(boxSettingValueRaw);
      if (!Number.isFinite(desiredValue)) {
        return NextResponse.json(
          { success: false, error: 'Missing/invalid box_setting_value' },
          { status: 400 },
        );
      }

      const requiredEventType = strategyKeyValue === config.strategies.eplUnder25.key ? 'LAY_PLACED' : 'POSITION_ENTERED';

      const pageSize = Math.min(1000, Math.max(200, limit * 5));
      const out: TradeRow[] = [];
      let scanCursor: string | null = cursor || null;
      let nextCursor: string | null = null;
      let exhausted = false;

      // We may need to scan multiple pages to fill a filtered page of `limit` results.
      for (let page = 0; page < 20 && out.length < limit && !exhausted; page += 1) {
        let pageQuery = supabaseAdmin
          .from('strategy_trades')
          .select('*')
          .eq('strategy_key', strategyKeyValue)
          .in('status', Array.from(SETTLED_STATUSES))
          .not('kickoff_at', 'is', null)
          .or('realised_pnl.not.is.null,pnl.not.is.null')
          .order('kickoff_at', { ascending: false })
          .limit(pageSize);

        if (dateFrom) pageQuery = pageQuery.gte('kickoff_at', dateFrom);
        if (dateTo) pageQuery = pageQuery.lte('kickoff_at', dateTo);
        if (scanCursor) pageQuery = pageQuery.lt('kickoff_at', scanCursor);

        const { data: raw, error: rawErr } = await pageQuery;
        if (rawErr) throw new Error(rawErr.message);

        const rows = ((raw || []) as TradeRow[]);
        if (rows.length === 0) {
          exhausted = true;
          break;
        }

        // Enrich fixtures
        let enrichedData: TradeRow[] = rows;
        const eventIds = rows.map((t) => t.betfair_event_id).filter(Boolean) as string[];
        const uniqueEventIds = Array.from(new Set(eventIds));
        if (uniqueEventIds.length > 0) {
          const { data: fixturesRaw, error: fixtureError } = await supabaseAdmin
            .from('strategy_fixtures')
            .select('betfair_event_id, home, away, competition, strategy_key')
            .in('strategy_key', STRATEGY_KEYS)
            .in('betfair_event_id', uniqueEventIds);

          if (!fixtureError && fixturesRaw) {
            const fixtures = fixturesRaw as FixtureRow[];
            const fixtureMap = new Map<string, FixtureRow>();
            fixtures.forEach((f) => fixtureMap.set(`${f.strategy_key}-${f.betfair_event_id}`, f));

            enrichedData = rows.map((trade) => {
              const fixture = fixtureMap.get(`${trade.strategy_key}-${trade.betfair_event_id}`);
              const tradeCompetition = trade.competition_name;
              const isPlaceholderCompetition =
                !tradeCompetition || tradeCompetition === 'Multiple Leagues' || tradeCompetition === 'Unknown';
              const resolvedCompetitionName =
                (isPlaceholderCompetition ? fixture?.competition : tradeCompetition) ||
                fixture?.competition ||
                'English Premier League';
              const eventName =
                trade.event_name ||
                (fixture?.home && fixture?.away ? `${fixture.home} v ${fixture.away}` : null);

              return {
                ...trade,
                home: fixture?.home || null,
                away: fixture?.away || null,
                competition: resolvedCompetitionName,
                competition_name: resolvedCompetitionName,
                event_name: eventName,
              } as TradeRow;
            });
          }
        }

        // Load events needed to infer setting (for this page only)
        const tradeIds = enrichedData.map((t) => t.id);
        const { data: eventsRaw, error: eventsErr } = await supabaseAdmin
          .from('strategy_trade_events')
          .select('trade_id, event_type, occurred_at, payload')
          .in('trade_id', tradeIds)
          .eq('event_type', requiredEventType)
          .order('occurred_at', { ascending: true });

        if (eventsErr) throw new Error(eventsErr.message);

        const events = (eventsRaw || []) as TradeEventRow[];
        const eventByTradeId = new Map<string, TradeEventRow>();
        events.forEach((ev) => {
          if (!eventByTradeId.has(ev.trade_id)) eventByTradeId.set(ev.trade_id, ev);
        });

        // Iterate in raw order to compute the continuation cursor correctly.
        for (let i = 0; i < enrichedData.length; i += 1) {
          const trade = enrichedData[i];
          const tradeKickoffAt = trade.kickoff_at || null;
          const tradeCompetitionName = trade.competition_name;

          // Always advance scan cursor as we process.
          nextCursor = tradeKickoffAt;

          // Apply competition filter (table filter)
          if (competitionName && tradeCompetitionName !== competitionName) continue;

          const ev = eventByTradeId.get(trade.id) || null;
          let inferred: number | null = null;

          if (strategyKeyValue === config.strategies.eplUnder25.key) {
            const payload = ev?.payload || null;
            const layPrice = getPayloadNumber(payload, 'price');
            const greenUpRaw = payload && isRecord(payload.green_up_calc) ? payload.green_up_calc : null;
            const backMatchedPrice = getPayloadNumber(greenUpRaw, 'back_matched_price');

            if (backMatchedPrice != null && layPrice != null) {
              inferred = inferTicksBelow(backMatchedPrice, layPrice);
            } else if (isFiniteNumber(trade.back_price) && isFiniteNumber(trade.lay_price)) {
              inferred = inferTicksBelow(trade.back_price, trade.lay_price);
            }
          } else {
            const payload = ev?.payload || null;
            const entryPrice = getPayloadNumber(payload, 'entry_price');
            const targetLayPrice = getPayloadNumber(payload, 'lay_price');

            if (entryPrice != null && targetLayPrice != null) {
              inferred = inferProfitTargetPct(entryPrice, targetLayPrice);
            } else if (isFiniteNumber(trade.back_price) && isFiniteNumber(trade.lay_price)) {
              inferred = inferProfitTargetPct(trade.back_price, trade.lay_price);
            }
          }

          if (inferred == null) continue;
          if (inferred !== desiredValue) continue;

          out.push(trade);
          if (out.length >= limit) break;
        }

        // If we reached limit, we stop scanning and return a cursor that continues from where we stopped.
        if (out.length >= limit) break;

        // If fewer than pageSize rows, no more data to scan.
        if (rows.length < pageSize) {
          exhausted = true;
          nextCursor = null;
          break;
        }

        // Continue scanning older rows.
        scanCursor = rows[rows.length - 1]?.kickoff_at ?? null;
        if (!scanCursor) {
          exhausted = true;
          nextCursor = null;
          break;
        }
      }

      // If we fully exhausted scanning, no cursor.
      if (exhausted) nextCursor = null;

      return NextResponse.json({ success: true, data: out, cursor: nextCursor });
    }

    let query = supabaseAdmin
      .from('strategy_trades')
      .select('*')
      .in('strategy_key', strategyKey ? [strategyKey] : STRATEGY_KEYS)
      .order('kickoff_at', { ascending: false })
      .limit(limit);

    const idList = ids
      ? ids.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    if (idList.length > 0) {
      // Exact trade selection (used by UI “Show trades” actions).
      // Cursor pagination is not meaningful when filtering by explicit ids.
      query = query.in('id', idList);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (dateFrom) {
      query = query.gte('kickoff_at', dateFrom);
    }

    if (dateTo) {
      query = query.lte('kickoff_at', dateTo);
    }

    if (cursor && idList.length === 0) {
      query = query.lt('kickoff_at', cursor);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    // Cursor must be based on the raw query window (before enrichment + competition filtering),
    // otherwise filtered pages can incorrectly report "no more pages".
    const rawNextCursor =
      data && data.length === limit && data.length > 0
        ? data[data.length - 1]?.kickoff_at ?? null
        : null;

    // Enrich with fixture details
    let enrichedData = data;
    if (data && data.length > 0) {
      const eventIds = data.map((t) => t.betfair_event_id).filter(Boolean);
      const uniqueEventIds = Array.from(new Set(eventIds));

      if (uniqueEventIds.length > 0) {
        const { data: fixtures, error: fixtureError } = await supabaseAdmin
          .from('strategy_fixtures')
          .select('betfair_event_id, home, away, competition, strategy_key')
          .in('strategy_key', STRATEGY_KEYS)
          .in('betfair_event_id', uniqueEventIds);

        if (!fixtureError && fixtures) {
          const fixtureMap = new Map();
          fixtures.forEach((f) => fixtureMap.set(`${f.strategy_key}-${f.betfair_event_id}`, f));

          enrichedData = data.map((trade) => {
            const fixture = fixtureMap.get(`${trade.strategy_key}-${trade.betfair_event_id}`);
            const tradeCompetition = trade.competition_name;
            const isPlaceholderCompetition =
              !tradeCompetition || tradeCompetition === 'Multiple Leagues' || tradeCompetition === 'Unknown';
            const competitionName =
              (isPlaceholderCompetition ? fixture?.competition : tradeCompetition) ||
              fixture?.competition ||
              'English Premier League';
            const eventName =
              trade.event_name ||
              (fixture?.home && fixture?.away ? `${fixture.home} v ${fixture.away}` : null);

            return {
              ...trade,
              home: fixture?.home || null,
              away: fixture?.away || null,
              competition: competitionName,
              competition_name: competitionName,
              event_name: eventName,
            };
          });
        }
      }
    }

    // Filter by competition_name after enrichment (since it's enriched from fixtures)
    if (competitionName && enrichedData) {
      enrichedData = enrichedData.filter((trade) => trade.competition_name === competitionName);
    }

    const nextCursor = rawNextCursor;

    // If requesting competition names, fetch all unique competition names
    if (getCompetitionNames) {
      // Fetch unique competition names from both strategy_fixtures and strategy_trades
      const [fixturesResult, tradesResult] = await Promise.all([
        supabaseAdmin
          .from('strategy_fixtures')
          .select('competition')
          .in('strategy_key', STRATEGY_KEYS)
          .not('competition', 'is', null),
        supabaseAdmin
          .from('strategy_trades')
          .select('competition_name')
          .in('strategy_key', STRATEGY_KEYS)
          .not('competition_name', 'is', null)
      ]);

      const competitions = new Set<string>();
      if (fixturesResult.data) {
        fixturesResult.data.forEach(f => {
          if (f.competition) competitions.add(f.competition);
        });
      }
      if (tradesResult.data) {
        tradesResult.data.forEach(t => {
          if (t.competition_name) competitions.add(t.competition_name);
        });
      }

      const uniqueCompetitions = Array.from(competitions).sort();
      return NextResponse.json({ success: true, data: enrichedData, cursor: nextCursor, competitionNames: uniqueCompetitions });
    }

    return NextResponse.json({ success: true, data: enrichedData, cursor: nextCursor });
  } catch (error) {
    console.error('[api][epl-under25][trades][GET]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json(
        { success: false, error: 'Unsupported in demo mode' },
        { status: 400 },
      );
    }

    const body = await request.json();
    if (!Array.isArray(body?.ids) || body.ids.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Missing trade ids' },
        { status: 400 },
      );
    }

    const { error } = await supabaseAdmin
      .from('strategy_trades')
      .update({ status: 'cancelled', last_error: 'MANUAL_CANCEL' })
      .in('id', body.ids)
      .in('strategy_key', STRATEGY_KEYS)
      .not('status', 'in', '("hedged","completed")');

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api][epl-under25][trades][POST]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
