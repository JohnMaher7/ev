import { NextRequest, NextResponse } from 'next/server';
import { getStoredLogs, clearStoredLogs, exportLogsAsCSV, type LogLevel } from '@/lib/logger';

/**
 * GET /api/logs - Retrieve stored logs with optional filtering
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    
    // Parse filter parameters
    const level = searchParams.get('level') as LogLevel | null;
    const logModule = searchParams.get('module');
    const startTime = searchParams.get('startTime');
    const endTime = searchParams.get('endTime');
    const search = searchParams.get('search');
    const format = searchParams.get('format'); // 'json' or 'csv'
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');

    // Get filtered logs
    const allLogs = getStoredLogs({
      level: level || undefined,
      module: logModule || undefined,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      search: search || undefined,
    });

    // Apply pagination
    const paginatedLogs = allLogs.slice(offset, offset + limit);
    
    // Return CSV if requested
    if (format === 'csv') {
      const csv = exportLogsAsCSV(paginatedLogs);
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="logs.csv"',
        },
      });
    }

    // Return JSON response
    return NextResponse.json({
      success: true,
      data: {
        logs: paginatedLogs,
        total: allLogs.length,
        limit,
        offset,
        hasMore: offset + limit < allLogs.length,
      },
    });
  } catch (error) {
    console.error('Error retrieving logs:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/logs - Clear all stored logs
 */
export async function DELETE(request: NextRequest) {
  try {
    clearStoredLogs();
    
    return NextResponse.json({
      success: true,
      message: 'Logs cleared successfully',
    });
  } catch (error) {
    console.error('Error clearing logs:', error, {
      method: request.method,
      url: request.nextUrl.pathname,
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
