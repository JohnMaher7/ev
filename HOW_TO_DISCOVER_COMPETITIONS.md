# How to Discover Competition IDs

## ✅ FIXED Discovery Script

The script now works! It uses the same Betfair login as your bot.

---

## How to Run (Windows)

### Step 1: Open PowerShell in the project directory

```powershell
cd C:\ev
```

### Step 2: Run the discovery script

```powershell
node discover_competitions.js
```

### Expected Output:

```
🔍 Fetching all soccer competitions from Betfair...

✓ Logged in to Betfair

Found 125 total soccer competitions

═══════════════════════════════════════════════════════
📋 MAJOR EUROPEAN LEAGUES (15 found):
═══════════════════════════════════════════════════════

Name: "English Premier League"
ID:   10932509
Markets: 380
---
Name: "La Liga"
ID:   117
Markets: 380
---
Name: "Serie A"
ID:   81
Markets: 380
---
Name: "Bundesliga"
ID:   59
Markets: 306
---
Name: "Ligue 1"
ID:   55
Markets: 306
---

═══════════════════════════════════════════════════════
📝 TO ADD TO YOUR STRATEGY:
═══════════════════════════════════════════════════════

1. Copy the EXACT name (with quotes)
2. Copy the ID
3. Update epl-under25.js lines 8-10:

const COMPETITION_MATCHERS = [
  /^English Premier League$/i,  // ID: 10932509
  /^La Liga$/i,  // ID: 117
  /^Serie A$/i,  // ID: 81
];

const EPL_COMPETITION_IDS = [
  '10932509',  // English Premier League
  '117',  // La Liga
  '81',  // Serie A
];
```

---

## Troubleshooting

### Error: "Failed to login to Betfair"

**Cause:** Missing or incorrect credentials

**Fix:**
```powershell
# Check .env file exists
ls .env

# Verify it has these variables:
# BETFAIR_USERNAME=your_username
# BETFAIR_PASSWORD=your_password
# BETFAIR_APP_KEY=your_app_key
```

### Error: "Cannot find module './bot/lib/betfair-session'"

**Cause:** Wrong directory

**Fix:**
```powershell
# Make sure you're in C:\ev, not C:\ev\bot
cd C:\ev
node discover_competitions.js
```

### Error: Nothing happens / hangs

**Cause:** Network issue or Betfair API down

**Fix:**
```powershell
# Check bot is working:
ssh root@136.244.65.92 "journalctl -u ev-betfair-bot -n 5"

# If bot works, try again in a few minutes
```

---

## Alternative: Check Bot Logs (No Script Needed)

Your bot ALREADY fetches all competitions! Just check the logs:

```powershell
ssh root@136.244.65.92 "journalctl -u ev-betfair-bot --since '1 hour ago' --no-pager | grep 'Fetched.*competitions'"
```

**You'll see:**
```
[strategy:epl_under25] Fetched 125 soccer competitions from Betfair
```

The bot fetches them but doesn't log the details. To see the details, you need to add temporary logging (see below).

---

## Option 1 Fixed: Temporary Logging Method

Why didn't it work? Because the fixture sync only runs:
- At bot startup
- Every 24 hours
- When manually triggered

### How to Make It Work:

1. **Add logging to `epl-under25.js` after line 577:**

```javascript
this.logger.log(`[strategy:epl_under25] Fetched ${competitionsRes?.length || 0} soccer competitions from Betfair`);

// ADD THIS BLOCK:
const majorLeagues = (competitionsRes || [])
  .filter(c => {
    const name = (c.competition?.name || '').toLowerCase();
    return name.includes('serie') || name.includes('liga') || 
           name.includes('premier') || name.includes('bundesliga') ||
           name.includes('championship');
  })
  .map(c => `"${c.competition.name}" (ID: ${c.competition.id})`)
  .join(', ');
this.logger.log(`[strategy:epl_under25] 📋 MAJOR LEAGUES: ${majorLeagues}`);
// END ADD
```

2. **Deploy:**

```powershell
cd C:\ev\bot\lib\strategies
scp epl-under25.js root@136.244.65.92:/opt/ev-betfair-bot/bot/lib/strategies/
ssh root@136.244.65.92 "systemctl restart ev-betfair-bot"
```

3. **Check logs immediately (will show on startup):**

```powershell
ssh root@136.244.65.92 "journalctl -u ev-betfair-bot -n 50 | grep 'MAJOR LEAGUES'"
```

4. **Remove the temporary logging after you get the IDs**

---

## Which Method Should I Use?

| Method | Pros | Cons |
|--------|------|------|
| **Discovery Script** | ✅ Clean output<br>✅ One command<br>✅ No bot restart | ⚠️ Requires local .env |
| **Temporary Logging** | ✅ Uses server's credentials<br>✅ Guaranteed to work | ⚠️ Requires bot restart<br>⚠️ Need to remove after |
| **Bot Logs** | ✅ No changes needed | ❌ Doesn't show details |

**Recommendation:** Try discovery script first. If it doesn't work, use temporary logging.

---

## Next Steps After Discovery

1. **Get IDs from script output**
2. **Update `epl-under25.js` lines 8-10**
3. **Update line 640** to make competition dynamic:
   ```javascript
   competition: evt.competition?.name || 'Unknown',
   ```
4. **Deploy and test**

See `ADD_COMPETITIONS_GUIDE.md` for full deployment guide.

