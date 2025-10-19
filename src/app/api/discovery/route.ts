import { NextRequest, NextResponse } from 'next/server';
import { oddsApiClient } from '@/lib/odds-api';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';
import { shouldEnableSport } from '@/lib/utils';

export async function POST(_request: NextRequest) {
  try {
    if (config.demoMode) {
      return NextResponse.json({
        success: true,
        message: 'Demo mode - discovery skipped',
        data: {
          sports: [],
          sportsEnabled: 0,
        },
      });
    }

    // Get all sports from The Odds API
    const sports = await oddsApiClient.getSports();
    console.log(`🔍 Discovery: Found ${sports.length} total sports from API`);
    
    // Filter for target sports using centralized logic
    const targetSports = sports.filter(sport => shouldEnableSport(sport.key));
    console.log(`✅ Discovery: ${targetSports.length} sports match our criteria`);
    
    let enabledCount = 0;

    // Store/update sports in database with enabled flag
    for (const sport of targetSports) {
      const { error } = await supabaseAdmin!
        .from('sports')
        .upsert({
          sport_key: sport.key,
          sport_title: sport.title,
          enabled: true, // All matched sports are enabled
        }, {
          onConflict: 'sport_key'
        });

      if (error) {
        console.error(`❌ Error upserting sport ${sport.key}:`, error);
      } else {
        enabledCount++;
        console.log(`✓ Enabled: ${sport.key} (${sport.title})`);
      }
    }

    // Disable sports that no longer match our criteria
    const targetKeys = targetSports.map(s => s.key);
    if (targetKeys.length > 0) {
      const { error: disableError } = await supabaseAdmin!
        .from('sports')
        .update({ enabled: false })
        .not('sport_key', 'in', `(${targetKeys.map(k => `'${k}'`).join(',')})`);

      if (disableError) {
        console.error('❌ Error disabling outdated sports:', disableError);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Discovery completed: ${enabledCount} sports enabled`,
      data: {
        sports: targetSports.map(s => ({ key: s.key, title: s.title })),
        sportsEnabled: enabledCount,
      },
    });

  } catch (error) {
    console.error('Discovery error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}


