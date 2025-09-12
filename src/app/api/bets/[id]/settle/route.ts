import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Database not configured' 
        },
        { status: 500 }
      );
    }

    const { id } = await params;
    const body = await request.json();
    const { status, returns, pnl } = body;

    // Validate status
    if (!['won', 'lost', 'void'].includes(status)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Invalid status. Must be won, lost, or void' 
        },
        { status: 400 }
      );
    }

    // Calculate returns and PnL if not provided
    let calculatedReturns = returns;
    let calculatedPnl = pnl;

    if (status === 'won' && returns === undefined) {
      // Get the bet to calculate returns
      const { data: bet, error: fetchError } = await supabaseAdmin
        .from('bets')
        .select('stake, odds')
        .eq('id', id)
        .single();

      if (fetchError) {
        throw new Error(`Error fetching bet: ${fetchError.message}`);
      }

      calculatedReturns = bet.stake * bet.odds;
      calculatedPnl = calculatedReturns - bet.stake;
    } else if (status === 'lost') {
      calculatedReturns = 0;
      calculatedPnl = -1; // Will be updated with actual stake
    } else if (status === 'void') {
      calculatedReturns = 0;
      calculatedPnl = 0;
    }

    // If PnL not provided, calculate it
    if (calculatedPnl === undefined) {
      const { data: bet, error: fetchError } = await supabaseAdmin
        .from('bets')
        .select('stake')
        .eq('id', id)
        .single();

      if (fetchError) {
        throw new Error(`Error fetching bet: ${fetchError.message}`);
      }

      calculatedPnl = (calculatedReturns || 0) - bet.stake;
    }

    const { data, error } = await supabaseAdmin
      .from('bets')
      .update({
        status,
        settled_at: new Date().toISOString(),
        returns: calculatedReturns,
        pnl: calculatedPnl,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Error settling bet: ${error.message}`);
    }

    return NextResponse.json({
      success: true,
      data,
    });

  } catch (error) {
    console.error('Error settling bet:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
