import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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

export function formatDateTime(date: string | Date): string {
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(d);
}

export function formatTime(date: string | Date): string {
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-GB', {
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(d);
}

export function getAlertTierColor(tier: string): string {
  switch (tier) {
    case 'SOLID':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'SCOUT':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 'EXCHANGE_VALUE':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'won':
      return 'bg-green-100 text-green-800';
    case 'lost':
      return 'bg-red-100 text-red-800';
    case 'void':
      return 'bg-gray-100 text-gray-800';
    case 'pending':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}
