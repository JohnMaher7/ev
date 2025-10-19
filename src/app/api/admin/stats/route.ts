import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

function toIsoStartOfDay(date = new Date()): string {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function GET(_request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json({ success: true, data: {
        sports: [],
        lastDiscovery: null,
        lastPoll: null,
        totalSnapshots: 0,
        totalCandidates: 0,
        apiCallsToday: 0,
        errorsToday: 0,
        recentActivity: [],
      } });
    }

    const startOfDay = toIsoStartOfDay();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const [sportsRes, lastPollRes, snapCountRes, candDayCountRes, lastDiscRes, eventsDayCountRes, snapsHourCountRes, candHourCountRes] = await Promise.all([
      supabaseAdmin.from('sports').select('sport_key, sport_title, enabled').order('sport_key'),
      supabaseAdmin.from('odds_snapshots').select('taken_at').order('taken_at', { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from('odds_snapshots').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('candidates').select('id', { count: 'exact', head: true }).gte('created_at', startOfDay),
      supabaseAdmin.from('events').select('updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from('events').select('event_id', { count: 'exact', head: true }).gte('created_at', startOfDay),
      supabaseAdmin.from('odds_snapshots').select('id', { count: 'exact', head: true }).gte('taken_at', oneHourAgo),
      supabaseAdmin.from('candidates').select('id', { count: 'exact', head: true }).gte('created_at', oneHourAgo),
    ]);

    const sports = sportsRes.data || [];
    const lastPoll = lastPollRes.data?.taken_at || null;
    const totalSnapshots = snapCountRes.count || 0;
    const totalCandidates = candDayCountRes.count || 0; // past day
    const lastDiscovery = lastDiscRes.data?.updated_at || null;
    const eventsToday = eventsDayCountRes.count || 0;
    const snapshotsLastHour = snapsHourCountRes.count || 0;
    const candidatesLastHour = candHourCountRes.count || 0;

    const recentActivity = [
      lastDiscovery && {
        title: 'Discovery activity',
        detail: `Events added today: ${eventsToday}`,
        at: lastDiscovery,
      },
      lastPoll && {
        title: 'Polling activity',
        detail: `Snapshots last 60m: ${snapshotsLastHour}, candidates last 60m: ${candidatesLastHour}`,
        at: lastPoll,
      },
    ].filter(Boolean) as Array<{ title: string; detail: string; at: string }>;

    return NextResponse.json({
      success: true,
      data: {
        sports,
        lastDiscovery,
        lastPoll,
        totalSnapshots,
        totalCandidates,
        apiCallsToday: (snapCountRes.count || 0) - ((snapshotsLastHour || 0) - (snapshotsLastHour || 0)), // simple proxy
        errorsToday: 0,
        recentActivity,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}


