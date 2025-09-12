import { createClient } from '@supabase/supabase-js';
import { config } from './config';

// Only create Supabase clients if we have the required keys
export const supabase = config.supabaseUrl && config.supabaseAnonKey 
  ? createClient(config.supabaseUrl, config.supabaseAnonKey)
  : null;

export const supabaseAdmin = config.supabaseUrl && config.supabaseServiceRoleKey
  ? createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )
  : null;

// Database types
export interface Database {
  public: {
    Tables: {
      sports: {
        Row: {
          sport_key: string;
          sport_title: string;
          enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          sport_key: string;
          sport_title: string;
          enabled: boolean;
        };
        Update: {
          sport_key?: string;
          sport_title?: string;
          enabled?: boolean;
        };
      };
      events: {
        Row: {
          event_id: string;
          sport_key: string;
          commence_time: string;
          home: string;
          away: string;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          event_id: string;
          sport_key: string;
          commence_time: string;
          home: string;
          away: string;
          status: string;
        };
        Update: {
          event_id?: string;
          sport_key?: string;
          commence_time?: string;
          home?: string;
          away?: string;
          status?: string;
        };
      };
      odds_snapshots: {
        Row: {
          id: string;
          event_id: string;
          taken_at: string;
          market_key: string;
          bookmaker: string;
          is_exchange: boolean;
          selection: string;
          decimal_odds: number;
          raw: any;
          created_at: string;
        };
        Insert: {
          id: string;
          event_id: string;
          taken_at: string;
          market_key: string;
          bookmaker: string;
          is_exchange: boolean;
          selection: string;
          decimal_odds: number;
          raw: any;
        };
        Update: {
          id?: string;
          event_id?: string;
          taken_at?: string;
          market_key?: string;
          bookmaker?: string;
          is_exchange?: boolean;
          selection?: string;
          decimal_odds?: number;
          raw?: any;
        };
      };
      candidates: {
        Row: {
          id: string;
          created_at: string;
          event_id: string;
          sport_key: string;
          market_key: string;
          selection: string;
          alert_tier: 'SOLID' | 'SCOUT' | 'EXCHANGE_VALUE';
          best_source: string;
          offered_price: number;
          offered_prob: number;
          fair_price: number;
          fair_prob: number;
          edge_pp: number;
          books_count: number;
          exchanges_count: number;
          notes: string | null;
        };
        Insert: {
          id: string;
          event_id: string;
          sport_key: string;
          market_key: string;
          selection: string;
          alert_tier: 'SOLID' | 'SCOUT' | 'EXCHANGE_VALUE';
          best_source: string;
          offered_price: number;
          offered_prob: number;
          fair_price: number;
          fair_prob: number;
          edge_pp: number;
          books_count: number;
          exchanges_count: number;
          notes?: string | null;
        };
        Update: {
          id?: string;
          event_id?: string;
          sport_key?: string;
          market_key?: string;
          selection?: string;
          alert_tier?: 'SOLID' | 'SCOUT' | 'EXCHANGE_VALUE';
          best_source?: string;
          offered_price?: number;
          offered_prob?: number;
          fair_price?: number;
          fair_prob?: number;
          edge_pp?: number;
          books_count?: number;
          exchanges_count?: number;
          notes?: string | null;
        };
      };
      bets: {
        Row: {
          id: string;
          created_at: string;
          event_id: string;
          sport_key: string;
          market_key: string;
          selection: string;
          source: string;
          odds: number;
          stake: number;
          accepted_fair_prob: number;
          accepted_fair_price: number;
          status: 'pending' | 'won' | 'lost' | 'void';
          settled_at: string | null;
          returns: number | null;
          pnl: number | null;
        };
        Insert: {
          id: string;
          event_id: string;
          sport_key: string;
          market_key: string;
          selection: string;
          source: string;
          odds: number;
          stake: number;
          accepted_fair_prob: number;
          accepted_fair_price: number;
          status: 'pending' | 'won' | 'lost' | 'void';
          settled_at?: string | null;
          returns?: number | null;
          pnl?: number | null;
        };
        Update: {
          id?: string;
          event_id?: string;
          sport_key?: string;
          market_key?: string;
          selection?: string;
          source?: string;
          odds?: number;
          stake?: number;
          accepted_fair_prob?: number;
          accepted_fair_price?: number;
          status?: 'pending' | 'won' | 'lost' | 'void';
          settled_at?: string | null;
          returns?: number | null;
          pnl?: number | null;
        };
      };
      closing_consensus: {
        Row: {
          id: string;
          event_id: string;
          market_key: string;
          selection: string;
          close_time: string;
          fair_prob: number;
          fair_price: number;
          created_at: string;
        };
        Insert: {
          id: string;
          event_id: string;
          market_key: string;
          selection: string;
          close_time: string;
          fair_prob: number;
          fair_price: number;
        };
        Update: {
          id?: string;
          event_id?: string;
          market_key?: string;
          selection?: string;
          close_time?: string;
          fair_prob?: number;
          fair_price?: number;
        };
      };
      metrics_daily: {
        Row: {
          id: string;
          date: string;
          staked: number;
          pnl: number;
          expected_value: number;
          actual_margin: number;
          expected_margin: number;
          clv_bps: number;
          win_rate: number;
          num_bets: number;
          num_bets_scout: number;
          num_bets_solid: number;
          num_bets_exchange: number;
          created_at: string;
        };
        Insert: {
          id: string;
          date: string;
          staked: number;
          pnl: number;
          expected_value: number;
          actual_margin: number;
          expected_margin: number;
          clv_bps: number;
          win_rate: number;
          num_bets: number;
          num_bets_scout: number;
          num_bets_solid: number;
          num_bets_exchange: number;
        };
        Update: {
          id?: string;
          date?: string;
          staked?: number;
          pnl?: number;
          expected_value?: number;
          actual_margin?: number;
          expected_margin?: number;
          clv_bps?: number;
          win_rate?: number;
          num_bets?: number;
          num_bets_scout?: number;
          num_bets_solid?: number;
          num_bets_exchange?: number;
        };
      };
    };
  };
}
