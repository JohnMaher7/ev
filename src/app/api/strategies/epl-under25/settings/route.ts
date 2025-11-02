import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

const STRATEGY_KEY = config.strategies.eplUnder25.key;

function demoSettings() {
  return {
    strategy_key: STRATEGY_KEY,
    enabled: config.strategies.eplUnder25.enabled,
    default_stake: config.strategies.eplUnder25.defaultStake,
    min_back_price: config.strategies.eplUnder25.minBackPrice,
    lay_target_price: config.strategies.eplUnder25.layTargetPrice,
    back_lead_minutes: config.strategies.eplUnder25.backLeadMinutes,
    fixture_lookahead_days: config.strategies.eplUnder25.fixtureLookaheadDays,
    commission_rate: config.strategies.eplUnder25.commissionRate,
    extra: {},
  };
}

export async function GET() {
  try {
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({ success: true, data: demoSettings() });
    }

    const { data, error } = await supabaseAdmin
      .from('strategy_settings')
      .select('*')
      .eq('strategy_key', STRATEGY_KEY)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw new Error(error.message);
    }

    if (!data) {
      const defaults = demoSettings();
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('strategy_settings')
        .insert({ ...defaults, enabled: false })
        .select()
        .single();
      if (insertErr) throw new Error(insertErr.message);
      return NextResponse.json({ success: true, data: inserted });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('[api][epl-under25][settings][GET]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({ success: false, error: 'Unsupported in demo mode' }, { status: 400 });
    }

    const body = await request.json();
    const payload: Record<string, unknown> = {};

    const updatableFields: Array<keyof typeof body> = [
      'enabled',
      'default_stake',
      'min_back_price',
      'lay_target_price',
      'back_lead_minutes',
      'fixture_lookahead_days',
      'commission_rate',
      'extra',
    ];

    for (const field of updatableFields) {
      if (body[field] !== undefined) {
        payload[field] = body[field];
      }
    }

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ success: false, error: 'No valid fields supplied' }, { status: 400 });
    }

    payload.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('strategy_settings')
      .upsert({ strategy_key: STRATEGY_KEY, ...payload })
      .select()
      .single();

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('[api][epl-under25][settings][PATCH]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

