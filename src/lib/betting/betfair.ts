import { supabaseAdmin } from '@/lib/supabase';

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

/**
 * Placeholder Betfair exchange client.
 * For now we simulate a placement by inserting into `bets` table.
 * Replace with real Betfair API integration when credentials are available.
 */
export async function placeBetOnBetfair(input: PlaceBetInput): Promise<PlaceBetResult> {
  try {
    if (!supabaseAdmin) {
      return { ok: false, reason: 'Supabase admin not configured' };
    }

    const { data, error } = await supabaseAdmin
      .from('bets')
      .insert({
        event_id: input.eventId,
        sport_key: input.sportKey,
        market_key: input.marketKey,
        selection: input.selection,
        source: 'betfair_ex_uk',
        odds: input.odds,
        stake: input.stake,
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


