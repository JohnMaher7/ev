---
name: Fix Discovery/Poll Disconnect - Surgical Diagnosis
overview: ""
todos:
  - id: 86eb3385-f200-4e26-89c6-80fac6aada77
    content: Create simple toast notification component and context
    status: pending
  - id: 4916f4e8-0eef-410f-8bba-55b8e27abd50
    content: Add toast notifications to discovery and poll mutations in admin view
    status: pending
  - id: 4c94fe72-c568-46ea-9aa5-c04a41cde8fc
    content: Enhance response messages in poll and discovery routes
    status: pending
  - id: ce79e471-6b24-4078-9798-d7f4cda8e2b8
    content: Add console.log statements to track execution in Vercel logs
    status: pending
  - id: c3f7d656-c4b7-410b-9009-1afb8845788c
    content: Test Discovery → Poll sequence and verify toasts show correctly
    status: pending
---

# Fix Discovery/Poll Disconnect - Surgical Diagnosis

## Critical Issues Found

1. **Discovery route**: No `supabaseAdmin` null check (uses `supabaseAdmin!` assertion that will throw)
2. **Discovery enabledCount**: Doesn't track failures, so "14 sports enabled" might be lying
3. **No health endpoint**: Can't verify what's actually configured
4. **Odds API client**: Always created even with empty key

## Minimal Surgical Fixes

### 1. Add Supabase Check to Discovery (CRITICAL)

**File: `src/app/api/discovery/route.ts`** - After line 21, before API call:

```typescript
if (!supabaseAdmin) {
  console.error('❌ Discovery: Supabase not configured');
  return NextResponse.json({
    success: false,
    error: 'Database not configured',
  }, { status: 500 });
}
```

### 2. Track Failures in Discovery Upsert Loop

**File: `src/app/api/discovery/route.ts`** - Lines 32-53:

```typescript
let enabledCount = 0;
let failedCount = 0;

for (const sport of targetSports) {
  const { error } = await supabaseAdmin.from('sports').upsert(...);
  if (error) {
    failedCount++;
    console.error(`❌ Error upserting ${sport.key}:`, error.message, error.details);
  } else {
    enabledCount++;
  }
}

console.log(`✅ Discovery: ${enabledCount} enabled, ${failedCount} failed`);

// Return error if none succeeded
if (enabledCount === 0 && targetSports.length > 0) {
  return NextResponse.json({
    success: false,
    error: `Failed to enable any sports. Database errors occurred.`,
  }, { status: 500 });
}
```

### 3. Create Health Check Endpoint

**New File: `src/app/api/health/route.ts`**:

```typescript
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET() {
  const health = {
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
```

### 4. Make Odds API Client Conditional

**File: `src/lib/odds-api.ts`** - Line 135:

```typescript
export const oddsApiClient = config.oddsApiKey && config.oddsApiKey.length > 0
  ? new OddsApiClient(config.oddsApiKey)
  : null;
```

Then in discovery/poll routes, check before using:

```typescript
if (!oddsApiClient) {
  return NextResponse.json({
    success: false,
    error: 'Odds API not configured',
  }, { status: 500 });
}
```

## Implementation Order

1. Health endpoint (diagnose current state)
2. Discovery validation (prevent silent failures)
3. Discovery error tracking (accurate reporting)
4. Conditional API client (consistent pattern)

These 4 changes will reveal EXACTLY where the break is.