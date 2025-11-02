import { NextRequest, NextResponse } from 'next/server';
import { oddsApiClient, convertOddsApiToSnapshots, convertOddsApiToEvents, type OddsApiEvent } from '@/lib/odds-api';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';
import { groupSnapshotsIntoMarkets, generateAlertCandidates } from '@/lib/odds-engine';
import { type AlertCandidate } from '@/lib/alerts';
import { placeBetOnBetfair } from '@/lib/betting/betfair';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const logger = new Logger('poll');
  const startTime = performance.now();
  
  try {
    logger.section('POLL CYCLE STARTED');

    if (config.demoMode) {
      logger.info('Demo mode enabled - skipping operations');
      return NextResponse.json({
        success: true,
        message: 'Demo mode is enabled. Polling skipped.',
        data: {
          events: 0,
          snapshots: 0,
          candidates: 0,
        },
      });
    }

    // Check if Supabase is available
    if (!supabaseAdmin) {
      logger.error('Supabase not configured');
      return NextResponse.json({
        success: false,
        error: 'Supabase not configured - please add SUPABASE_SERVICE_ROLE_KEY to your environment variables',
      }, { status: 500 });
    }

    // Check if Odds API is configured
    if (!oddsApiClient) {
      logger.error('Odds API not configured');
      return NextResponse.json({
        success: false,
        error: 'Odds API not configured - please add ODDS_API_KEY to your environment variables',
      }, { status: 500 });
    }

    // Get enabled sports
    const { data: enabledSports, error: sportsError } = await supabaseAdmin
      .from('sports')
      .select('sport_key')
      .eq('enabled', true);

    if (sportsError) {
      logger.error('Error fetching sports', { error: sportsError.message });
      throw new Error(`Error fetching enabled sports: ${sportsError.message}`);
    }

    if (!enabledSports || enabledSports.length === 0) {
      logger.info('No enabled sports found in database');
      return NextResponse.json({
        success: true,
        message: 'No enabled sports found. Run Discovery first to set up sports.',
        data: {
          events: 0,
          snapshots: 0,
          candidates: 0,
        },
      });
    }

    logger.info(`Processing ${enabledSports.length} enabled sports`);

    const allEvents: OddsApiEvent[] = [];
    const allSnapshots: ReturnType<typeof convertOddsApiToSnapshots> = [];
    const allCandidates: AlertCandidate[] = [];
    let apiCallsSaved = 0;
    let eventsSkipped = 0;
    const skipReasons = {
      alreadyStarted: 0,
      recentlyPolled: 0,
    };

    // Poll each enabled sport with smart filtering
    for (const sport of enabledSports) {
      try {
        logger.section(`Sport: ${sport.sport_key}`, '🎯');
        
        // Use generic getOdds method with bookmaker allowlist for all sports
        const fetchTimer = logger.time(`Fetching ${sport.sport_key}`);
        const events = await oddsApiClient.getOddsWithAllowlist(sport.sport_key);
        fetchTimer();
        
        logger.info(`API returned ${events.length} events`);

        if (events.length === 0) {
          continue;
        }

        // Smart filtering: Skip events that don't need polling
        const now = new Date();
        const minPollInterval = 30 * 60 * 1000; // 30 minutes
        
        const filteredEvents = [];
        
        for (const event of events) {
          const commenceTime = new Date(event.commence_time);
          const timeUntilEvent = commenceTime.getTime() - now.getTime();
          
          // Skip if event has already started
          if (timeUntilEvent < 0) {
            eventsSkipped++;
            skipReasons.alreadyStarted++;
            continue;
          }
          
          // Check if this event was recently polled
          const { data: existingEvent } = await supabaseAdmin
            .from('events')
            .select('last_polled_at')
            .eq('event_id', event.id)
            .single();
          
          if (existingEvent?.last_polled_at) {
            const lastPolled = new Date(existingEvent.last_polled_at);
            const timeSinceLastPoll = now.getTime() - lastPolled.getTime();
            
            // Skip if polled within last 30 minutes
            if (timeSinceLastPoll < minPollInterval) {
              eventsSkipped++;
              skipReasons.recentlyPolled++;
              apiCallsSaved++;
              continue;
            }
          }
          
          filteredEvents.push(event);
        }
        
        logger.summary({
          events_to_poll: filteredEvents.length,
          events_skipped: eventsSkipped,
          already_started: skipReasons.alreadyStarted,
          recently_polled: skipReasons.recentlyPolled,
        });
        
        if (filteredEvents.length === 0) {
          continue;
        }

        // Process only filtered events
        allEvents.push(...filteredEvents);

        // Store events with updated last_polled_at timestamp
        const eventsToStore = convertOddsApiToEvents(filteredEvents);
        for (const event of eventsToStore) {
          const { error: eventError } = await supabaseAdmin
            .from('events')
            .upsert({
              ...event,
              last_polled_at: new Date().toISOString(),
            }, {
              onConflict: 'event_id'
            });

          if (eventError) {
            logger.error(`Error upserting event ${event.event_id}`, { error: eventError });
          }
        }

        // Convert to snapshots
        const snapshots = convertOddsApiToSnapshots(filteredEvents);
        allSnapshots.push(...snapshots);

        // Store snapshots
        if (snapshots.length > 0) {
          const { error: snapshotsError } = await supabaseAdmin
            .from('odds_snapshots')
            .insert(snapshots);

          if (snapshotsError) {
            logger.error(`Error inserting snapshots for ${sport.sport_key}`, { error: snapshotsError });
          }
        }

        // Process for alerts - collect all diagnostics
        const marketData = groupSnapshotsIntoMarkets(snapshots);
        const allDiagnostics: ReturnType<typeof generateAlertCandidates>["diagnostics"] = [];
        const sportCandidates: AlertCandidate[] = [];
        
        for (const market of marketData) {
          // Process market silently without logging each market name
          const result = generateAlertCandidates(market, sport.sport_key);
          
          // Collect diagnostics and candidates
          allDiagnostics.push(...result.diagnostics);
          sportCandidates.push(...result.candidates);
          
          if (result.candidates.length > 0) {
            // Add IDs to candidates
            const candidatesWithIds = result.candidates.map(candidate => ({
              ...candidate,
              id: uuidv4(),
            }));
            
            allCandidates.push(...candidatesWithIds);

            // Store candidates
            const { error: candidatesError } = await supabaseAdmin
              .from('candidates')
              .insert(candidatesWithIds);

            if (candidatesError) {
              logger.error(`Error inserting candidates for ${sport.sport_key}`, { error: candidatesError });
            }

            // Auto-bet strategy
            const autoBetEnabled = config.autoBet.enabled;
            if (autoBetEnabled) {
              for (const c of candidatesWithIds) {
                try {
                  const attemptPlace = async (odds: number) => {
                    // Dedupe: avoid placing multiple bets on same event/market/selection within last hour
                    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
                    const { data: existingBets, error: betsErr } = await supabaseAdmin!
                      .from('bets')
                      .select('id, created_at')
                      .eq('event_id', c.event_id)
                      .eq('market_key', c.market_key)
                      .eq('selection', c.selection)
                      .eq('source', config.autoBet.exchangeKey)
                      .gte('created_at', oneHourAgo)
                      .limit(1);
                    if (betsErr) {
                      logger.warn('AutoBet dedupe check error', { error: betsErr.message });
                    }
                    if (existingBets && existingBets.length > 0) {
                      logger.debug(() => `Skipping autobet (recent bet exists) for ${c.selection} @ ${odds}`);
                      return;
                    }

                    // Stake sizing
                    const bankroll = config.autoBet.bankroll;
                    const kellyFraction = 0.25; // reuse from solid cap philosophy
                    const p = c.fair_prob;
                    const b = odds - 1;
                    const kelly = Math.max(0, b > 0 ? (p * (b + 1) - 1) / b : 0);
                    const stakeFraction = Math.min(kelly * kellyFraction, config.stakeLimits.solid.bankCap);
                    const stake = Math.max(config.autoBet.minStake, Math.round(bankroll * stakeFraction * 100) / 100);

                    const res = await placeBetOnBetfair({
                      eventId: c.event_id,
                      sportKey: c.sport_key,
                      marketKey: c.market_key,
                      selection: c.selection,
                      odds,
                      stake,
                      acceptedFairProb: c.fair_prob,
                      acceptedFairPrice: c.fair_price,
                    });
                    if (res.ok) {
                      logger.info(`AutoBet placed on ${c.selection}`, { 
                        odds, 
                        stake, 
                        betId: res.betId 
                      });
                    } else {
                      logger.warn(`AutoBet failed for ${c.selection}`, { 
                        reason: res.reason 
                      });
                    }
                  };

                  if (c.edge_pp >= config.autoBet.minEdge && c.best_source === config.autoBet.exchangeKey) {
                    logger.debug(() => `AutoBet (candidate source=betfair): edge=${c.edge_pp.toFixed(6)} >= ${config.autoBet.minEdge}`);
                    await attemptPlace(c.offered_price);
                    continue;
                  }

                  // If candidate is not betfair_ex_uk, try to fetch recent betfair odds for same selection
                  if (c.edge_pp >= config.autoBet.minEdge && c.best_source !== config.autoBet.exchangeKey) {
                    const mkMatch = c.market_key.match(/^(.*?)(?: \(line: ([0-9.]+)\))?$/);
                    const baseMarket = mkMatch ? mkMatch[1] : c.market_key;
                    const linePoint = mkMatch && mkMatch[2] ? parseFloat(mkMatch[2]) : null;

                    const { data: snaps, error: snapsErr } = await supabaseAdmin!
                      .from('odds_snapshots')
                      .select('decimal_odds, point')
                      .eq('event_id', c.event_id)
                      .eq('market_key', baseMarket)
                      .eq('selection', c.selection)
                      .eq('bookmaker', config.autoBet.exchangeKey)
                      .eq('is_exchange', true)
                      .order('taken_at', { ascending: false })
                      .limit(10);
                    if (snapsErr) {
                      logger.warn('AutoBet snapshots fetch error', { error: snapsErr.message });
                    } else if (snaps && snaps.length > 0) {
                      const filtered = linePoint == null ? snaps : snaps.filter(s => s.point === linePoint);
                      const best = filtered.sort((a, b) => (b.decimal_odds as number) - (a.decimal_odds as number))[0];
                      if (best && (best.decimal_odds as number) > 1) {
                        const betfairOdds = best.decimal_odds as number;
                        const implied = 1 / betfairOdds;
                        const edge = c.fair_prob - implied;
                        logger.debug(() => `AutoBet (snap betfair): price=${betfairOdds} edge=${edge.toFixed(6)} threshold=${config.autoBet.minEdge}`);
                        if (edge >= config.autoBet.minEdge) {
                          await attemptPlace(betfairOdds);
                        } else {
                          logger.debug(() => 'Skipping autobet (betfair edge below threshold)');
                        }
                      } else {
                        logger.debug(() => 'Skipping autobet (no recent betfair odds found)');
                      }
                    }
                  }
                } catch (error) {
                  logger.error('AutoBet error', {
                    error,
                    requestId: request.headers.get('x-request-id') ?? undefined,
                  });
                }
              }
            }
          }
        }

      } catch (error) {
        logger.error(`Error polling ${sport.sport_key}`, { error });
      }
    }
    
    // Generate ONE consolidated summary at the end of polling
    if (allCandidates.length > 0 || allEvents.length > 0) {
      logger.section('ALERT SUMMARY', '🎯');
      
      const summaryLines: string[] = [];
      summaryLines.push(`Total Candidates Evaluated: ${allCandidates.length + eventsSkipped}`);
      summaryLines.push(`Alerts Generated: ${allCandidates.length}`);
      
      // Count near misses from all diagnostics (would need to track this)
      summaryLines.push(`Markets Processed: ${allEvents.length}`);
      
      // Show alerts that triggered
      if (allCandidates.length > 0) {
        summaryLines.push('');
        summaryLines.push('🎯 Alerts Triggered:');
        allCandidates.forEach(c => {
          const emoji = c.alert_tier === 'SOLID' ? '🟢' : c.alert_tier === 'SCOUT' ? '🟡' : '🔵';
          summaryLines.push(`  ${emoji} ${c.alert_tier}: ${c.selection} @ ${c.best_source} (${c.offered_price}x) - Edge: ${(c.edge_pp * 100).toFixed(2)}%`);
        });
      } else {
        summaryLines.push('');
        summaryLines.push('No alerts triggered this cycle');
        summaryLines.push('💡 Markets are currently efficient - waiting for better opportunities');
      }
      
      logger.info('\n' + summaryLines.join('\n'));
    }

    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
    
    logger.section('POLL SUMMARY', '📊');
    logger.summary({
      duration_seconds: duration,
      events_processed: allEvents.length,
      events_skipped: eventsSkipped,
      skip_reasons: `${skipReasons.alreadyStarted} started, ${skipReasons.recentlyPolled} recent`,
      snapshots_stored: allSnapshots.length,
      alerts_generated: allCandidates.length,
      api_calls_saved: apiCallsSaved,
    });

    const message = allEvents.length > 0 
      ? `Poll completed: ${allEvents.length} events, ${allSnapshots.length} snapshots, ${allCandidates.length} alerts generated`
      : `Poll completed: No events found for ${enabledSports.length} enabled sports`;

    return NextResponse.json({
      success: true,
      message,
      data: {
        events: allEvents.length,
        eventsSkipped,
        snapshots: allSnapshots.length,
        candidates: allCandidates.length,
        apiCallsSaved,
      },
    });

  } catch (error) {
    logger.error('Polling error', { error });
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}

// Helper functions (duplicated from discovery route)

