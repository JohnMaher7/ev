import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

export async function GET(
  { params }: { params: { id: string } }
) {
  try {
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({ success: true, data: [] });
    }

    const { id } = params;
    const { data, error } = await supabaseAdmin
      .from('strategy_trade_events')
      .select('*')
      .eq('trade_id', id)
      .order('occurred_at', { ascending: true });

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('[api][epl-under25][trade-events][GET]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

