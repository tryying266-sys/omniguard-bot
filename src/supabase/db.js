// ============================================================================
// db.js - Supabase Client Initialization (v3.0 - Fail-Fast Enabled)
// ============================================================================
// This file establishes the core connection to Supabase.
// It is designed to be the single source of connection for the entire
// Universal Engine, ensuring all dynamic queries use this instance.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

// Extracting credentials from environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

/**
 * FAIL-FAST CHECK:
 * Prevents the bot and API server from starting if database credentials
 * are missing. This ensures logs and settings are never lost due to 
 * a silent connection failure.
 */
if (!supabaseUrl || !supabaseKey) {
    console.error('**************************************************');
    console.error('[CRITICAL DATABASE ERROR] Configuration Missing!');
    console.error('SUPABASE_URL or SUPABASE_KEY is not defined in .env');
    console.error('The system cannot proceed without a database link.');
    console.error('**************************************************');
    process.exit(1); 
}

/**
 * SUPABASE CLIENT INITIALIZATION:
 * persistSession: false is essential for Node.js (Bot/API) environments
 * to prevent unnecessary local storage overhead.
 */
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        persistSession: false, 
        autoRefreshToken: true,
        detectSessionInUrl: false
    }
});

// Export the singleton instance
module.exports = supabase;