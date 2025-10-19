import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(_request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json({
        success: false,
        error: 'Supabase not configured'
      }, { status: 500 });
    }

    // Check recent snapshots
    const { data: snapshots, error: snapshotsError } = await supabaseAdmin
      .from('odds_snapshots')
      .select('*')
      .order('taken_at', { ascending: false })
      .limit(10);

    if (snapshotsError) {
      throw new Error(`Error fetching snapshots: ${snapshotsError.message}`);
    }

    // Check recent events
    const { data: events, error: eventsError } = await supabaseAdmin
      .from('events')
      .select('*')
      .order('commence_time', { ascending: false })
      .limit(5);

    if (eventsError) {
      throw new Error(`Error fetching events: ${eventsError.message}`);
    }

    // Check candidates
    const { data: candidates, error: candidatesError } = await supabaseAdmin
      .from('candidates')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    if (candidatesError) {
      throw new Error(`Error fetching candidates: ${candidatesError.message}`);
    }

    // Check for totals markets specifically
    const totalsSnapshots = snapshots?.filter(s => s.market_key === 'totals') || [];

    return NextResponse.json({
      success: true,
      data: {
        snapshots: {
          total: snapshots?.length || 0,
          recent: snapshots?.slice(0, 5).map(s => ({
            market: s.market_key,
            selection: s.selection,
            odds: s.decimal_odds,
            point: s.point,
            bookmaker: s.bookmaker,
            taken_at: s.taken_at
          })) || []
        },
        totals: {
          count: totalsSnapshots.length,
          samples: totalsSnapshots.slice(0, 3).map(s => ({
            selection: s.selection,
            odds: s.decimal_odds,
            point: s.point,
            bookmaker: s.bookmaker
          }))
        },
        events: {
          total: events?.length || 0,
          recent: events?.map(e => ({
            home: e.home,
            away: e.away,
            sport: e.sport_key,
            commence_time: e.commence_time
          })) || []
        },
        candidates: {
          total: candidates?.length || 0,
          recent: candidates?.map(c => ({
            tier: c.alert_tier,
            selection: c.selection,
            offered_price: c.offered_price,
            edge_pp: c.edge_pp,
            created_at: c.created_at
          })) || []
        }
      }
    });

  } catch (error) {
    console.error('Debug data error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
