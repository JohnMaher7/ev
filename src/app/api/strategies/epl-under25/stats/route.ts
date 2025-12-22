import { NextRequest, NextResponse } from 'next/server';

import { config } from '@/lib/config';
import { supabaseAdmin } from '@/lib/supabase';

type StrategyKey = typeof config.strategies.eplUnder25.key | typeof config.strategies.eplUnder25GoalReact.key;

type StrategyTradeRow = {
  id: string;
  strategy_key: StrategyKey;
  betfair_event_id: string | null;
  kickoff_at: string | null;
  competition_name: string | null;
  back_stake: number | null;
  back_matched_size: number | null;
  back_size: number | null;
  target_stake: number | null;
  realised_pnl: number | null;
  pnl: number | null;
  status: string;
};

type StatsResponse = {
  summary: { totalStaked: number; totalTrades: number; pnl: number };
  competitions: Array<{ name: string; pnl: number; trades: number; staked: number }>;
};

const STRATEGY_KEYS: StrategyKey[] = [config.strategies.eplUnder25.key, config.strategies.eplUnder25GoalReact.key];
const SETTLED_STATUSES = ['hedged', 'completed'] as const;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function isPlaceholderCompetition(name: string | null): boolean {
  return !name || name === 'Multiple Leagues' || name === 'Unknown';
}

function getBackStake(trade: StrategyTradeRow): number {
  return trade.back_stake ?? trade.back_matched_size ?? trade.back_size ?? trade.target_stake ?? 0;
}

function getRealisedPnl(trade: StrategyTradeRow): number | null {
  if (typeof trade.realised_pnl === 'number') return trade.realised_pnl;
  if (typeof trade.pnl === 'number') return trade.pnl;
  return null;
}

async function fetchAllSettledTrades(filters: {
  strategyKey?: StrategyKey;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<StrategyTradeRow[]> {
  if (!supabaseAdmin) return [];

  const pageSize = 1000;
  let cursor: string | null = null;
  const out: StrategyTradeRow[] = [];

  // Guard against infinite loops if timestamps repeat/null.
  for (let page = 0; page < 50; page += 1) {
    let q = supabaseAdmin
      .from('strategy_trades')
      .select('id,strategy_key,betfair_event_id,kickoff_at,competition_name,back_stake,back_matched_size,back_size,target_stake,realised_pnl,pnl,status')
      .in('strategy_key', filters.strategyKey ? [filters.strategyKey] : STRATEGY_KEYS)
      .in('status', Array.from(SETTLED_STATUSES))
      .not('kickoff_at', 'is', null)
      // Ensure P&L present => “settled trade”
      .or('realised_pnl.not.is.null,pnl.not.is.null')
      .order('kickoff_at', { ascending: false })
      .limit(pageSize);

    if (filters.dateFrom) q = q.gte('kickoff_at', filters.dateFrom);
    if (filters.dateTo) q = q.lte('kickoff_at', filters.dateTo);
    if (cursor) q = q.lt('kickoff_at', cursor);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows = (data || []) as StrategyTradeRow[];
    out.push(...rows);

    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1]?.kickoff_at ?? null;
    if (!cursor) break;
  }

  return out;
}

async function fetchFixtureCompetitionMap(strategyKeys: StrategyKey[], eventIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (!supabaseAdmin) return map;
  if (eventIds.length === 0) return map;

  const uniqueEventIds = Array.from(new Set(eventIds));
  for (const batch of chunk(uniqueEventIds, 500)) {
    const { data, error } = await supabaseAdmin
      .from('strategy_fixtures')
      .select('betfair_event_id, competition, strategy_key')
      .in('strategy_key', strategyKeys)
      .in('betfair_event_id', batch);
    if (error) throw new Error(error.message);

    (data || []).forEach((f) => {
      map.set(`${String(f.strategy_key)}-${String(f.betfair_event_id)}`, (f.competition ?? null) as string | null);
    });
  }

  return map;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategyKeyRaw = searchParams.get('strategy_key');
    const competitionName = searchParams.get('competition_name');
    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');

    if (config.demoMode || !supabaseAdmin) {
      const empty: StatsResponse = { summary: { totalStaked: 0, totalTrades: 0, pnl: 0 }, competitions: [] };
      return NextResponse.json({ success: true, data: empty });
    }

    const strategyKey =
      strategyKeyRaw && STRATEGY_KEYS.includes(strategyKeyRaw as StrategyKey) ? (strategyKeyRaw as StrategyKey) : undefined;

    const trades = await fetchAllSettledTrades({ strategyKey, dateFrom, dateTo });
    if (trades.length === 0) {
      const empty: StatsResponse = { summary: { totalStaked: 0, totalTrades: 0, pnl: 0 }, competitions: [] };
      return NextResponse.json({ success: true, data: empty });
    }

    const fixtureMap = await fetchFixtureCompetitionMap(
      strategyKey ? [strategyKey] : STRATEGY_KEYS,
      trades.map((t) => t.betfair_event_id).filter(Boolean) as string[],
    );

    const resolvedTrades = trades
      .map((t) => {
        const fixtureCompetition = t.betfair_event_id ? fixtureMap.get(`${t.strategy_key}-${t.betfair_event_id}`) : null;
        const resolvedCompetition = (isPlaceholderCompetition(t.competition_name) ? fixtureCompetition : t.competition_name) || fixtureCompetition || 'English Premier League';
        return { trade: t, competition: resolvedCompetition };
      })
      .filter(({ competition }) => (competitionName ? competition === competitionName : true));

    const competitionAgg = new Map<string, { pnl: number; trades: number; staked: number }>();
    let totalTrades = 0;
    let totalStaked = 0;
    let totalPnl = 0;

    for (const { trade, competition } of resolvedTrades) {
      const pnl = getRealisedPnl(trade);
      if (pnl == null) continue; // “settled trades only”

      const staked = getBackStake(trade);

      totalTrades += 1;
      totalStaked += staked;
      totalPnl += pnl;

      const prev = competitionAgg.get(competition) || { pnl: 0, trades: 0, staked: 0 };
      competitionAgg.set(competition, {
        pnl: prev.pnl + pnl,
        trades: prev.trades + 1,
        staked: prev.staked + staked,
      });
    }

    const payload: StatsResponse = {
      summary: {
        totalStaked: Number(totalStaked.toFixed(2)),
        totalTrades,
        pnl: Number(totalPnl.toFixed(2)),
      },
      competitions: Array.from(competitionAgg.entries())
        .map(([name, data]) => ({ name, ...data, pnl: Number(data.pnl.toFixed(2)), staked: Number(data.staked.toFixed(2)) }))
        .sort((a, b) => b.pnl - a.pnl),
    };

    return NextResponse.json({ success: true, data: payload });
  } catch (error) {
    console.error('[api][epl-under25][stats][GET]', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

