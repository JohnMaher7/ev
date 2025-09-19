import { NextRequest, NextResponse } from 'next/server';

async function doKeepAlive(appKey: string, sessionToken: string) {
  const res = await fetch('https://identitysso.betfair.com/api/keepAlive', {
    method: 'POST',
    headers: {
      'X-Application': appKey,
      'X-Authentication': sessionToken,
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function GET() {
  try {
    const appKey = process.env.BETFAIR_APP_KEY;
    const token = process.env.BETFAIR_SESSION_TOKEN;
    if (!appKey) {
      return NextResponse.json({ success: false, error: 'BETFAIR_APP_KEY not set' }, { status: 400 });
    }
    if (!token) {
      return NextResponse.json({ success: false, error: 'BETFAIR_SESSION_TOKEN not set' }, { status: 400 });
    }
    const { ok, status, data } = await doKeepAlive(appKey, token);
    if (!ok) {
      return NextResponse.json({ success: false, status, data }, { status: 500 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { sessionToken } = await request.json().catch(() => ({ sessionToken: undefined }));
    const appKey = process.env.BETFAIR_APP_KEY;
    const token = sessionToken || process.env.BETFAIR_SESSION_TOKEN;
    if (!appKey) {
      return NextResponse.json({ success: false, error: 'BETFAIR_APP_KEY not set' }, { status: 400 });
    }
    if (!token) {
      return NextResponse.json({ success: false, error: 'Session token missing. Provide in body or BETFAIR_SESSION_TOKEN' }, { status: 400 });
    }
    const { ok, status, data } = await doKeepAlive(appKey, token);
    if (!ok) {
      return NextResponse.json({ success: false, status, data }, { status: 500 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}


