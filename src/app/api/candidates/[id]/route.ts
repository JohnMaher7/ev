import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // If in demo mode or no Supabase connection, return success
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({
        success: true,
        message: 'Demo mode - alert cleared',
      });
    }

    const { id } = await params;

    const { error } = await supabaseAdmin
      .from('candidates')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Error deleting candidate: ${error.message}`);
    }

    return NextResponse.json({
      success: true,
      message: 'Alert cleared successfully',
    });

  } catch (error) {
    console.error('Error clearing alert:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
