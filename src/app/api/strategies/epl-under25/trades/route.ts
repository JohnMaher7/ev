import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

const STRATEGY_KEY = config.strategies.eplUnder25.key;

function demoTrades() {
  const now = Date.now();
  return [
    {
      id: 'demo-trade-1',
      strategy_key: STRATEGY_KEY,
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
      strategy_key: STRATEGY_KEY,
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
  ];
}

export async function GET(request: NextRequest) {
  try {
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({ success: true, data: demoTrades(), cursor: null });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const cursor = searchParams.get('cursor');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    let query = supabaseAdmin
      .from('strategy_trades')
      .select('*')
      .eq('strategy_key', STRATEGY_KEY)
      .order('kickoff_at', { ascending: true })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    if (cursor) {
      query = query.gt('kickoff_at', cursor);
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
          .select('betfair_event_id, home, away, competition')
          .eq('strategy_key', STRATEGY_KEY)
          .in('betfair_event_id', uniqueEventIds);

        if (!fixtureError && fixtures) {
          const fixtureMap = new Map();
          fixtures.forEach((f) => fixtureMap.set(f.betfair_event_id, f));

          enrichedData = data.map((trade) => {
            const fixture = fixtureMap.get(trade.betfair_event_id);
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

    const nextCursor = data && data.length === limit ? data[data.length - 1]?.kickoff_at ?? null : null;

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
      .eq('strategy_key', STRATEGY_KEY)
      .neq('status', 'hedged');

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
