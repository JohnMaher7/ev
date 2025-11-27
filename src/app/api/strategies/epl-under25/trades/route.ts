import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

// Support both strategies
const STRATEGY_KEYS = [
  config.strategies.eplUnder25.key,
  config.strategies.eplUnder25GoalReact.key,
];

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
    const competitionName = searchParams.get('competition_name');
    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');
    const cursor = searchParams.get('cursor');
    // Increase limit when no filters are applied (to show all trades)
    const hasFilters = !!(status || strategyKey || competitionName || dateFrom || dateTo);
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

    let query = supabaseAdmin
      .from('strategy_trades')
      .select('*')
      .in('strategy_key', strategyKey ? [strategyKey] : STRATEGY_KEYS)
      .order('kickoff_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    if (dateFrom) {
      query = query.gte('kickoff_at', dateFrom);
    }

    if (dateTo) {
      query = query.lte('kickoff_at', dateTo);
    }

    if (cursor) {
      query = query.lt('kickoff_at', cursor);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

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
            const competitionName = trade.competition_name || fixture?.competition || 'English Premier League';
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

    // For descending order, cursor should be the last item's kickoff_at
    const nextCursor = enrichedData && enrichedData.length === limit && enrichedData.length > 0 
      ? enrichedData[enrichedData.length - 1]?.kickoff_at ?? null 
      : null;

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
