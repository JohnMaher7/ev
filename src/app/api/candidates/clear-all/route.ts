import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { config } from '@/lib/config';

export async function DELETE() {
  try {
    // If in demo mode or no Supabase connection, return success
    if (config.demoMode || !supabaseAdmin) {
      return NextResponse.json({
        success: true,
        message: 'Demo mode - all alerts cleared',
      });
    }

    // Get count of candidates first
    const { count: candidateCount, error: countError } = await supabaseAdmin
      .from('candidates')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      throw new Error(`Error counting candidates: ${countError.message}`);
    }
    
    console.log(`Found ${candidateCount} candidates to clear`);
    
    if (candidateCount && candidateCount > 0) {
      // Delete all candidates using a condition that matches all records
      const { error: deleteError } = await supabaseAdmin
        .from('candidates')
        .delete()
        .gte('created_at', '1970-01-01'); // Delete all records (created_at is always after 1970)
      
      if (deleteError) {
        throw new Error(`Error deleting candidates: ${deleteError.message}`);
      }
      
      console.log(`Successfully deleted ${candidateCount} candidates`);
    }

    return NextResponse.json({
      success: true,
      message: 'All alerts cleared successfully',
    });

  } catch (error) {
    console.error('Error clearing all alerts:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
