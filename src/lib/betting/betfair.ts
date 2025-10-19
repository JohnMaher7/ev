import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

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

type BetfairPlaceInstruction = {
  orderType: string;
  selectionId: number;
  side: string;
  limitOrder: {
    size: number;
    price: number;
    persistenceType: string;
  };
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
  const m = marketKey.match(/^(.*?)(?: \(line: ([0-9.]+)\))?$/);
  const base = m ? m[1] : marketKey;
  const line = m && m[2] ? parseFloat(m[2]) : undefined;
  if (base === 'h2h') return { typeCode: 'MATCH_ODDS' };
  if (base === 'totals' && typeof line === 'number') {
    const codeNum = Math.round(line * 10);
    return { typeCode: `OVER_UNDER_${codeNum}`, lineText: `${line.toFixed(1)} Goals` };
  }
  return { typeCode: 'MATCH_ODDS' };
}

function roundToBetfairTick(price: number): number {
  // Betfair tick ladder (decimal odds)
  // 1.01-2.00: 0.01; 2.02-3.00: 0.02; 3.05-4.00: 0.05; 4.1-6.0: 0.1; 6.2-10.0: 0.2
  // 10.5-20.0: 0.5; 21-30: 1; 32-50: 2; 55-100: 5; 110-1000: 10
  // We'll round DOWN to avoid placing at a non-permitted price and to be conservative
  const bands: Array<{ max: number; step: number }> = [
    { max: 2.0, step: 0.01 },
    { max: 3.0, step: 0.02 },
    { max: 4.0, step: 0.05 },
    { max: 6.0, step: 0.1 },
    { max: 10.0, step: 0.2 },
    { max: 20.0, step: 0.5 },
    { max: 30.0, step: 1.0 },
    { max: 50.0, step: 2.0 },
    { max: 100.0, step: 5.0 },
    { max: 1000.0, step: 10.0 },
  ];
  const p = Math.max(1.01, Math.min(price, 1000));
  const band = bands.find(b => p <= b.max) || bands[bands.length - 1];
  const ticks = Math.floor((p - 1.0) / band.step);
  const rounded = 1.0 + ticks * band.step;
  return Math.max(1.01, Math.min(rounded, 1000));
}

export interface PlaceBetInput {
  eventId: string;
  sportKey: string;
  marketKey: string;
  selection: string;
  odds: number;
  stake: number;
  acceptedFairProb: number;
  acceptedFairPrice: number;
}

export interface PlaceBetResult {
  ok: boolean;
  betId?: string;
  reason?: string;
}

export async function placeBetOnBetfair(input: PlaceBetInput): Promise<PlaceBetResult> {
  try {
    const appKey = process.env.BETFAIR_APP_KEY;
    const sessionToken = process.env.BETFAIR_SESSION_TOKEN;
    if (!appKey) {
      return { ok: false, reason: 'BETFAIR_APP_KEY not set' };
    }
    if (!sessionToken) {
      return { ok: false, reason: 'BETFAIR_SESSION_TOKEN not set (use cert login to obtain)' };
    }

    // Load event details (home/away/commence_time) for locating on Betfair
    if (!supabaseAdmin) {
      return { ok: false, reason: 'Supabase admin not configured' };
    }
    const { data: eventRows, error: eventErr } = await supabaseAdmin
      .from('events')
      .select('event_id, sport_key, commence_time, home, away')
      .eq('event_id', input.eventId)
      .limit(1);
    if (eventErr) {
      return { ok: false, reason: `DB error: ${eventErr.message}` };
    }
    if (!eventRows || eventRows.length === 0) {
      return { ok: false, reason: 'Event not found' };
    }
    const ev = eventRows[0] as { event_id: string; sport_key: string; commence_time: string; home: string; away: string };

    // Resolve event type and market type
    const sportName = resolveSportKeyToEventTypeName(input.sportKey);
    if (!sportName) {
      return { ok: false, reason: `Unsupported sport_key: ${input.sportKey}` };
    }
    const eventTypes = await betfairRpc<BetfairEventType[]>(appKey, sessionToken, 'SportsAPING/v1.0/listEventTypes', { filter: {} });
    const eventType = eventTypes.find((et) => et.eventType?.name === sportName);
    if (!eventType) {
      return { ok: false, reason: `Betfair event type not found: ${sportName}` };
    }
    const eventTypeId = eventType.eventType.id;

    const { typeCode, lineText } = mapMarketKeyToTypeCode(input.marketKey);
    const start = new Date(new Date(ev.commence_time).getTime() - 12 * 60 * 60 * 1000).toISOString();
    const end = new Date(new Date(ev.commence_time).getTime() + 12 * 60 * 60 * 1000).toISOString();

    const filter: Record<string, unknown> = {
      eventTypeIds: [eventTypeId],
      marketTypeCodes: [typeCode],
      marketStartTime: { from: start, to: end },
      textQuery: `${ev.home} ${ev.away}`,
    };

    const catalogues = await betfairRpc<BetfairMarketCatalogue[]>(appKey, sessionToken, 'SportsAPING/v1.0/listMarketCatalogue', {
      filter,
      maxResults: 50,
      marketProjection: ['RUNNER_DESCRIPTION'],
    });

    // Try to pick the best matching market and runner
    const wantedRunnerName = (() => {
      if (typeCode === 'MATCH_ODDS') {
        if (input.selection === ev.home) return ev.home;
        if (input.selection === ev.away) return ev.away;
        if (/draw/i.test(input.selection)) return 'The Draw';
        return input.selection;
      }
      // Over/Under soccer
      const lt = lineText || `${input.selection} Goals`;
      if (/over/i.test(input.selection)) return `Over ${lt}`;
      if (/under/i.test(input.selection)) return `Under ${lt}`;
      return input.selection;
    })();

    let chosen: { marketId: string; selectionId: number; runnerName: string } | null = null;
    for (const m of catalogues) {
      const rn = m.runners || [];
      const hit = rn.find(r => r.runnerName === wantedRunnerName);
      if (hit) {
        chosen = { marketId: m.marketId, selectionId: hit.selectionId, runnerName: hit.runnerName };
        break;
      }
    }
    if (!chosen) {
      return { ok: false, reason: 'No matching market/runner found on Betfair' };
    }

    // Fetch live book and confirm edge still acceptable
    const books = await betfairRpc<BetfairMarketBook[]>(appKey, sessionToken, 'SportsAPING/v1.0/listMarketBook', {
      marketIds: [chosen.marketId],
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    });
    const marketBook = books[0];
    const rb = (marketBook?.runners || []).find((r) => r.selectionId === chosen!.selectionId);
    const bestToBack = rb?.ex?.availableToBack?.[0] || null;
    if (!bestToBack || !bestToBack.price || !bestToBack.size) {
      return { ok: false, reason: 'No back offers available on Betfair' };
    }

    const livePrice: number = bestToBack.price as number;
    const implied = 1 / livePrice;
    const edge = input.acceptedFairProb - implied;
    if (edge < config.autoBet.minEdge) {
      return { ok: false, reason: `Edge ${edge.toFixed(6)} below threshold ${config.autoBet.minEdge}` };
    }

    // Choose execution price: use our target odds but cap by the current best available
    // For BACK orders, if we place with limit >= bestToBack.price, it should match at available price.
    const targetPrice = Math.max(1.01, input.odds);
    const executionPrice = roundToBetfairTick(Math.max(bestToBack.price, targetPrice));
    const size = Math.max(config.autoBet.minStake, Math.round(input.stake * 100) / 100);

    // Place order
    type PlaceOrdersResult = {
      customerRef?: string;
      status: string;
      errorCode?: string;
      instructionReports?: Array<{
        status: string;
        errorCode?: string;
        instruction?: BetfairPlaceInstruction;
        betId?: string;
        placedDate?: string;
        averagePriceMatched?: number;
        sizeMatched?: number;
        orderStatus?: string;
      }>;
    };

    const customerRef = `ev-${input.eventId}-${Date.now()}`;
    const placeRes = await betfairRpc<PlaceOrdersResult>(appKey, sessionToken, 'SportsAPING/v1.0/placeOrders', {
      marketId: chosen.marketId,
      instructions: [
        {
          selectionId: chosen.selectionId,
          side: 'BACK',
          orderType: 'LIMIT',
          limitOrder: {
            size,
            price: executionPrice,
            persistenceType: 'LAPSE',
          },
        },
      ],
      customerRef,
    });

    const ir = placeRes.instructionReports && placeRes.instructionReports[0];
    if (!ir || ir.status !== 'SUCCESS') {
      const reason = ir?.errorCode || placeRes.errorCode || placeRes.status || 'UNKNOWN_ERROR';
      return { ok: false, reason: `Betfair placeOrders failed: ${reason}` };
    }

    // Record bet locally
    const { data, error } = await supabaseAdmin
      .from('bets')
      .insert({
        event_id: input.eventId,
        sport_key: input.sportKey,
        market_key: input.marketKey,
        selection: input.selection,
        source: 'betfair_ex_uk',
        odds: executionPrice,
        stake: size,
        accepted_fair_prob: input.acceptedFairProb,
        accepted_fair_price: input.acceptedFairPrice,
      })
      .select('id')
      .single();

    if (error) {
      return { ok: false, reason: error.message };
    }

    return { ok: true, betId: data.id };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
}


