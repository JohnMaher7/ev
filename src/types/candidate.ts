export interface Candidate {
  id: string;
  created_at: string;
  event_id: string;
  sport_key: string;
  market_key: string;
  selection: string;
  alert_tier: "SOLID" | "SCOUT" | "EXCHANGE_VALUE";
  best_source: string;
  offered_price: number;
  offered_prob: number;
  fair_price: number;
  fair_prob: number;
  edge_pp: number;
  books_count: number;
  exchanges_count: number;
  notes?: string;
  allBookmakerPrices?: Array<{
    bookmaker: string;
    price: number;
    isExchange: boolean;
  }>;
  events: {
    event_id: string;
    sport_key: string;
    commence_time: string;
    home: string;
    away: string;
  };
}






