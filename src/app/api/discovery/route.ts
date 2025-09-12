import { NextRequest, NextResponse } from 'next/server';
import { oddsApiClient, convertOddsApiToSnapshots, convertOddsApiToEvents } from '@/lib/odds-api';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

export async function POST(request: NextRequest) {
  try {
    if (config.demoMode) {
      return NextResponse.json({
        success: true,
        message: 'Demo mode - discovery skipped',
        data: {
          sports: [],
          events: [],
          snapshots: [],
        },
      });
    }

    // Get all sports from The Odds API
    const sports = await oddsApiClient.getSports();
    
    // Filter for tennis and soccer
    const targetSports = sports.filter(sport => 
      sport.key === 'tennis' || 
      sport.key.startsWith('soccer_')
    );

    // Store/update sports in database
    for (const sport of targetSports) {
      const { error } = await supabaseAdmin!
        .from('sports')
        .upsert({
          sport_key: sport.key,
          sport_title: sport.title,
          enabled: sport.key === 'tennis' || 
                   sport.key === 'tennis_atp_us_open' || 
                   sport.key === 'tennis_wta_us_open' ||
                   sport.key === 'soccer_england_league1' ||
                   sport.key === 'soccer_england_league2' ||
                   sport.key === 'soccer_efl_champ' ||
                   sport.key === 'soccer_league_of_ireland' ||
                   sport.key === 'soccer_denmark_superliga' ||
                   sport.key === 'soccer_norway_eliteserien' ||
                   sport.key === 'soccer_sweden_allsvenskan', // Enable tennis tournaments and low-grade soccer leagues
        }, {
          onConflict: 'sport_key'
        });

      if (error) {
        console.error(`Error upserting sport ${sport.key}:`, error);
      }
    }

    // Get events for enabled sports
    const allEvents: any[] = [];
    const allSnapshots: any[] = [];

    for (const sport of targetSports) {
      if (sport.key === 'tennis') {
        try {
          const events = await oddsApiClient.getTennisOdds();
          allEvents.push(...events);
          
          // Convert to snapshots
          const snapshots = convertOddsApiToSnapshots(events);
          allSnapshots.push(...snapshots);
        } catch (error) {
          console.error('Error fetching tennis odds:', error);
        }
      } else if (sport.key === 'soccer_epl') {
        try {
          const events = await oddsApiClient.getSoccerOdds();
          allEvents.push(...events);
          
          // Convert to snapshots
          const snapshots = convertOddsApiToSnapshots(events);
          allSnapshots.push(...snapshots);
        } catch (error) {
          console.error('Error fetching soccer odds:', error);
        }
      }
    }

    // Store events in database
    if (allEvents.length > 0) {
      const eventsToStore = convertOddsApiToEvents(allEvents);
      
      for (const event of eventsToStore) {
        const { error } = await supabaseAdmin!
          .from('events')
          .upsert(event, {
            onConflict: 'event_id'
          });

        if (error) {
          console.error(`Error upserting event ${event.event_id}:`, error);
        }
      }
    }

    // Store snapshots in database
    if (allSnapshots.length > 0) {
      const { error } = await supabaseAdmin!
        .from('odds_snapshots')
        .insert(allSnapshots);

      if (error) {
        console.error('Error inserting snapshots:', error);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Discovery completed successfully',
      data: {
        sports: targetSports,
        events: allEvents.length,
        snapshots: allSnapshots.length,
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


