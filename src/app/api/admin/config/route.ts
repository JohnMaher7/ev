import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      pollMinutes: config.pollMinutes,
      timezone: config.appTimezone,
      demoMode: config.demoMode,
      thresholds: config.alertThresholds,
    },
  });
}


