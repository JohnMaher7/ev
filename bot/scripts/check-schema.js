const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '../.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSchema() {
    const { data, error } = await supabase
        .from('strategy_settings')
        .select('*')
        .limit(1);

    if (error) {
        console.error('Error selecting from strategy_settings:', error);
        return;
    }

    if (data && data.length > 0) {
        const keys = Object.keys(data[0]);
        if (keys.includes('min_profit_pct')) {
            console.log('SCHEMA_CHECK: OK - min_profit_pct exists');
        } else {
            console.error('SCHEMA_CHECK: FAIL - min_profit_pct MISSING');
        }
    } else {
        console.log('Table is empty, cannot check columns easily via select *');
    }
}

checkSchema();
