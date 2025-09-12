import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

export async function GET(request: NextRequest) {
  try {
    // If in demo mode or no Supabase connection, return sample data
    if (config.demoMode || !supabaseAdmin) {
      const sampleSummary = {
        totalStaked: 150.00,
        totalPnl: 27.50,
        totalBets: 2,
        winRate: 50.0,
        expectedValue: 15.25,
        actualMargin: 18.33,
        expectedMargin: 10.17,
        clvBps: 25,
        pendingBets: 1,
      };

      const sampleDailyMetrics = [
        {
          id: 'demo-metric-1',
          date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          staked: 25.00,
          pnl: 27.50,
          expected_value: 12.50,
          actual_margin: 110.0,
          expected_margin: 50.0,
          clv_bps: 25,
          win_rate: 100.0,
          num_bets: 1,
          num_bets_scout: 0,
          num_bets_solid: 1,
          num_bets_exchange: 0,
          created_at: new Date().toISOString(),
        },
        {
          id: 'demo-metric-2',
          date: new Date().toISOString().split('T')[0],
          staked: 50.00,
          pnl: 0,
          expected_value: 2.75,
          actual_margin: 0,
          expected_margin: 5.5,
          clv_bps: 0,
          win_rate: 0,
          num_bets: 1,
          num_bets_scout: 0,
          num_bets_solid: 1,
          num_bets_exchange: 0,
          created_at: new Date().toISOString(),
        }
      ];

      return NextResponse.json({
        success: true,
        data: {
          summary: sampleSummary,
          dailyMetrics: sampleDailyMetrics,
        },
      });
    }

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');

    // Get daily metrics
    const { data: dailyMetrics, error: metricsError } = await supabaseAdmin
      .from('metrics_daily')
      .select('*')
      .gte('date', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('date', { ascending: true });

    if (metricsError) {
      throw new Error(`Error fetching daily metrics: ${metricsError.message}`);
    }

    // Get current bet statistics
    const { data: betStats, error: betStatsError } = await supabaseAdmin
      .from('bets')
      .select('status, stake, pnl, created_at');

    if (betStatsError) {
      throw new Error(`Error fetching bet stats: ${betStatsError.message}`);
    }

    // Calculate aggregate metrics
    const totalStaked = betStats?.reduce((sum, bet) => sum + (bet.stake || 0), 0) || 0;
    const totalPnl = betStats?.reduce((sum, bet) => sum + (bet.pnl || 0), 0) || 0;
    const totalBets = betStats?.length || 0;
    const wonBets = betStats?.filter(bet => bet.status === 'won').length || 0;
    const winRate = totalBets > 0 ? wonBets / totalBets : 0;

    // Calculate expected value from pending bets
    const { data: pendingBets, error: pendingError } = await supabaseAdmin
      .from('bets')
      .select('stake, accepted_fair_prob, odds')
      .eq('status', 'pending');

    if (pendingError) {
      throw new Error(`Error fetching pending bets: ${pendingError.message}`);
    }

    const expectedValue = pendingBets?.reduce((sum, bet) => {
      const expectedReturn = bet.stake * bet.accepted_fair_prob * bet.odds;
      const expectedLoss = bet.stake * (1 - bet.accepted_fair_prob);
      return sum + (expectedReturn - expectedLoss);
    }, 0) || 0;

    // Calculate actual margin
    const actualMargin = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0;

    // Calculate expected margin
    const expectedMargin = totalStaked > 0 ? (expectedValue / totalStaked) * 100 : 0;

    // Calculate CLV (simplified - would need closing consensus data)
    const clvBps = 0; // Placeholder - would need closing consensus implementation

    const summary = {
      totalStaked,
      totalPnl,
      totalBets,
      winRate: winRate * 100,
      expectedValue,
      actualMargin,
      expectedMargin,
      clvBps,
      pendingBets: pendingBets?.length || 0,
    };

    return NextResponse.json({
      success: true,
      data: {
        summary,
        dailyMetrics: dailyMetrics || [],
      },
    });

  } catch (error) {
    console.error('Error fetching metrics:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
