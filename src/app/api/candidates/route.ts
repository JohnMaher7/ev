import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

export async function GET(request: NextRequest) {
  try {
    // If in demo mode or no Supabase connection, return sample data
    if (config.demoMode || !supabaseAdmin) {
      const sampleCandidates = [
        {
          id: 'demo-1',
          created_at: new Date().toISOString(),
          event_id: 'demo-event-1',
          sport_key: 'tennis',
          market_key: 'h2h',
          selection: 'Player A',
          alert_tier: 'SOLID',
          best_source: 'bet365',
          offered_price: 1.85,
          offered_prob: 0.5405,
          fair_price: 1.75,
          fair_prob: 0.5714,
          edge_pp: 0.0309,
          books_count: 5,
          exchanges_count: 2,
          notes: 'Demo alert - strong consensus',
          events: {
            event_id: 'demo-event-1',
            sport_key: 'tennis',
            commence_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            home: 'Player A',
            away: 'Player B'
          }
        },
        {
          id: 'demo-2',
          created_at: new Date().toISOString(),
          event_id: 'demo-event-2',
          sport_key: 'soccer',
          market_key: 'h2h',
          selection: 'Home Win',
          alert_tier: 'SCOUT',
          best_source: 'williamhill',
          offered_price: 2.10,
          offered_prob: 0.4762,
          fair_price: 2.00,
          fair_prob: 0.5000,
          edge_pp: 0.0238,
          books_count: 3,
          exchanges_count: 1,
          notes: 'Demo alert - early line',
          events: {
            event_id: 'demo-event-2',
            sport_key: 'soccer',
            commence_time: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
            home: 'Team A',
            away: 'Team B'
          }
        }
      ];

      return NextResponse.json({
        success: true,
        data: sampleCandidates,
      });
    }

    const { searchParams } = new URL(request.url);
    const alert_tier = searchParams.get('alert_tier');
    const min_edge = searchParams.get('min_edge');
    const limit = parseInt(searchParams.get('limit') || '100');

    let query = supabaseAdmin
      .from('candidates')
      .select(`
        *,
        events!inner(
          event_id,
          sport_key,
          commence_time,
          home,
          away
        )
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (alert_tier) {
      query = query.eq('alert_tier', alert_tier);
    }

    if (min_edge) {
      query = query.gte('edge_pp', parseFloat(min_edge));
    }

    const { data: candidates, error } = await query;

    if (error) {
      throw new Error(`Error fetching candidates: ${error.message}`);
    }

    // Enhance candidates with all bookmaker prices
    const enhancedCandidates = await Promise.all(
      candidates.map(async (candidate) => {
        // Get all odds snapshots for this event, market, and selection
        const { data: snapshots, error: snapshotsError } = await supabaseAdmin!
          .from('odds_snapshots')
          .select('bookmaker, decimal_odds, is_exchange, selection')
          .eq('event_id', candidate.event_id)
          .eq('market_key', candidate.market_key.replace(/ \(line: \d+\.?\d*\)/, '')) // Remove line info for lookup
          .eq('selection', candidate.selection);

        if (snapshotsError) {
          console.error(`Error fetching snapshots for candidate ${candidate.id}:`, snapshotsError);
          return candidate;
        }

        // Group by bookmaker and find best price
        const bookmakerPrices = snapshots.reduce((acc: Record<string, { bookmaker: string; price: number; isExchange: boolean }>, snapshot) => {
          if (!acc[snapshot.bookmaker]) {
            acc[snapshot.bookmaker] = {
              bookmaker: snapshot.bookmaker,
              price: snapshot.decimal_odds,
              isExchange: snapshot.is_exchange,
            };
          } else if (snapshot.decimal_odds > acc[snapshot.bookmaker].price) {
            // For back betting, higher odds are better
            acc[snapshot.bookmaker].price = snapshot.decimal_odds;
          }
          return acc;
        }, {});

        return {
          ...candidate,
          allBookmakerPrices: Object.values(bookmakerPrices),
        };
      })
    );

    return NextResponse.json({
      success: true,
      data: enhancedCandidates,
    });

  } catch (error) {
    console.error('Error fetching candidates:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
