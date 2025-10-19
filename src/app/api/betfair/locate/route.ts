import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
  id: number;
};

type BetfairEventType = {
  eventType: { id: string; name: string };
  marketCount: number;
};

type BetfairRunner = {
  selectionId: number;
  runnerName: string;
  handicap?: number;
};

type BetfairMarketCatalogue = {
  marketId: string;
  marketName: string;
  runners?: BetfairRunner[];
};

type BetfairRunnerBook = {
  selectionId: number;
  status: string;
  ex?: {
    availableToBack?: Array<{ price: number; size: number }>;
    availableToLay?: Array<{ price: number; size: number }>;
  };
};

type BetfairMarketBook = {
  marketId: string;
  isMarketDataDelayed: boolean;
  status: string;
  runners?: BetfairRunnerBook[];
};

async function betfairRpc<T>(appKey: string, sessionToken: string, method: string, params: Record<string, unknown>): Promise<T> {
  const payload: JsonRpcRequest[] = [{ jsonrpc: '2.0', method, params, id: 1 }];
  const res = await fetch('https://api.betfair.com/exchange/betting/json-rpc/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': appKey,
      'X-Authentication': sessionToken,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Betfair RPC error ${res.status}: ${JSON.stringify(data)}`);
  }
  if (!Array.isArray(data) || !data[0]) {
    throw new Error('Unexpected Betfair RPC response');
  }
  if (data[0].error) {
    throw new Error(`Betfair RPC method error: ${JSON.stringify(data[0].error)}`);
  }
  return data[0].result as T;
}

function resolveSportKeyToEventTypeName(sportKey: string): 'Soccer' | 'Tennis' | null {
  if (sportKey.startsWith('soccer')) return 'Soccer';
  if (sportKey.startsWith('tennis')) return 'Tennis';
  return null;
}

function mapMarketKeyToTypeCode(marketKey: string): { typeCode: string; lineText?: string } {
  // Examples: 'h2h' → MATCH_ODDS, 'totals (line: 2.5)' → OVER_UNDER_25
  const m = marketKey.match(/^(.*?)(?: \(line: ([0-9.]+)\))?$/);
  const base = m ? m[1] : marketKey;
  const line = m && m[2] ? parseFloat(m[2]) : undefined;
  if (base === 'h2h') return { typeCode: 'MATCH_ODDS' };
  if (base === 'totals' && typeof line === 'number') {
    const codeNum = Math.round(line * 10); // 2.5 -> 25, 3.5 -> 35
    return { typeCode: `OVER_UNDER_${codeNum}`, lineText: `${line.toFixed(1)} Goals` };
  }
  // Fallback to MATCH_ODDS
  return { typeCode: 'MATCH_ODDS' };
}

export async function POST(request: NextRequest) {
  try {
    const { candidateId, sessionToken } = await request.json();
    const appKey = process.env.BETFAIR_APP_KEY;
    const token = sessionToken || process.env.BETFAIR_SESSION_TOKEN;

    if (!appKey) {
      return NextResponse.json({ success: false, error: 'BETFAIR_APP_KEY not set' }, { status: 400 });
    }
    if (!token) {
      return NextResponse.json({ success: false, error: 'Session token missing. Provide in body or BETFAIR_SESSION_TOKEN' }, { status: 400 });
    }
    if (!candidateId) {
      return NextResponse.json({ success: false, error: 'candidateId is required' }, { status: 400 });
    }
    if (!supabaseAdmin) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 500 });
    }

    // Load candidate with event
    const { data: candidates, error: candErr } = await supabaseAdmin
      .from('candidates')
      .select(`*, events!inner(event_id, sport_key, commence_time, home, away)`) // join event
      .eq('id', candidateId)
      .limit(1);
    if (candErr) throw new Error(`DB error: ${candErr.message}`);
    if (!candidates || candidates.length === 0) {
      return NextResponse.json({ success: false, error: 'Candidate not found' }, { status: 404 });
    }
    const c = candidates[0];

    // Resolve event type id
    const sportName = resolveSportKeyToEventTypeName(c.sport_key);
    if (!sportName) {
      return NextResponse.json({ success: false, error: `Unsupported sport_key: ${c.sport_key}` }, { status: 400 });
    }
    const eventTypes = await betfairRpc<BetfairEventType[]>(appKey, token, 'SportsAPING/v1.0/listEventTypes', { filter: {} });
    const eventType = eventTypes.find((et) => et.eventType?.name === sportName);
    if (!eventType) {
      return NextResponse.json({ success: false, error: `Betfair event type not found: ${sportName}` }, { status: 404 });
    }
    const eventTypeId = eventType.eventType.id;

    // Build market filter
    const { typeCode, lineText } = mapMarketKeyToTypeCode(c.market_key);
    const start = new Date(new Date(c.events.commence_time).getTime() - 12 * 60 * 60 * 1000).toISOString();
    const end = new Date(new Date(c.events.commence_time).getTime() + 12 * 60 * 60 * 1000).toISOString();

    const filter: Record<string, unknown> = {
      eventTypeIds: [eventTypeId],
      marketTypeCodes: [typeCode],
      marketStartTime: { from: start, to: end },
      textQuery: `${c.events.home} ${c.events.away}`,
    };

    const catalogues = await betfairRpc<BetfairMarketCatalogue[]>(appKey, token, 'SportsAPING/v1.0/listMarketCatalogue', {
      filter,
      maxResults: 50,
      marketProjection: ['RUNNER_DESCRIPTION'],
    });

    // Try to pick the best matching market
    const wantedRunnerName = (() => {
      if (typeCode === 'MATCH_ODDS') {
        if (c.selection === c.events.home) return c.events.home;
        if (c.selection === c.events.away) return c.events.away;
        if (/draw/i.test(c.selection)) return 'The Draw';
        // Fallback: exact selection string
        return c.selection;
      }
      // Over/Under
      const lt = lineText || `${c.selection} Goals`;
      if (/over/i.test(c.selection)) return `Over ${lt}`;
      if (/under/i.test(c.selection)) return `Under ${lt}`;
      return c.selection;
    })();

    let chosen: { marketId: string; runner: BetfairRunner } | null = null;
    for (const m of catalogues) {
      const rn = m.runners || [];
      const hit = rn.find(r => r.runnerName === wantedRunnerName);
      if (hit) { chosen = { marketId: m.marketId, runner: hit }; break; }
    }

    if (!chosen) {
      return NextResponse.json({
        success: false,
        error: 'No matching market/runner found',
        debug: { wantedRunnerName, typeCode, sample: catalogues.slice(0, 3) },
      }, { status: 404 });
    }

    // Fetch live prices for confirmation
    const books = await betfairRpc<BetfairMarketBook[]>(appKey, token, 'SportsAPING/v1.0/listMarketBook', {
      marketIds: [chosen.marketId],
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    });
    const marketBook = books[0];
    const rb = (marketBook?.runners || []).find((r) => r.selectionId === chosen.runner.selectionId);
    const bestToBack = rb?.ex?.availableToBack?.[0] || null;

    return NextResponse.json({
      success: true,
      data: {
        marketId: chosen.marketId,
        selectionId: chosen.runner.selectionId,
        runnerName: chosen.runner.runnerName,
        bestToBack,
        confirm: bestToBack ? 'Located market and runner; live back price available' : 'Located market and runner; no back price visible',
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}


