/**
 * Verification script for the new polling system
 * Run: npx ts-node scripts/verify-polling-setup.ts
 */

import { shouldEnableSport } from '../src/lib/utils';

console.log('🔍 Verifying Polling Configuration\n');
console.log('=' .repeat(60));

// Test sport keys from The Odds API
const testSportKeys = [
  // Tennis (should all be enabled)
  'tennis_atp_us_open',
  'tennis_wta_french_open',
  'tennis_atp_wimbledon',
  'tennis_atp_challenger',
  
  // Soccer - Lower grade (should be enabled)
  'soccer_england_league1',
  'soccer_england_league2',
  'soccer_efl_champ',
  'soccer_denmark_superliga',
  'soccer_norway_eliteserien',
  'soccer_sweden_allsvenskan',
  'soccer_finland_veikkausliiga',
  'soccer_poland_ekstraklasa',
  
  // Soccer - High grade (should NOT be enabled - too efficient)
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_uefa_champs_league',
  'soccer_germany_bundesliga',
  
  // Darts (should be enabled)
  'darts_pdc_world_champs',
  'darts_world_matchplay',
  
  // American sports (should be enabled)
  'basketball_nba',
  'americanfootball_nfl',
  
  // Other sports (should NOT be enabled)
  'icehockey_nhl',
  'cricket_test_match',
  'baseball_mlb',
];

console.log('\n📊 Sport Filtering Tests:\n');

let passCount = 0;
let failCount = 0;

testSportKeys.forEach(sportKey => {
  const enabled = shouldEnableSport(sportKey);
  const shouldBeEnabled = 
    sportKey.startsWith('tennis_') ||
    sportKey.startsWith('darts_') ||
    sportKey === 'basketball_nba' ||
    sportKey === 'americanfootball_nfl' ||
    (sportKey.startsWith('soccer_') && 
     !['soccer_epl', 'soccer_spain_la_liga', 'soccer_uefa_champs_league', 'soccer_germany_bundesliga'].includes(sportKey));
  
  const status = enabled === shouldBeEnabled ? '✅' : '❌';
  const result = enabled ? 'ENABLED' : 'DISABLED';
  
  console.log(`${status} ${sportKey.padEnd(35)} → ${result}`);
  
  if (enabled === shouldBeEnabled) {
    passCount++;
  } else {
    failCount++;
  }
});

console.log('\n' + '='.repeat(60));
console.log(`\n📈 Results: ${passCount} passed, ${failCount} failed\n`);

if (failCount === 0) {
  console.log('✅ All tests passed! Sport filtering is working correctly.\n');
} else {
  console.log('❌ Some tests failed. Review the shouldEnableSport() function.\n');
  process.exit(1);
}

console.log('📋 Next Steps:');
console.log('  1. Run database migration: supabase-migration-add-last-polled.sql');
console.log('  2. Execute discovery: POST /api/discovery');
console.log('  3. Execute poll: POST /api/poll');
console.log('  4. Check logs for "API calls saved" metrics\n');

console.log('🎯 Expected Behavior:');
console.log('  • Discovery: Finds and enables target sports (no odds fetched)');
console.log('  • Poll: Smart filtering skips events polled <30min ago');
console.log('  • Poll: Skips events >7 days away or already started');
console.log('  • Result: 70-80% reduction in API credit usage\n');

















