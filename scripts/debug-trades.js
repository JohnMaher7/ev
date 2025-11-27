#!/usr/bin/env node
/**
 * Trade Debugging Script
 * 
 * Queries database to find:
 * - Trades with errors
 * - Failed bet placements
 * - Recent trade events showing failures
 * - Suspicious calculations
 * 
 * Usage:
 *   node scripts/debug-trades.js [options]
 * 
 * Options:
 *   --strategy <key>    Filter by strategy (default: epl_under25)
 *   --hours <n>         Look back N hours (default: 24)
 *   --limit <n>         Max trades to show (default: 20)
 *   --events            Show detailed events for each trade
 *   --failed-only       Only show trades with errors/failures
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.local'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath, override: true });
    if (result.error) {
      console.warn(`Failed to load ${envPath}:`, result.error.message);
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (flag, defaultValue) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
};
const hasFlag = (flag) => args.includes(flag);

const strategyKey = getArg('--strategy', 'epl_under25');
const hoursBack = parseInt(getArg('--hours', '24'), 10);
const limit = parseInt(getArg('--limit', '20'), 10);
const showEvents = hasFlag('--events');
const failedOnly = hasFlag('--failed-only');

// Initialize Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials');
  console.error('   Required: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL');
  console.error('   Required: SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Helper: Format timestamp
function formatTime(ts) {
  if (!ts) return 'N/A';
  const d = new Date(ts);
  return d.toLocaleString('en-GB', { timeZone: 'UTC' });
}

// Helper: Format duration
function formatDuration(ms) {
  if (!ms) return 'N/A';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

// Helper: Color output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function color(text, c) {
  return `${colors[c]}${text}${colors.reset}`;
}

// Main query function
async function debugTrades() {
  console.log(color(`\n🔍 Trade Debugging Report`, 'cyan'));
  console.log(color(`   Strategy: ${strategyKey}`, 'gray'));
  console.log(color(`   Time window: Last ${hoursBack} hours`, 'gray'));
  console.log(color(`   Limit: ${limit} trades\n`, 'gray'));

  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  // 1. Query trades with errors or failures
  console.log(color('📊 Querying trades...', 'blue'));
  
  let query = supabase
    .from('strategy_trades')
    .select('*')
    .eq('strategy_key', strategyKey)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit * 2); // Get more to filter

  if (failedOnly) {
    query = query.or('last_error.not.is.null,status.eq.failed,status.eq.cancelled');
  }

  const { data: trades, error: tradesError } = await query;

  if (tradesError) {
    console.error(color(`❌ Error querying trades: ${tradesError.message}`, 'red'));
    process.exit(1);
  }

  if (!trades || trades.length === 0) {
    console.log(color('   No trades found in the specified time window', 'yellow'));
    return;
  }

  // Filter and sort
  const filteredTrades = trades
    .filter(t => {
      if (failedOnly) {
        return t.last_error || t.status === 'failed' || t.status === 'cancelled';
      }
      return true;
    })
    .slice(0, limit);

  console.log(color(`   Found ${filteredTrades.length} trade(s)\n`, 'green'));

  // 2. Get events for all trades
  const tradeIds = filteredTrades.map(t => t.id);
  const { data: events, error: eventsError } = await supabase
    .from('strategy_trade_events')
    .select('*')
    .in('trade_id', tradeIds)
    .order('occurred_at', { ascending: true });

  if (eventsError) {
    console.warn(color(`⚠️  Warning: Could not fetch events: ${eventsError.message}`, 'yellow'));
  }

  const eventsByTrade = {};
  if (events) {
    events.forEach(e => {
      if (!eventsByTrade[e.trade_id]) {
        eventsByTrade[e.trade_id] = [];
      }
      eventsByTrade[e.trade_id].push(e);
    });
  }

  // 3. Analyze each trade
  console.log(color('═══════════════════════════════════════════════════════════', 'cyan'));
  
  for (const trade of filteredTrades) {
    const tradeEvents = eventsByTrade[trade.id] || [];
    const failedEvents = tradeEvents.filter(e => 
      e.event_type.includes('FAILED') || 
      e.event_type.includes('ERROR') ||
      e.event_type.includes('CANCELLED')
    );
    const hasError = !!trade.last_error || failedEvents.length > 0;

    // Header
    const statusColor = hasError ? 'red' : 
                       trade.status === 'hedged' ? 'green' : 
                       trade.status === 'back_matched' ? 'yellow' : 'blue';
    console.log(color(`\n📋 Trade: ${trade.event_name || trade.event_id || 'Unknown'}`, 'cyan'));
    console.log(`   ID: ${trade.id}`);
    console.log(`   Status: ${color(trade.status.toUpperCase(), statusColor)}`);
    console.log(`   Created: ${formatTime(trade.created_at)}`);
    console.log(`   Kickoff: ${formatTime(trade.kickoff_at)}`);
    
    if (trade.kickoff_at) {
      const kickoff = new Date(trade.kickoff_at);
      const now = new Date();
      const diff = kickoff - now;
      if (diff > 0) {
        console.log(`   Time to kickoff: ${color(formatDuration(diff), 'yellow')}`);
      } else {
        console.log(`   Kickoff was: ${color(formatDuration(-diff) + ' ago', 'gray')}`);
      }
    }

    // Error information
    if (trade.last_error) {
      console.log(color(`   ❌ Error: ${trade.last_error}`, 'red'));
    }

    // Bet details
    console.log(color(`\n   💰 Bet Details:`, 'blue'));
    if (trade.back_price) {
      console.log(`      Back: £${trade.back_size || trade.back_stake || '?'} @ ${trade.back_price}`);
      if (trade.back_matched_size) {
        console.log(`      Back Matched: £${trade.back_matched_size}`);
      }
    } else {
      console.log(color(`      Back: ${color('NOT PLACED', 'red')}`, 'red'));
    }

    if (trade.lay_price) {
      console.log(`      Lay: £${trade.lay_size || '?'} @ ${trade.lay_price}`);
      if (trade.lay_matched_size) {
        console.log(`      Lay Matched: £${trade.lay_matched_size}`);
      }
    } else if (trade.status === 'back_matched' || trade.status === 'hedged') {
      console.log(color(`      Lay: ${color('MISSING', 'red')} (trade exposed!)`, 'red'));
    }

    if (trade.realised_pnl !== null && trade.realised_pnl !== undefined) {
      const pnlColor = trade.realised_pnl >= 0 ? 'green' : 'red';
      console.log(`      P&L: ${color(`£${trade.realised_pnl.toFixed(2)}`, pnlColor)}`);
    }

    // Suspicious patterns
    const issues = [];
    if (trade.back_price && trade.lay_price && trade.back_price < trade.lay_price) {
      issues.push('Back price < Lay price (inverted spread)');
    }
    if (trade.back_matched_size && !trade.lay_price && trade.status !== 'cancelled') {
      issues.push('Back matched but no lay placed (exposed)');
    }
    if (trade.total_stake && trade.total_stake > (trade.back_stake || 0) * 3) {
      issues.push(`Total stake suspiciously high: £${trade.total_stake}`);
    }
    if (trade.back_price && trade.back_price < 1.5) {
      issues.push(`Back price very low: ${trade.back_price} (may be incorrect)`);
    }

    if (issues.length > 0) {
      console.log(color(`\n   ⚠️  Issues Detected:`, 'yellow'));
      issues.forEach(issue => console.log(color(`      • ${issue}`, 'yellow')));
    }

    // Events summary
    if (tradeEvents.length > 0) {
      const eventTypes = [...new Set(tradeEvents.map(e => e.event_type))];
      console.log(color(`\n   📝 Events (${tradeEvents.length} total):`, 'blue'));
      eventTypes.forEach(et => {
        const count = tradeEvents.filter(e => e.event_type === et).length;
        const isFailure = et.includes('FAILED') || et.includes('ERROR');
        const etColor = isFailure ? 'red' : 'green';
        console.log(`      ${color(et, etColor)}: ${count}`);
      });

      if (failedEvents.length > 0) {
        console.log(color(`\n   ❌ Failed Events:`, 'red'));
        failedEvents.forEach(e => {
          console.log(color(`      • ${e.event_type} at ${formatTime(e.occurred_at)}`, 'red'));
          if (e.payload && typeof e.payload === 'object') {
            const errorCode = e.payload.errorCode || e.payload.error;
            if (errorCode) {
              console.log(color(`        Error: ${errorCode}`, 'red'));
            }
          }
        });
      }
    }

    // Show detailed events if requested
    if (showEvents && tradeEvents.length > 0) {
      console.log(color(`\n   📋 Event Timeline:`, 'cyan'));
      tradeEvents.forEach(e => {
        const isFailure = e.event_type.includes('FAILED') || e.event_type.includes('ERROR');
        const eColor = isFailure ? 'red' : 'gray';
        console.log(color(`      [${formatTime(e.occurred_at)}] ${e.event_type}`, eColor));
        if (e.payload && typeof e.payload === 'object' && Object.keys(e.payload).length > 0) {
          const payloadStr = JSON.stringify(e.payload, null, 2).split('\n').slice(0, 5).join('\n');
          console.log(color(`        ${payloadStr}`, 'gray'));
        }
      });
    }

    console.log(color('   ───────────────────────────────────────────────────────', 'gray'));
  }

  // 4. Summary statistics
  console.log(color(`\n📈 Summary Statistics:`, 'cyan'));
  const statusCounts = {};
  const errorCounts = {};
  filteredTrades.forEach(t => {
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    if (t.last_error) {
      const errorType = t.last_error.split(':')[0] || 'UNKNOWN';
      errorCounts[errorType] = (errorCounts[errorType] || 0) + 1;
    }
  });

  console.log(`   Status breakdown:`);
  Object.entries(statusCounts).forEach(([status, count]) => {
    console.log(`      ${status}: ${count}`);
  });

  if (Object.keys(errorCounts).length > 0) {
    console.log(`\n   Error breakdown:`);
    Object.entries(errorCounts).forEach(([error, count]) => {
      console.log(color(`      ${error}: ${count}`, 'red'));
    });
  }

  // 5. Recent failed bet placements
  if (events) {
    const failedBets = events.filter(e => 
      e.event_type === 'BACK_FAILED' || 
      e.event_type === 'LAY_FAILED'
    ).slice(0, 10);

    if (failedBets.length > 0) {
      console.log(color(`\n❌ Recent Failed Bet Placements (${failedBets.length}):`, 'red'));
      failedBets.forEach(e => {
        const trade = filteredTrades.find(t => t.id === e.trade_id);
        console.log(`   ${formatTime(e.occurred_at)}: ${e.event_type}`);
        console.log(`      Trade: ${trade?.event_name || e.trade_id}`);
        if (e.payload && e.payload.errorCode) {
          console.log(color(`      Error: ${e.payload.errorCode}`, 'red'));
        }
      });
    }
  }

  console.log(color(`\n✅ Debug report complete\n`, 'green'));
}

// Run
debugTrades().catch(err => {
  console.error(color(`\n❌ Fatal error: ${err.message}`, 'red'));
  console.error(err);
  process.exit(1);
});

