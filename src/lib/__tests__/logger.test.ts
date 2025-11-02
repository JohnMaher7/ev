/**
 * Unit tests for the high-performance logger
 */

import { Logger, getStoredLogs, clearStoredLogs, exportLogsAsCSV } from '../logger';

describe('Logger', () => {
  let logger: Logger;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    clearStoredLogs();
    logger = new Logger('test');
    // Mock console.log to prevent test output noise
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    clearStoredLogs();
    consoleLogSpy.mockRestore();
  });

  describe('Logging levels', () => {
    it('should log at all levels when set to debug', () => {
      const debugLogger = new Logger('test', 'debug');
      
      debugLogger.debug('debug message');
      debugLogger.info('info message');
      debugLogger.warn('warn message');
      debugLogger.error('error message');

      const logs = getStoredLogs();
      expect(logs).toHaveLength(4);
      expect(logs[0].level).toBe('debug');
      expect(logs[1].level).toBe('info');
      expect(logs[2].level).toBe('warn');
      expect(logs[3].level).toBe('error');
    });

    it('should only log info and above when set to info', () => {
      const infoLogger = new Logger('test', 'info');
      
      infoLogger.debug('debug message');
      infoLogger.info('info message');
      infoLogger.warn('warn message');
      infoLogger.error('error message');

      const logs = getStoredLogs();
      expect(logs).toHaveLength(3);
      expect(logs[0].level).toBe('info');
      expect(logs[1].level).toBe('warn');
      expect(logs[2].level).toBe('error');
    });

    it('should only log errors when set to error', () => {
      const errorLogger = new Logger('test', 'error');
      
      errorLogger.debug('debug message');
      errorLogger.info('info message');
      errorLogger.warn('warn message');
      errorLogger.error('error message');

      const logs = getStoredLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error');
    });
  });

  describe('Lazy evaluation', () => {
    it('should not evaluate debug functions when level is info', () => {
      const infoLogger = new Logger('test', 'info');
      const expensiveFn = jest.fn(() => 'expensive computation');
      
      infoLogger.debug(expensiveFn);
      
      expect(expensiveFn).not.toHaveBeenCalled();
    });

    it('should evaluate debug functions when level is debug', () => {
      const debugLogger = new Logger('test', 'debug');
      const expensiveFn = jest.fn(() => 'expensive computation');
      
      debugLogger.debug(expensiveFn);
      
      expect(expensiveFn).toHaveBeenCalled();
    });

    it('should handle lazy data evaluation', () => {
      const debugLogger = new Logger('test', 'debug');
      const dataFn = jest.fn(() => ({ key: 'value' }));
      
      debugLogger.debug('message', dataFn);
      
      expect(dataFn).toHaveBeenCalled();
      const logs = getStoredLogs();
      expect(logs[0].data).toEqual({ key: 'value' });
    });
  });

  describe('Log storage', () => {
    it('should store logs with correct structure', () => {
      logger.info('test message', { extra: 'data' });
      
      const logs = getStoredLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        level: 'info',
        module: 'test',
        message: 'test message',
        data: { extra: 'data' },
      });
      expect(logs[0].timestamp).toBeDefined();
    });

    it('should maintain circular buffer of 1000 entries', () => {
      // Add 1100 logs
      for (let i = 0; i < 1100; i++) {
        logger.info(`Message ${i}`);
      }
      
      const logs = getStoredLogs();
      expect(logs).toHaveLength(1000);
      expect(logs[0].message).toBe('Message 100'); // First 100 should be dropped
      expect(logs[999].message).toBe('Message 1099');
    });
  });

  describe('Log filtering', () => {
    beforeEach(() => {
      clearStoredLogs(); // Clear any previous logs
      
      // Need to use debug logger to ensure debug messages are stored
      const debugLogger = new Logger('test', 'debug');
      debugLogger.debug('debug message');
      debugLogger.info('info message');
      debugLogger.warn('warn message');
      debugLogger.error('error message');
      
      const logger2 = new Logger('other', 'debug');
      logger2.info('other module message');
    });

    it('should filter by level', () => {
      const warnAndAbove = getStoredLogs({ level: 'warn' });
      expect(warnAndAbove).toHaveLength(2);
      expect(warnAndAbove.every(log => ['warn', 'error'].includes(log.level))).toBe(true);
    });

    it('should filter by module', () => {
      const testLogs = getStoredLogs({ module: 'test' });
      expect(testLogs).toHaveLength(4);
      expect(testLogs.every(log => log.module === 'test')).toBe(true);
    });

    it('should filter by search term', () => {
      const warningLogs = getStoredLogs({ search: 'warn' });
      expect(warningLogs).toHaveLength(1);
      expect(warningLogs[0].message).toBe('warn message');
    });

    it('should filter by timestamp range', () => {
      const now = new Date();
      const before = new Date(now.getTime() - 1000).toISOString();
      const after = new Date(now.getTime() + 1000).toISOString();
      
      const inRange = getStoredLogs({ startTime: before, endTime: after });
      expect(inRange.length).toBeGreaterThan(0);
    });
  });

  describe('Performance timing', () => {
    it('should measure execution time', async () => {
      const debugLogger = new Logger('test', 'debug');
      const timer = debugLogger.time('test operation');
      
      await new Promise(resolve => setTimeout(resolve, 50));
      timer();
      
      const logs = getStoredLogs();
      const lastLog = logs[logs.length - 1];
      expect(lastLog.message).toMatch(/test operation took \d+\.\d+ms/);
    });

    it('should not create timer when level is above debug', () => {
      const infoLogger = new Logger('test', 'info');
      const timer = infoLogger.time('test operation');
      
      timer(); // Should be no-op
      
      const logs = getStoredLogs();
      expect(logs).toHaveLength(0);
    });
  });

  describe('CSV export', () => {
    it('should export logs as CSV', () => {
      logger.info('Test message', { key: 'value' });
      logger.error('Error message');
      
      const csv = exportLogsAsCSV(getStoredLogs());
      const lines = csv.split('\n');
      
      expect(lines[0]).toBe('Timestamp,Level,Module,Message,Data');
      expect(lines).toHaveLength(3); // Header + 2 logs
      expect(lines[1]).toContain('info');
      expect(lines[1]).toContain('Test message');
      expect(lines[2]).toContain('error');
    });

    it('should escape CSV special characters', () => {
      logger.info('Message with "quotes" and, commas');
      
      const csv = exportLogsAsCSV(getStoredLogs());
      const lines = csv.split('\n');
      
      expect(lines[1]).toContain('"Message with ""quotes"" and, commas"');
    });
  });

  describe('Special log methods', () => {
    it('should format section headers', () => {
      logger.section('Test Section');

      const logs = getStoredLogs();
      const lastLog = logs[logs.length - 1];
      expect(lastLog.message).toContain('TEST SECTION');
      expect(lastLog.message).toContain('═');
    });

    it('should format summaries', () => {
      logger.summary({
        total_items: 100,
        processed: 95,
        errors: 5,
      });

      const logs = getStoredLogs();
      const lastLog = logs[logs.length - 1];
      expect(lastLog.message).toContain('Total Items: 100');
      expect(lastLog.message).toContain('Processed: 95');
      expect(lastLog.message).toContain('Errors: 5');
    });

    it('should format alert logs', () => {
      logger.alert('SOLID', {
        selection: 'Team A',
        offered_price: 2.5,
        edge_pp: 0.02,
        best_source: 'bookmaker1',
      } as unknown as AlertLogPayload);

      const logs = getStoredLogs();
      const lastLog = logs[logs.length - 1];
      expect(lastLog.message).toContain('🟢 SOLID ALERT');
      expect(lastLog.message).toContain('Team A @ 2.5');
      expect(lastLog.message).toContain('Edge: 2.00%');
    });

    it('should format near-miss logs', () => {
      logger.nearMiss('Team A', 0.008, 0.01, 'Edge below threshold');

      const logs = getStoredLogs();
      const lastLog = logs[logs.length - 1];
      expect(lastLog.message).toContain('⚠️ Near miss: Team A');
      expect(lastLog.message).toContain('0.80% edge, needs 1.00%');
      expect(lastLog.message).toContain('80% of threshold');
    });
  });
});
