/**
 * Competition Discovery Script
 * Run this to find Betfair competition IDs and exact names
 *  $env:DOTENV_CONFIG_PATH=".env.bot"
 * node -r dotenv/config discover_competitions.js
 * Usage: node discover_competitions.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
  initializeSessionManager,
  ensureLogin,
  betfairRpc,
} = require('./bot/lib/betfair-session');

// Initialize session manager
initializeSessionManager({ logger: console });

async function discoverCompetitions() {
  try {
    console.log('🔍 Fetching all soccer competitions from Betfair...\n');
    
    // Login to Betfair
    const sessionToken = await ensureLogin();
    if (!sessionToken) {
      throw new Error('Failed to login to Betfair. Check your credentials.');
    }
    
    console.log('✓ Logged in to Betfair\n');
    
    // Fetch all soccer competitions
    const result = await betfairRpc(sessionToken, 'SportsAPING/v1.0/listCompetitions', {
      filter: { eventTypeIds: ['1'] }, // Soccer = event type 1
    });
    
    if (!result || result.length === 0) {
      console.log('⚠️  No competitions found');
      return;
    }
    
    console.log(`Found ${result.length} total soccer competitions\n`);
    
    // Filter for major European leagues
    const searchTerms = ['premier', 'liga', 'serie', 'bundesliga', 'ligue', 'europa'];
    const filtered = result.filter(c => {
      const name = c.competition?.name?.toLowerCase() || '';
      return searchTerms.some(term => name.includes(term));
    });
    
    console.log('═══════════════════════════════════════════════════════');
    console.log(`📋 MAJOR EUROPEAN LEAGUES (${filtered.length} found):`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    filtered
      .sort((a, b) => (b.marketCount || 0) - (a.marketCount || 0)) // Sort by market count
      .forEach(c => {
        console.log(`Name: "${c.competition.name}"`);
        console.log(`ID:   ${c.competition.id}`);
        console.log(`Markets: ${c.marketCount || 0}`);
        console.log('---');
      });
    
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📝 TO ADD TO YOUR STRATEGY:');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('1. Copy the EXACT name (with quotes)');
    console.log('2. Copy the ID');
    console.log('3. Update epl-under25.js lines 8-10:\n');
    console.log('const COMPETITION_MATCHERS = [');
    filtered.slice(0, 5).forEach(c => {
      console.log(`  /^${c.competition.name}$/i,  // ID: ${c.competition.id}`);
    });
    console.log('];\n');
    console.log('const EPL_COMPETITION_IDS = [');
    filtered.slice(0, 5).forEach(c => {
      console.log(`  '${c.competition.id}',  // ${c.competition.name}`);
    });
    console.log('];\n');
    
    process.exit(0);
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error('\nTroubleshooting:');
    console.error('- Check .env file exists with correct credentials');
    console.error('- Verify BETFAIR_USERNAME, BETFAIR_PASSWORD set');
    console.error('- Ensure certificate files exist');
    process.exit(1);
  }
}

discoverCompetitions();

