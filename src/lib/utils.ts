import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(amount);
}

export function formatPercentage(value: number, decimals: number = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatBasisPoints(value: number): string {
  return `${(value * 10000).toFixed(0)} bps`;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat("en-GB", options).format(value);
}

export function formatDateTime(date: string | Date): string {
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short',
    timeStyle: 'medium',  // Changed from 'short' to include seconds (HH:mm:ss)
    timeZone: 'Europe/London',
  }).format(d);
}

export function formatTime(date: string | Date): string {
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-GB', {
    timeStyle: 'medium',  // Changed from 'short' to include seconds (HH:mm:ss)
    timeZone: 'Europe/London',
  }).format(d);
}

export function getAlertTierColor(tier: string): string {
  switch (tier) {
    case "SOLID":
      return "bg-green-100 text-green-800 border-green-200";
    case "SCOUT":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "EXCHANGE_VALUE":
      return "bg-blue-100 text-blue-800 border-blue-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200";
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "won":
      return "bg-green-100 text-green-800";
    case "lost":
      return "bg-red-100 text-red-800";
    case "void":
      return "bg-gray-100 text-gray-800";
    case "pending":
      return "bg-yellow-100 text-yellow-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

/**
 * Determine if a sport should be enabled for polling
 * Focus: All tennis (ATP/WTA), lower-grade soccer, darts, NBA, NFL
 */
export function shouldEnableSport(sportKey: string): boolean {
  // All tennis tournaments (ATP, WTA, challengers, etc.)
  if (sportKey.startsWith('tennis_')) {
    return true;
  }
  
  // Darts (all competitions)
  if (sportKey.startsWith('darts_')) {
    return true;
  }
  
  // Lower-grade soccer leagues (avoid EPL, La Liga, Champions League - too efficient markets)
  // Target: League 1, League 2, Championship, lower European leagues
  const targetSoccerLeagues = [
    'soccer_england_league1',
    'soccer_england_league2', 
    'soccer_efl_champ',
    'soccer_league_of_ireland',
    'soccer_denmark_superliga',
    'soccer_norway_eliteserien',
    'soccer_sweden_allsvenskan',
    'soccer_finland_veikkausliiga',
    'soccer_austria_bundesliga',
    'soccer_switzerland_superleague',
    'soccer_poland_ekstraklasa',
    'soccer_czech_republic_1',
    'soccer_slovakia_super_liga',
    'soccer_croatia_hnl',
    'soccer_romania_liga_1',
    'soccer_serbia_superliga',
    'soccer_greece_super_league',
  ];
  
  if (targetSoccerLeagues.includes(sportKey)) {
    return true;
  }
  
  // American sports
  if (sportKey === 'basketball_nba' || sportKey === 'americanfootball_nfl') {
    return true;
  }
  
  return false;
}