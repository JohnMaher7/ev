import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET() {
  const health: {
    oddsApi: {
      configured: boolean;
      keyPreview: string;
    };
    supabase: {
      configured: boolean;
      url: string;
      serviceKeyPreview: string;
      canQuery?: boolean;
      queryError?: string;
      sampleData?: number;
    };
    demoMode: boolean;
  } = {
    oddsApi: {
      configured: !!config.oddsApiKey && config.oddsApiKey.length > 0,
      keyPreview: config.oddsApiKey ? `***${config.oddsApiKey.slice(-4)}` : 'MISSING',
    },
    supabase: {
      configured: !!supabaseAdmin,
      url: config.supabaseUrl || 'MISSING',
      serviceKeyPreview: config.supabaseServiceRoleKey ? `***${config.supabaseServiceRoleKey.slice(-4)}` : 'MISSING',
    },
    demoMode: config.demoMode,
  };

  // Try to actually query database
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.from('sports').select('sport_key').limit(1);
      health.supabase.canQuery = !error;
      health.supabase.queryError = error?.message;
      health.supabase.sampleData = data?.length || 0;
    } catch (e) {
      health.supabase.canQuery = false;
      health.supabase.queryError = e instanceof Error ? e.message : 'Unknown error';
    }
  }

  return NextResponse.json({ success: true, data: health });
}



