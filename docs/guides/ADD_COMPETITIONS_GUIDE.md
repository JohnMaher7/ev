# Guide: Add Serie A and La Liga to Under 2.5 Strategy

**Goal:** Expand bot to trade on Serie A and La Liga in addition to EPL

---

## Step 1: Discover Competition IDs

### Method A: Temporary Logging (Quick)

1. **Add logging to `epl-under25.js` after line 577:**

```javascript
// TEMPORARY: Log all major league competitions
const majorLeagues = (competitionsRes || [])
  .filter(c => {
    const name = (c.competition?.name || '').toLowerCase();
    return name.includes('serie') || name.includes('liga') || 
           name.includes('premier') || name.includes('bundesliga');
  })
  .map(c => `"${c.competition.name}" = ${c.competition.id}`)
  .join(', ');
this.logger.log(`[strategy:epl_under25] 📋 MAJOR LEAGUES: ${majorLeagues}`);
```

2. **Deploy and check logs:**

```bash
cd C:\ev\bot\lib\strategies
scp epl-under25.js root@136.244.65.92:/opt/ev-betfair-bot/bot/lib/strategies/
ssh root@136.244.65.92 "systemctl restart ev-betfair-bot"
ssh root@136.244.65.92 "journalctl -u ev-betfair-bot -n 50 | grep 'MAJOR LEAGUES'"
```

3. **Copy the EXACT names and IDs from the output**

4. **Remove the temporary logging before final deployment**

### Method B: Run Discovery Script

```bash
cd C:\ev
node discover_competitions.js
```

---

## Step 2: Update Code

**File:** `c:\ev\bot\lib\strategies\epl-under25.js`

### Change 1: Update Competition Matchers (Lines 8-10)

**BEFORE:**
```javascript
// Strict matching for English Premier League ONLY
const COMPETITION_MATCHERS = [/^English Premier League$/i];
const EPL_COMPETITION_IDS = ['10932509']; // Betfair's EPL competition ID
```

**AFTER:**
```javascript
// Match multiple leagues: EPL, Serie A, La Liga
const COMPETITION_MATCHERS = [
  /^English Premier League$/i,  // EPL (verify exact name!)
  /^Serie A$/i,                  // Italian Serie A (verify exact name!)
  /^La Liga$/i,                  // Spanish La Liga (verify exact name!)
];

// Competition IDs from Betfair discovery
const EPL_COMPETITION_IDS = [
  '10932509',  // English Premier League
  '81',        // Serie A (REPLACE WITH ACTUAL ID FROM STEP 1!)
  '117',       // La Liga (REPLACE WITH ACTUAL ID FROM STEP 1!)
];
```

⚠️ **CRITICAL:** Use the EXACT names from Step 1. Case and spacing matter!

### Change 2: Make Competition Name Dynamic (Line 640)

**BEFORE:**
```javascript
competition: 'English Premier League',
```

**AFTER:**
```javascript
competition: evt.competition?.name || 'Unknown',
```

### Change 3: Update Log Messages (Optional)

**Line 9, 584, 639, etc.** - Replace "EPL" with "Multi-league" in logs:

```javascript
// BEFORE:
this.logger.log(`[strategy:epl_under25] Adding EPL fixture: ...`);

// AFTER:
this.logger.log(`[strategy:epl_under25] Adding fixture (${evt.competition?.name}): ...`);
```

---

## Step 3: Considerations

### Option A: Single Strategy for All Leagues (Simpler)

✅ One codebase  
✅ Unified betting pool  
✅ Easier to manage  
⚠️ Can't have different settings per league  
⚠️ All leagues share same stake/risk parameters

**Best for:** Testing, similar betting approach across leagues

### Option B: Separate Strategy Per League (More Control)

**Create 3 separate files:**
- `epl-under25.js` (existing)
- `serie-a-under25.js` (copy & modify)
- `la-liga-under25.js` (copy & modify)

**For each file, change:**
```javascript
const STRATEGY_KEY = 'serie_a_under25';  // Line 5
const COMPETITION_MATCHERS = [/^Serie A$/i];
const EPL_COMPETITION_IDS = ['81'];  // Serie A ID only
```

✅ Different stakes per league  
✅ Different settings per league  
✅ Independent enable/disable  
⚠️ More code to maintain  
⚠️ More database records

**Best for:** Production, different risk profiles per league

---

## Step 4: Test Before Deployment

### Validate Competition Names

1. **Run temporary logging (Step 1)**
2. **Verify output shows all 3 leagues:**
   ```
   📋 MAJOR LEAGUES: "English Premier League" = 10932509, "Serie A" = 81, "La Liga" = 117
   ```
3. **If any league missing:** Check spelling in COMPETITION_MATCHERS

### Check Fixture Count

After deployment, check logs:
```bash
ssh root@136.244.65.92 "journalctl -u ev-betfair-bot -f | grep 'Fixtures sync found'"
```

**Expected:**
```
Fixtures sync found 30 events  # ~10 EPL + ~10 Serie A + ~10 La Liga
```

**If too low:** One or more leagues not matching

---

## Step 5: Deploy

```bash
cd C:\ev\bot\lib\strategies

# Backup current version
cp epl-under25.js epl-under25.js.backup

# Deploy modified file
scp epl-under25.js root@136.244.65.92:/opt/ev-betfair-bot/bot/lib/strategies/

# Restart bot
ssh root@136.244.65.92 "systemctl restart ev-betfair-bot"

# Monitor startup
ssh root@136.244.65.92 "journalctl -u ev-betfair-bot -f | grep 'strategy:epl_under25'"
```

### Success Indicators

✅ `Matched EPL competitions: "English Premier League" (ID: 10932509), "Serie A" (ID: 81), "La Liga" (ID: 117)`  
✅ `Fixtures sync found 25-35 events` (depends on schedule)  
✅ `Adding fixture (Serie A): Inter v Milan`  
✅ `Adding fixture (La Liga): Real Madrid v Barcelona`

---

## Step 6: Verify Database

Check that fixtures were created:

```bash
ssh root@136.244.65.92 "psql postgres -c \"SELECT competition, COUNT(*) FROM fixtures WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY competition;\""
```

**Expected:**
```
     competition          | count
--------------------------+-------
 English Premier League   |    10
 Serie A                  |    10
 La Liga                  |    10
```

---

## Rollback Procedure

If something goes wrong:

```bash
cd C:\ev\bot\lib\strategies
scp epl-under25.js.backup root@136.244.65.92:/opt/ev-betfair-bot/bot/lib/strategies/epl-under25.js
ssh root@136.244.65.92 "systemctl restart ev-betfair-bot"
```

---

## Common Issues

### Issue: "No fixtures found for Serie A"

**Cause:** Competition name doesn't match Betfair's exact name  
**Fix:** Check logs for actual name, update COMPETITION_MATCHERS

### Issue: "Too many fixtures (60+)"

**Cause:** Regex too broad, matching lower divisions  
**Fix:** Make regex more specific:
```javascript
/^Serie A$/i,  // NOT /Serie A/i (would match Serie A2, Serie A TIM, etc)
```

### Issue: "Different stake sizes per league needed"

**Solution:** Use Option B (separate strategies per league)

---

## Quick Reference: Known Betfair IDs

| League | Exact Name (verify!) | Likely ID (verify!) |
|--------|---------------------|---------------------|
| EPL | `English Premier League` | `10932509` ✓ |
| Serie A | `Serie A` | `81` (unverified) |
| La Liga | `La Liga` | `117` (unverified) |
| Bundesliga | `Bundesliga` | `59` (unverified) |
| Ligue 1 | `Ligue 1` | `55` (unverified) |

⚠️ **ALWAYS VERIFY** with Step 1 before using!

---

**Questions? Check logs, read error messages, iterate!**

