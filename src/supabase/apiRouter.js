// ============================================================================
// apiRouter.js - Universal API Routing Module (v3.2 - Route Order + Multi-Row Fix)
// ============================================================================
// This router facilitates the dynamic communication between the Dashboard UI
// and the Database. It uses a Universal Sync pattern to handle any table
// defined in the SQL schema without needing additional code for new features.
//
// [FIX v3.1 - kept from the previous pass] Route shadowing (Express route
// matching order):
//       Express matches routes in the order they are registered, and the
//       FIRST pattern that matches a request's path wins - even if a more
//       specific route is defined further down the same file.
//
//       The generic Universal Sync routes:
//           GET  /guild/:guildId/:tableName
//           PUT  /guild/:guildId/:tableName
//       match ANY 3-path-segment URL under /guild/<id>/..., which includes
//       "/guild/<id>/custom-embed-draft" - that's exactly 3 segments too.
//       If these generic routes are registered BEFORE the dedicated
//       custom-embed-draft routes, every request meant for the dedicated
//       handlers gets silently caught by the generic ones instead (wrong
//       table name, no upsert, no 24h expiry check - see the full
//       explanation above Section 3 below).
//
//       Fix: every specific/literal-path route (alt-anti logs, init,
//       custom-embed-draft GET/PUT/publish) is registered ABOVE the generic
//       Universal Sync catch-all routes (Section 4, now last).
//
// [FIX v3.2 - new, this pass] ".single() on multi-row tables" bug:
//       The actual `.single()` call lives in databaseQueries.js's
//       universalGet(), which this router calls for the generic GET route.
//       `.single()` tells PostgREST "I expect exactly one row" - true for
//       the one-row-per-guild settings tables (setting_guild, etc.), but
//       FALSE for a table like role_delay_config, whose real primary key is
//       (id_guild, id_role) - a guild can have several rows there (one per
//       delayed role). Calling the generic route for that table used to
//       fail (or worse - PostgREST's PGRST116 code covers both "0 rows" and
//       ">1 rows", and the old code silently swallowed that code without
//       throwing, so it could return null/empty instead of a clear error,
//       hiding the guild's actual data from the dashboard).
//
//       Fix (root cause fixed in databaseQueries.js, see that file):
//       universalGet() now checks a MULTI_ROW_TABLES set and, for those
//       tables, runs a plain SELECT (no .single()) returning an array
//       instead. This router's GET handler needed NO code change for that
//       part - `result || {}` already returns an array untouched, since
//       arrays are truthy in JS even when empty.
//       universalUpdate() now REFUSES to run for multi-row tables instead
//       of blindly UPDATE-ing every row for that guild with the same
//       values (which is what a WHERE id_guild-only update would otherwise
//       do). This router's PUT handler now catches that specific refusal
//       and returns a clean 400 instead of a generic 500, so the dashboard
//       gets an explainable error instead of a mysterious "Internal Server
//       Error" - see the new catch block in Section 4 below.
// ============================================================================

const express = require('express');
const queries = require('./databaseQueries');

// custom.js lives directly under src/commands/ (confirmed via the FIX note
// in index.js - there is no AutoMod subfolder). apiRouter.js lives under
// src/supabase/, so one level up ('../') reaches src/.
const customEmbed = require('../commands/custom.js');

const router = express.Router();

/**
 * Middleware: Verify Dashboard API Key (Security)
 * Ensures that only authorized requests from the Dashboard can modify data.
 */
function requireDashboardApiKey(req, res, next) {
    const apiKey = process.env.DASHBOARD_API_KEY;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== apiKey) {
        console.warn(`[Security] Blocked unauthorized API request from IP: ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }
    next();
}

/**
 * Middleware: Ensure Guild ID is present in the request
 */
function requireGuildId(req, res, next) {
    const guildId = req.params.guildId || req.body.guildId;
    if (!guildId) {
        return res.status(400).json({ error: 'Missing Required Parameter: guildId' });
    }
    req.guildId = guildId;
    next();
}

// Apply Security Middleware to all routes
router.use(requireDashboardApiKey);

// ============================================================================
// 1. LOGS & ACTIVITY (Specialized Endpoints)
// ============================================================================

/**
 * GET /api/guild/:guildId/alt-anti/logs
 * Matches the log-fetching request used by dashboard.js (fetchAntiAltLogs).
 * (This one has 4 path segments, so it never actually collided with the
 * generic routes - kept here anyway so every literal-path route lives above
 * the catch-all, consistently.)
 */
router.get('/guild/:guildId/alt-anti/logs', requireGuildId, async (req, res) => {
    try {
        const supabase = require('./db');
        let query = supabase
            .from('alt_suspected')
            .select('*')
            .eq('id_guild', req.params.guildId)
            .order('at_detected', { ascending: false });

        // فلترة اختيارية بالنقاط - يستخدمها كرت Anti-Alt Log بالداشبورد
        // (?minScore= مربوط بـ setting_alt_anti.log_min_score_display).
        const minScore = Number(req.query.minScore);
        if (Number.isFinite(minScore)) {
            query = query.gte('score', minScore);
        }

        const { data, error } = await query;
        if (error) throw error;
        const rows = data || [];

        // [NEW] نتأكد حياً هل العقوبة لسا سارية فعلياً بديسكورد (يمكن حد رفعها
        // يدوياً من برا الداشبورد) - يحدد ظهور زر "Undo" الأخضر بالواجهة.
        // Kicked/Flagged ما فيهم شي يُرجَّع، فما نفحصهم إطلاقاً.
        let client = null;
        try { client = require('../index'); } catch (_) { /* البوت لسه ما اشتغل */ }
        const guild = client ? await client.guilds.fetch(req.params.guildId).catch(() => null) : null;

        let isolateRoleId = null;
        if (guild) {
            const { data: settingsRow } = await supabase
                .from('setting_alt_anti')
                .select('isolate_role_id')
                .eq('id_guild', req.params.guildId)
                .single();
            isolateRoleId = settingsRow?.isolate_role_id || null;
        }

        const enriched = await Promise.all(rows.map(async (row) => {
            let stillActive = false;
            if (guild && ['Banned', 'Muted', 'Isolated'].includes(row.action_taken)) {
                if (row.action_taken === 'Banned') {
                    const ban = await guild.bans.fetch(row.id_user).catch(() => null);
                    stillActive = !!ban;
                } else {
                    const member = await guild.members.fetch(row.id_user).catch(() => null);
                    if (row.action_taken === 'Muted') {
                        stillActive = !!(member?.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now());
                    } else if (row.action_taken === 'Isolated') {
                        stillActive = !!(member && isolateRoleId && member.roles.cache.has(isolateRoleId));
                    }
                }
            }
            return { ...row, stillActive };
        }));

        res.json(enriched);
    } catch (err) {
        console.error('[API Router Error] GET /logs/alt:', err.message);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

/**
 * POST /api/guild/:guildId/alt-anti/action
 * Manually applies Kick/Ban/Mute against a previously-flagged suspected alt
 * account directly from the Anti-Alt Log dashboard card, and updates that
 * specific log row's action_taken to reflect the staff's decision.
 * Expected body: { logId, userId, action: 'kick' | 'ban' | 'mute' }
 */
router.post('/guild/:guildId/alt-anti/action', requireGuildId, async (req, res) => {
    try {
        const { logId, userId, action } = req.body;

        if (!logId || !userId || !['kick', 'ban', 'mute'].includes(action)) {
            return res.status(400).json({ error: 'Invalid Payload: logId, userId, and a valid action (kick/ban/mute) are required' });
        }

        // Lazy require: apiServer.js only calls require('./index') AFTER
        // app.listen() at boot - but that happens once, long before any
        // HTTP request actually reaches this handler, so by request-time
        // index.js has already fully executed and exported the live,
        // connected bot client. Same lazy-require pattern already used
        // elsewhere in this file (require('./db') above).
        const client = require('../index');
        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) {
            return res.status(404).json({ error: 'Bot is not in this guild' });
        }

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) {
            return res.status(404).json({ error: 'Member not found in guild (may have already left)' });
        }

        const reason = 'AntiAlt: Manual action taken from dashboard log';
        const ACTION_LABELS = { kick: 'Kicked', ban: 'Banned', mute: 'Muted' };

        if (action === 'kick') {
            if (!member.kickable) return res.status(403).json({ error: 'Bot cannot kick this member (role hierarchy/permissions)' });
            await member.kick(reason);
        } else if (action === 'ban') {
            if (!member.bannable) return res.status(403).json({ error: 'Bot cannot ban this member (role hierarchy/permissions)' });
            await member.ban({ reason });
        } else if (action === 'mute') {
            if (!member.moderatable) return res.status(403).json({ error: 'Bot cannot mute this member (role hierarchy/permissions)' });
            await member.timeout(24 * 60 * 60 * 1000, reason); // 24h default from the dashboard
        }

        const supabase = require('./db');
        await supabase.from('alt_suspected').update({ action_taken: ACTION_LABELS[action] }).eq('id', logId);

        try {
            await queries.logModerationAction({
                guildId: req.guildId,
                targetId: userId,
                targetUsername: member.user.tag,
                moderatorId: null,
                actionType: action,
                reason,
                duration: null
            });
        } catch (logErr) {
            console.error('[API Router Error] Failed to log manual AntiAlt action:', logErr.message);
        }

        res.json({ success: true, action: ACTION_LABELS[action] });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/alt-anti/action:`, err.message);
        res.status(500).json({ error: 'Failed to execute action' });
    }
});

/**
 * POST /api/guild/:guildId/alt-anti/undo
 * Reverts an active Ban/Mute/Isolate back to normal (unban / remove
 * timeout / restore original roles). Only meaningful while the punishment
 * is still active - the dashboard only shows this button when stillActive
 * is true for that row.
 * Expected body: { userId, actionTaken: 'Banned' | 'Muted' | 'Isolated' }
 */
router.post('/guild/:guildId/alt-anti/undo', requireGuildId, async (req, res) => {
    try {
        const { userId, actionTaken } = req.body;
        if (!userId || !['Banned', 'Muted', 'Isolated'].includes(actionTaken)) {
            return res.status(400).json({ error: 'Invalid Payload: userId and a revertible actionTaken (Banned/Muted/Isolated) are required' });
        }

        const client = require('../index');
        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) {
            return res.status(404).json({ error: 'Bot is not in this guild' });
        }

        const supabase = require('./db');

        if (actionTaken === 'Banned') {
            await guild.bans.remove(userId, 'AntiAlt: Manual undo from dashboard log');
        } else {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                return res.status(404).json({ error: 'Member not found in guild (may have already left)' });
            }

            if (actionTaken === 'Muted') {
                await member.timeout(null, 'AntiAlt: Manual undo from dashboard log');
            } else if (actionTaken === 'Isolated') {
                const { data: settingsRow } = await supabase
                    .from('setting_alt_anti')
                    .select('isolate_role_id')
                    .eq('id_guild', req.params.guildId)
                    .single();
                const isolateRoleId = settingsRow?.isolate_role_id;
                if (isolateRoleId) {
                    await member.roles.remove(isolateRoleId, 'AntiAlt: Manual undo from dashboard log').catch(() => {});
                }

                const { data: backup } = await supabase
                    .from('backup_role_member')
                    .select('roles')
                    .eq('id_guild', req.params.guildId)
                    .eq('id_user', userId)
                    .single();

                if (backup?.roles?.length > 0) {
                    await member.roles.add(backup.roles, 'AntiAlt: Restored roles after isolation undo').catch(() => {});
                    await supabase
                        .from('backup_role_member')
                        .delete()
                        .eq('id_guild', req.params.guildId)
                        .eq('id_user', userId);
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/alt-anti/undo:`, err.message);
        res.status(500).json({ error: 'Failed to undo action' });
    }
});

// ============================================================================
// 2. SYSTEM MANAGEMENT
// ============================================================================

/**
 * POST /api/guild/:guildId/init
 * Initializes the server rows in SQL using the RPC function.
 */
router.post('/guild/:guildId/init', requireGuildId, async (req, res) => {
    try {
        const result = await queries.initGuildSettings(req.guildId);
        res.json({ success: true, message: 'Guild initialized successfully' });
    } catch (err) {
        console.error('[API Router Error] POST /init:', err.message);
        res.status(500).json({ error: 'Initialization Failed' });
    }
});

// ============================================================================
// 3. CUSTOM EMBED BUILDER (Dashboard Page: custom-messages.html)
// ============================================================================
// Deliberately NOT using the generic /guild/:guildId/:tableName routes
// (Section 4 below) for custom_embed_draft, even though it follows the same
// "one row per guild" pattern, for two reasons:
//   1) The generic PUT only runs queries.universalUpdate() (a plain UPDATE,
//      assuming the row already exists via init_guild_settings).
//      custom_embed_draft is NOT part of init_guild_settings, so the first
//      Save for any guild would silently affect 0 rows. customEmbed ->
//      saveDraft() performs a real upsert instead.
//   2) The generic GET doesn't apply the draft's 24-hour expiry check, nor
//      validate values (Discord color/embed limits) - both handled inside
//      custom.js.
//
// Publishing needs no extra middleware here - customEmbed.publishDraft()
// sends directly through the Discord REST API using the bot token
// (process.env.DISCORD_TOKEN), the same way discordFetch() already works
// in apiServer.js.
//
// ⚠️ IMPORTANT: this section (and any other literal-path route added later)
// MUST stay registered ABOVE the generic Universal Sync routes in Section 4.
// Express matches routes in registration order, and /guild/:guildId/:tableName
// matches ANY 3-segment path - including this one - so if this section were
// ever moved below Section 4 again, it would silently stop working exactly
// like it did before the v3.1 fix.

/**
 * GET /api/guild/:guildId/custom-embed-draft
 * Returns the current draft (or an empty shape if expired/missing).
 */
router.get('/guild/:guildId/custom-embed-draft', requireGuildId, async (req, res) => {
    try {
        const draft = await customEmbed.getDraft(req.guildId);
        res.json(draft);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/custom-embed-draft:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * PUT /api/guild/:guildId/custom-embed-draft
 * Expected body: { updates: { outsideText, embedTitle, embedDescription,
 *                              embedColor, embedFields }, editorUserId }
 */
router.put('/guild/:guildId/custom-embed-draft', requireGuildId, async (req, res) => {
    try {
        const { updates, editorUserId } = req.body;

        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Invalid Payload: "updates" object required' });
        }

        const result = await customEmbed.saveDraft(req.guildId, updates, editorUserId || null);

        if (!result.success) {
            // These are error CODES, not ready-made display strings - see
            // the note inside custom.js.
            return res.status(400).json({ success: false, errors: result.errors });
        }

        res.json({ success: true, data: result.draft });
    } catch (err) {
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/custom-embed-draft:`, err.message);
        res.status(500).json({ error: 'Failed to update database' });
    }
});

/**
 * POST /api/guild/:guildId/custom-embed-draft/publish
 * Expected body: { channelId, publisherUserId }
 */
router.post('/guild/:guildId/custom-embed-draft/publish', requireGuildId, async (req, res) => {
    try {
        const { channelId, publisherUserId } = req.body;

        if (!channelId) {
            return res.status(400).json({ error: 'Missing Required Parameter: channelId' });
        }

        const result = await customEmbed.publishDraft({
            guildId: req.guildId,
            channelId,
            publisherUserId: publisherUserId || null
        });

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        res.json({ success: true, messageId: result.messageId, channelId: result.channelId });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/custom-embed-draft/publish:`, err.message);
        res.status(500).json({ error: 'Failed to publish embed' });
    }
});

// ============================================================================
// 4. UNIVERSAL SYNC ROUTES (Smart Binding - generic catch-all, MUST stay LAST)
// ============================================================================
// ⚠️ Any new specific/literal-path route must be added ABOVE this block, not
// below it. These two routes match ANY single extra path segment after
// :guildId, so they will silently swallow requests meant for a more specific
// route registered after them - this was the exact bug fixed in v3.1 for
// custom-embed-draft.

/**
 * GET /api/guild/:guildId/:tableName
 * Matches the dashboard's fetch: fetch(`${API_BASE}/guild/${guildId}/${path}`)
 *
 * [v3.2] No code change needed here for the multi-row fix: universalGet()
 * now returns an array for tables like role_delay_config instead of a
 * single object, and `result || {}` already passes an array through as-is
 * (arrays are truthy in JS regardless of length), so callers on the
 * dashboard just need to handle an array response for those specific
 * tables - same endpoint, same handler.
 */
router.get('/guild/:guildId/:tableName', requireGuildId, async (req, res) => {
    try {
        const { tableName, guildId } = req.params;
        const result = await queries.universalGet(tableName, guildId);
        res.json(result || {});
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/${req.params.tableName}:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * PUT /api/guild/:guildId/:tableName
 * Matches the dashboard's save request (PUT)
 *
 * [v3.2] universalUpdate() now throws a dedicated MULTI_ROW_UNSUPPORTED
 * error for tables like role_delay_config instead of running a blind
 * UPDATE keyed only on id_guild (which would have overwritten every row
 * for that guild with the same values). Caught below and surfaced as a
 * clear 400 instead of a generic 500.
 */
router.put('/guild/:guildId/:tableName', requireGuildId, async (req, res) => {
    try {
        const { tableName, guildId } = req.params;
        const { updates } = req.body;

        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Invalid Payload: "updates" object required' });
        }

        const result = await queries.universalUpdate(tableName, guildId, updates);
        res.json({ success: true, data: result });
    } catch (err) {
        if (err.code === 'MULTI_ROW_UNSUPPORTED') {
            return res.status(400).json({ error: err.message });
        }
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/${req.params.tableName}:`, err.message);
        res.status(500).json({ error: 'Failed to update database' });
    }
});

module.exports = router;