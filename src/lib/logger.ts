/**
 * High-performance structured logger with configurable verbosity
 * Supports lazy evaluation and batched writes for minimal performance impact
 */

import { type AlertCandidate } from './alerts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
};

// Global log store for in-app viewing
const logStore: LogEntry[] = [];
const MAX_LOG_ENTRIES = 1000;

// Log level hierarchy
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default log level from environment
const DEFAULT_LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

export class Logger {
  private pendingLogs: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private currentLevel: number;

  constructor(
    private module: string,
    private level: LogLevel = DEFAULT_LOG_LEVEL
  ) {
    this.currentLevel = LOG_LEVELS[level];
  }

  /**
   * Debug logging with lazy evaluation
   */
  debug(message: string | (() => string), data?: unknown | (() => unknown)) {
    if (this.currentLevel > LOG_LEVELS.debug) return;
    
    // Lazy evaluation - only compute if needed
    const actualMessage = typeof message === 'function' ? message() : message;
    const actualData = typeof data === 'function' ? data() : data;
    
    this.log('debug', actualMessage, actualData);
  }

  /**
   * Info logging
   */
  info(message: string, data?: unknown) {
    if (this.currentLevel > LOG_LEVELS.info) return;
    this.log('info', message, data);
  }

  /**
   * Warning logging
   */
  warn(message: string, data?: unknown) {
    if (this.currentLevel > LOG_LEVELS.warn) return;
    this.log('warn', message, data);
  }

  /**
   * Error logging
   */
  error(message: string, data?: unknown) {
    this.log('error', message, data);
  }

  /**
   * Log a section header for better organization
   */
  section(title: string, emoji = '📌') {
    if (this.currentLevel > LOG_LEVELS.info) return;
    
    const separator = '═'.repeat(35);
    const message = `${emoji} ${title.toUpperCase()}\n${separator}`;
    
    // Store formatted section in log store (console.log happens in flush)
    this.log('info', message);
  }

  /**
   * Log a summary with formatted key-value pairs
   */
  summary(data: Record<string, unknown>) {
    if (this.currentLevel > LOG_LEVELS.info) return;
    
    const lines: string[] = [];
    Object.entries(data).forEach(([key, value]) => {
      const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      const line = `  • ${formattedKey}: ${value}`;
      lines.push(line);
    });
    
    // Store formatted summary in log store (console.log happens in flush)
    this.log('info', lines.join('\n'));
  }

  /**
   * Special formatting for alerts
   */
  alert(tier: 'SOLID' | 'SCOUT' | 'EXCHANGE_VALUE', candidate: AlertCandidate) {
    const emoji = tier === 'SOLID' ? '🟢' : tier === 'SCOUT' ? '🟡' : '🔵';
    const edge = (candidate.edge_pp * 100).toFixed(2);
    
    const message = `${emoji} ${tier} ALERT: ${candidate.selection} @ ${candidate.offered_price}\n   Edge: ${edge}% | EV: ${candidate.edge_pp.toFixed(4)} | Source: ${candidate.best_source}`;
    
    // Store in log store (console.log happens in flush)
    this.log('info', message, candidate);
  }

  /**
   * Log near-miss alerts for diagnostics
   */
  nearMiss(selection: string, edge: number, threshold: number, reason: string) {
    if (this.currentLevel > LOG_LEVELS.info) return;
    
    const edgePercent = (edge * 100).toFixed(2);
    const thresholdPercent = (threshold * 100).toFixed(2);
    const missPercent = ((edge / threshold) * 100).toFixed(0);
    
    const message = `  ⚠️ Near miss: ${selection} (${edgePercent}% edge, needs ${thresholdPercent}% - ${missPercent}% of threshold)\n     Reason: ${reason}`;
    
    // Store in log store (console.log happens in flush)
    this.log('info', message);
  }

  /**
   * Performance timing helper
   */
  time(label: string): () => void {
    if (this.currentLevel > LOG_LEVELS.debug) return () => {};
    
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.debug(`${label} took ${duration.toFixed(2)}ms`);
    };
  }

  /**
   * Core logging function with batching
   */
  private log(level: LogLevel, message: string, data?: unknown) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      data,
    };

    // Add to in-memory store (circular buffer)
    logStore.push(entry);
    if (logStore.length > MAX_LOG_ENTRIES) {
      logStore.shift();
    }

    // Debug: Log storage count occasionally
    if (logStore.length % 50 === 0) {
      console.log(`[Logger] logStore size: ${logStore.length}`);
    }

    // Add to pending batch
    this.pendingLogs.push(entry);

    // Schedule flush
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 10);
    }
  }

  /**
   * Flush pending logs to console
   */
  private flush() {
    if (this.pendingLogs.length === 0) return;

    // Batch write to console
    for (const log of this.pendingLogs) {
      const prefix = `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.module}]`;
      const color = this.getColor(log.level);
      
      console.log(`${color}${prefix}${this.resetColor()} ${log.message}`);
      
      if (log.data) {
        console.log(JSON.stringify(log.data, null, 2));
      }
    }

    // Clear pending logs
    this.pendingLogs = [];
    this.flushTimer = null;
  }

  /**
   * Get color code for log level
   */
  private getColor(level: LogLevel): string {
    // Only use colors in development
    if (process.env.NODE_ENV === 'production') return '';
    
    switch (level) {
      case 'debug': return '\x1b[90m'; // Gray
      case 'info': return '\x1b[36m';  // Cyan
      case 'warn': return '\x1b[33m';  // Yellow
      case 'error': return '\x1b[31m'; // Red
    }
  }

  /**
   * Reset color
   */
  private resetColor(): string {
    return process.env.NODE_ENV === 'production' ? '' : '\x1b[0m';
  }
}

/**
 * Get all stored logs
 */
export function getStoredLogs(
  filter?: {
    level?: LogLevel;
    module?: string;
    startTime?: string;
    endTime?: string;
    search?: string;
  }
): LogEntry[] {
  console.log(`[getStoredLogs] Total logs in store: ${logStore.length}`);
  let logs = [...logStore];

  if (filter) {
    if (filter.level) {
      const minLevel = LOG_LEVELS[filter.level];
      logs = logs.filter(log => LOG_LEVELS[log.level] >= minLevel);
    }

    if (filter.module) {
      const moduleFilter = filter.module;
      logs = logs.filter(log => log.module.includes(moduleFilter));
    }

    if (filter.startTime) {
      const startTimeFilter = filter.startTime;
      logs = logs.filter(log => log.timestamp >= startTimeFilter);
    }

    if (filter.endTime) {
      const endTimeFilter = filter.endTime;
      logs = logs.filter(log => log.timestamp <= endTimeFilter);
    }

    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      logs = logs.filter(log => 
        log.message.toLowerCase().includes(searchLower) ||
        (log.data && JSON.stringify(log.data).toLowerCase().includes(searchLower))
      );
    }
  }

  return logs;
}

/**
 * Clear stored logs
 */
export function clearStoredLogs() {
  logStore.length = 0;
}

/**
 * Export logs as CSV
 */
export function exportLogsAsCSV(logs: LogEntry[]): string {
  const headers = ['Timestamp', 'Level', 'Module', 'Message', 'Data'];
  const rows = logs.map(log => [
    log.timestamp,
    log.level,
    log.module,
    log.message,
    log.data ? JSON.stringify(log.data) : '',
  ]);

  return [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
  ].join('\n');
}
