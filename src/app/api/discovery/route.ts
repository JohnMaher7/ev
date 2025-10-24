import { NextRequest, NextResponse } from 'next/server';
import { oddsApiClient } from '@/lib/odds-api';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';
import { shouldEnableSport } from '@/lib/utils';

export async function POST(_request: NextRequest) {
  try {
    console.log('🔍 Discovery: Starting sports discovery...');

    if (config.demoMode) {
      console.log('⏭️ Discovery: Demo mode enabled - skipping operations');
      return NextResponse.json({
        success: true,
        message: 'Demo mode is enabled. Discovery skipped.',
        data: {
          sports: [],
          sportsEnabled: 0,
        },
      });
    }

    // Check if Supabase is available
    if (!supabaseAdmin) {
      console.error('❌ Discovery: Supabase not configured');
      return NextResponse.json({
        success: false,
        error: 'Database not configured - please add SUPABASE_SERVICE_ROLE_KEY to your environment variables',
      }, { status: 500 });
    }

    // Check if Odds API is configured
    if (!oddsApiClient) {
      console.error('❌ Discovery: Odds API not configured');
      return NextResponse.json({
        success: false,
        error: 'Odds API not configured - please add ODDS_API_KEY to your environment variables',
      }, { status: 500 });
    }

    // Get all sports from The Odds API
    console.log('🔍 Discovery: Fetching sports from The Odds API...');
    const sports = await oddsApiClient.getSports();
    console.log(`🔍 Discovery: Found ${sports.length} total sports from API`);
    
    // Filter for target sports using centralized logic
    const targetSports = sports.filter(sport => shouldEnableSport(sport.key));
    console.log(`✅ Discovery: ${targetSports.length} sports match our criteria`);
    
    let enabledCount = 0;
    let failedCount = 0;

    // Store/update sports in database with enabled flag
    console.log(`🔍 Discovery: Upserting ${targetSports.length} sports to database...`);
    for (const sport of targetSports) {
      const { error } = await supabaseAdmin
        .from('sports')
        .upsert({
          sport_key: sport.key,
          sport_title: sport.title,
          enabled: true, // All matched sports are enabled
        }, {
          onConflict: 'sport_key'
        });

      if (error) {
        failedCount++;
        console.error(`❌ Error upserting sport ${sport.key}:`, error.message, error.details);
      } else {
        enabledCount++;
        console.log(`✓ Enabled: ${sport.key} (${sport.title})`);
      }
    }

    console.log(`✅ Discovery: ${enabledCount} enabled, ${failedCount} failed`);

    // Disable sports that no longer match our criteria
    const targetKeys = targetSports.map(s => s.key);
    if (targetKeys.length > 0) {
      console.log(`🔍 Discovery: Disabling sports that no longer match criteria...`);
      const exclusionList = `(${targetKeys.map(k => `"${k}"`).join(',')})`;
      const { error: disableError } = await supabaseAdmin
        .from('sports')
        .update({ enabled: false })
        .not('sport_key', 'in', exclusionList);

      if (disableError) {
        console.error('❌ Error disabling outdated sports:', disableError);
      }
    }

    // Return error if none succeeded
    if (enabledCount === 0 && targetSports.length > 0) {
      console.error(`❌ Discovery: Failed to enable any sports (${failedCount} errors)`);
      return NextResponse.json({
        success: false,
        error: `Failed to enable any sports. Database errors occurred. Check logs for details.`,
      }, { status: 500 });
    }

    console.log(`✅ Discovery: Complete! ${enabledCount} sports enabled`);

    return NextResponse.json({
      success: true,
      message: `Discovery completed: ${enabledCount} of ${targetSports.length} sports enabled successfully. You can now run Poll to fetch odds.`,
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


