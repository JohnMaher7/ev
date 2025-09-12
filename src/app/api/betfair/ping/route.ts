import { NextRequest, NextResponse } from 'next/server';

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

    const payload = [{
      jsonrpc: '2.0',
      method: 'SportsAPING/v1.0/listEventTypes',
      params: { filter: {} },
      id: 1,
    }];

    const res = await fetch('https://api.betfair.com/exchange/betting/json-rpc/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Application': appKey,
        'X-Authentication': token,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ success: false, status: res.status, data }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}


