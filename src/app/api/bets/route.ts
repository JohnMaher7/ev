import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';
import { v4 as uuidv4 } from 'uuid';

export async function GET(request: NextRequest) {
  try {
    // If in demo mode or no Supabase connection, return sample data
    if (config.demoMode || !supabaseAdmin) {
      const sampleBets = [
        {
          id: 'demo-bet-1',
          created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          event_id: 'demo-event-1',
          sport_key: 'tennis',
          market_key: 'h2h',
          selection: 'Player A',
          source: 'bet365',
          odds: 1.85,
          stake: 50.00,
          accepted_fair_prob: 0.5714,
          accepted_fair_price: 1.75,
          status: 'pending',
          settled_at: null,
          returns: null,
          pnl: null,
          events: {
            event_id: 'demo-event-1',
            sport_key: 'tennis',
            commence_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            home: 'Player A',
            away: 'Player B'
          }
        },
        {
          id: 'demo-bet-2',
          created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          event_id: 'demo-event-3',
          sport_key: 'soccer',
          market_key: 'h2h',
          selection: 'Home Win',
          source: 'williamhill',
          odds: 2.10,
          stake: 25.00,
          accepted_fair_prob: 0.5000,
          accepted_fair_price: 2.00,
          status: 'won',
          settled_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          returns: 52.50,
          pnl: 27.50,
          events: {
            event_id: 'demo-event-3',
            sport_key: 'soccer',
            commence_time: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
            home: 'Team A',
            away: 'Team B'
          }
        }
      ];

      return NextResponse.json({
        success: true,
        data: sampleBets,
      });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50');

    let query = supabaseAdmin
      .from('bets')
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

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data: bets, error } = await query;

    if (error) {
      throw new Error(`Error fetching bets: ${error.message}`);
    }

    return NextResponse.json({
      success: true,
      data: bets,
    });

  } catch (error) {
    console.error('Error fetching bets:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      event_id,
      sport_key,
      market_key,
      selection,
      source,
      odds,
      stake,
      accepted_fair_prob,
      accepted_fair_price,
    } = body;

    // Validate required fields
    if (!event_id || !sport_key || !market_key || !selection || !source || !odds || !stake || !accepted_fair_prob || !accepted_fair_price) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Missing required fields' 
        },
        { status: 400 }
      );
    }

    const bet = {
      id: uuidv4(),
      event_id,
      sport_key,
      market_key,
      selection,
      source,
      odds: parseFloat(odds),
      stake: parseFloat(stake),
      accepted_fair_prob: parseFloat(accepted_fair_prob),
      accepted_fair_price: parseFloat(accepted_fair_price),
      status: 'pending' as const,
    };

    // If in demo mode or no Supabase connection, return the bet without saving
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({
        success: true,
        data: bet,
        message: 'Demo mode: bet logged but not saved to database'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('bets')
      .insert(bet)
      .select()
      .single();

    if (error) {
      throw new Error(`Error creating bet: ${error.message}`);
    }

    return NextResponse.json({
      success: true,
      data,
    });

  } catch (error) {
    console.error('Error creating bet:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
