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
const dbUtils = require('./dbUtils');
const { isMemberCommandExempt } = require('../commands/GRS');
const { syncMemberRoles } = require('../commands/roleSync');
const { PermissionsBitField } = require('discord.js');
// [SECURITY REWRITE] نفس ميدلوير الصلاحيات المستخدم بـ apiServer.js - تطبيق
// موحّد واحد، بدل نسخة محلية مكررة هنا.
const { requireDiscordPermission } = require('./authMiddleware');
// [NEW] apiRouter.js موجود بـ src/supabase/ - نفس مجلد db.js، فالمسار ./db
// (مطلوب للحظر الرجعي الفوري لعضو الطاقم بمسار ticket-blacklist تحت).
const supabase = require('./db');

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

/**
 * [NEW] Small local duration parser (نفس صيغة "Ns/Nm/Nh/Nd/Nw" المستخدمة
 * بـ ban.js/mute.js) - يُستخدم فقط بـ endpoints الاستثناءات بالأسفل.
 * يرجّع ISO timestamp، أو null لو المدخل فاضي/غير صالح (يعني دائم).
 */
function parseDurationToTimestamp(input) {
    if (!input) return null;
    const match = String(input).trim().toLowerCase().match(/^(\d+)\s*(s|min|m|h|d|w|mo|y)$/);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const msMap = { s: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000, w: 604800000, mo: 2592000000, y: 31536000000 };
    const ms = amount * (msMap[unit] || 0);
    if (!ms) return null;

    return new Date(Date.now() + ms).toISOString();
}



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
router.get('/guild/:guildId/alt-anti/logs', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
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
router.post('/guild/:guildId/alt-anti/action', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
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
router.post('/guild/:guildId/alt-anti/undo', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
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
router.post('/guild/:guildId/init', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
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
router.get('/guild/:guildId/custom-embed-draft', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
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
router.put('/guild/:guildId/custom-embed-draft', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
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
router.post('/guild/:guildId/custom-embed-draft/publish', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
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
// 3.5 AUTO-MOD DYNAMIC INFRACTION RULES (Dashboard Page: auto-mod.html) [v5.3]
// ============================================================================
// auto_mod_rule_config stores several rows per guild (multiple thresholds per
// rule_type: warn/mute/kick) - same reason as custom_embed_draft above, this
// cannot go through the generic Universal Sync routes in Section 4, which
// explicitly refuse multi-row tables (see databaseQueries.js's
// MULTI_ROW_TABLES check inside universalUpdate()).
//
// ⚠️ Registered here (ABOVE Section 4) for the exact same route-shadowing
// reason documented at the top of this file: GET/POST /guild/:guildId/
// auto-mod-rules are 3-path-segment URLs, same shape as the generic
// /guild/:guildId/:tableName catch-all, so this section would silently stop
// working if it were ever moved below Section 4.
//
// Each rule row is saved/deleted individually and immediately from the
// dashboard (no batch "Save Changes" for this section) - PUT/DELETE target
// a specific :ruleId, POST creates a new row. This avoids re-purposing
// buildPayload()/collectTags() (built for single-row "settings" tables) for
// something they were never designed to express.

/**
 * GET /api/guild/:guildId/auto-mod-rules
 * Returns ALL rules for the guild (every rule_type together), sorted by
 * threshold ascending. The dashboard buckets them into the three containers
 * (warn/mute/kick) client-side by each row's rule_type.
 */
router.get('/guild/:guildId/auto-mod-rules', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const rules = await queries.getAutoModRules(req.guildId);
        res.json(rules);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/auto-mod-rules:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/guild/:guildId/auto-mod-rules
 * Creates a new rule. Expected body: { ruleType, threshold, action, duration }
 */
router.post('/guild/:guildId/auto-mod-rules', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { ruleType, threshold, action, duration } = req.body;

        if (!['warn', 'mute', 'kick'].includes(ruleType)) {
            return res.status(400).json({ error: 'Invalid Payload: ruleType must be warn, mute, or kick' });
        }
        const parsedThreshold = parseInt(threshold, 10);
        if (!Number.isInteger(parsedThreshold) || parsedThreshold < 1 || parsedThreshold > 50) {
            return res.status(400).json({ error: 'Invalid Payload: threshold must be an integer between 1 and 50' });
        }
        if (!action || typeof action !== 'string') {
            return res.status(400).json({ error: 'Invalid Payload: action is required' });
        }

        const rule = await queries.addAutoModRule({
            guildId: req.guildId,
            ruleType,
            threshold: parsedThreshold,
            action,
            duration: duration || null
        });

        res.json({ success: true, rule });
    } catch (err) {
        // 23505 = UNIQUE(id_guild, rule_type, threshold) violation.
        // 23514 = CHECK violation (action doesn't match rule_type, or a
        // duration was sent alongside action='kick').
        if (err.code === '23505') {
            return res.status(409).json({ error: 'A rule for this exact threshold already exists for this type.' });
        }
        if (err.code === '23514') {
            return res.status(400).json({ error: 'Invalid action for this rule type, or a duration was set for a Kick action.' });
        }
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/auto-mod-rules:`, err.message);
        res.status(500).json({ error: 'Failed to create rule' });
    }
});

/**
 * PUT /api/guild/:guildId/auto-mod-rules/:ruleId
 * Updates an existing rule (partial - only send the fields that changed).
 * Expected body: { threshold?, action?, duration? }
 */
router.put('/guild/:guildId/auto-mod-rules/:ruleId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { threshold, action, duration } = req.body;
        const updates = {};

        if (threshold !== undefined) {
            const parsedThreshold = parseInt(threshold, 10);
            if (!Number.isInteger(parsedThreshold) || parsedThreshold < 1 || parsedThreshold > 50) {
                return res.status(400).json({ error: 'Invalid Payload: threshold must be an integer between 1 and 50' });
            }
            updates.threshold = parsedThreshold;
        }
        if (action !== undefined) updates.action = action;
        if (duration !== undefined) updates.duration = duration || null;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'Invalid Payload: at least one of threshold/action/duration is required' });
        }

        const rule = await queries.updateAutoModRule(req.params.ruleId, req.guildId, updates);
        if (!rule) {
            return res.status(404).json({ error: 'Rule not found for this guild' });
        }
        res.json({ success: true, rule });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'A rule for this exact threshold already exists for this type.' });
        }
        if (err.code === '23514') {
            return res.status(400).json({ error: 'Invalid action for this rule type, or a duration was set for a Kick action.' });
        }
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/auto-mod-rules/${req.params.ruleId}:`, err.message);
        res.status(500).json({ error: 'Failed to update rule' });
    }
});

/**
 * DELETE /api/guild/:guildId/auto-mod-rules/:ruleId
 */
router.delete('/guild/:guildId/auto-mod-rules/:ruleId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        await queries.deleteAutoModRule(req.params.ruleId, req.guildId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] DELETE /guild/${req.params.guildId}/auto-mod-rules/${req.params.ruleId}:`, err.message);
        res.status(500).json({ error: 'Failed to delete rule' });
    }
});
// [SECURITY REWRITE] كان فيه هنا route مكرر حرفياً (نفس المسار DELETE
// معرّف مرتين متتاليتين) - كود ميت (Express يستخدم أول تعريف بس). اتحذف
// التكرار، وما تغيّر أي سلوك فعلي - كانت النسخة الثانية غير قابلة للتنفيذ
// أصلاً.

// ============================================================================
// 3.5.b AUTO RESPOND (v6.1 - Dashboard Page: AutoRespond.html)
// ============================================================================
// جدول جديد auto_respond_rules - عدة قواعد رد تلقائي لكل سيرفر، نفس بنية
// auto-mod-rules بالحرف (مسجّل هنا فوق الـ catch-all لنفس سبب route
// shadowing بالضبط - راجع الشرح بأعلى الملف). ⚠️ هذا مختلف تماماً عن
// ticket-auto-respond (قسم 3.6 تحت) - ذاك خاص برد داخل التذاكر بس، هذا
// رد عام على أي رسالة بالسيرفر.
//
// نفس فلسفة auto-mod-rules: كل صف يُضاف/يُحذف فوراً ومنفرد (POST/DELETE)
// من الواجهة. التعديل (PUT) يستخدمه زر "Save Changes" العام بالصفحة (يمر
// على كل الكروت المعدّلة ويرسل PUT واحد لكل كرت له id فعلي)، وأيضاً
// مفتاح Enable/Disable (PUT فوري لحقل enabled بس عند الضغط مباشرة).

const AUTO_RESPOND_MATCH_TYPES = ['exact', 'contains', 'starts', 'ends', 'regex', 'fuzzy'];

// يتحقق إن مصفوفة معينة (لو انبعتت أصلاً) مصفوفة نصوص فعلاً - يحمي من
// إرسال شي غير مصفوفة (كائن، رقم، إلخ) يوقع Supabase بخطأ 500 غامض بدل
// رسالة 400 واضحة.
function isValidTagArray(value) {
    return value === undefined || (Array.isArray(value) && value.every(v => typeof v === 'string'));
}

/**
 * GET /api/guild/:guildId/auto-respond
 * يرجّع كل قواعد الرد التلقائي للسيرفر.
 */
router.get('/guild/:guildId/auto-respond', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const rules = await queries.getAutoRespondRules(req.guildId);
        res.json(rules);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/auto-respond:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/guild/:guildId/auto-respond
 * ينشئ قاعدة جديدة. مفيش حقول مطلوبة إجبارياً بالجسم - زر "Add New Auto
 * Response" بالواجهة يرسل جسم فاضي {} فينشئ "كرت فاضي" فوري (قيم
 * افتراضية من databaseQueries.js) والمستخدم يعبّيه بعدها ويحفظ بـ PUT.
 * لو انبعتت حقول فعلية، تتفحّص بنفس قواعد PUT تحت.
 */
router.post('/guild/:guildId/auto-respond', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { triggerKeyword, matchType, cooldownSeconds, responseMessage, channelWhitelist, channelBlacklist, roleWhitelist, roleBlacklist, enabled } = req.body || {};

        if (matchType !== undefined && !AUTO_RESPOND_MATCH_TYPES.includes(matchType)) {
            return res.status(400).json({ error: `Invalid Payload: matchType must be one of ${AUTO_RESPOND_MATCH_TYPES.join(', ')}` });
        }
        if (cooldownSeconds !== undefined) {
            const parsedCooldown = parseInt(cooldownSeconds, 10);
            if (!Number.isInteger(parsedCooldown) || parsedCooldown < 0) {
                return res.status(400).json({ error: 'Invalid Payload: cooldownSeconds must be an integer >= 0' });
            }
        }
        if (!isValidTagArray(channelWhitelist) || !isValidTagArray(channelBlacklist) || !isValidTagArray(roleWhitelist) || !isValidTagArray(roleBlacklist)) {
            return res.status(400).json({ error: 'Invalid Payload: whitelist/blacklist fields must be arrays of strings' });
        }

        const rule = await queries.addAutoRespondRule({
            guildId: req.guildId,
            triggerKeyword,
            matchType,
            cooldownSeconds: cooldownSeconds !== undefined ? parseInt(cooldownSeconds, 10) : undefined,
            responseMessage,
            channelWhitelist,
            channelBlacklist,
            roleWhitelist,
            roleBlacklist,
            enabled
        });

        res.json({ success: true, rule });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/auto-respond:`, err.message);
        res.status(500).json({ error: 'Failed to create rule' });
    }
});

/**
 * PUT /api/guild/:guildId/auto-respond/:ruleId
 * تعديل جزئي - بس الحقول المُمرّرة بالجسم تتحدث. يُستخدم لكل من: زر
 * "Save Changes" العام (يرسل كل حقول الكرت المعدّل دفعة وحدة)، ومفتاح
 * Enable/Disable الفوري (يرسل { enabled } بس).
 */
router.put('/guild/:guildId/auto-respond/:ruleId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { triggerKeyword, matchType, cooldownSeconds, responseMessage, channelWhitelist, channelBlacklist, roleWhitelist, roleBlacklist, enabled } = req.body || {};
        const updates = {};

        if (triggerKeyword !== undefined) updates.trigger_keyword = triggerKeyword;
        if (matchType !== undefined) {
            if (!AUTO_RESPOND_MATCH_TYPES.includes(matchType)) {
                return res.status(400).json({ error: `Invalid Payload: matchType must be one of ${AUTO_RESPOND_MATCH_TYPES.join(', ')}` });
            }
            updates.match_type = matchType;
        }
        if (cooldownSeconds !== undefined) {
            const parsedCooldown = parseInt(cooldownSeconds, 10);
            if (!Number.isInteger(parsedCooldown) || parsedCooldown < 0) {
                return res.status(400).json({ error: 'Invalid Payload: cooldownSeconds must be an integer >= 0' });
            }
            updates.cooldown_seconds = parsedCooldown;
        }
        if (responseMessage !== undefined) updates.response_message = responseMessage;
        if (channelWhitelist !== undefined) {
            if (!isValidTagArray(channelWhitelist)) return res.status(400).json({ error: 'Invalid Payload: channelWhitelist must be an array of strings' });
            updates.channel_whitelist = channelWhitelist;
        }
        if (channelBlacklist !== undefined) {
            if (!isValidTagArray(channelBlacklist)) return res.status(400).json({ error: 'Invalid Payload: channelBlacklist must be an array of strings' });
            updates.channel_blacklist = channelBlacklist;
        }
        if (roleWhitelist !== undefined) {
            if (!isValidTagArray(roleWhitelist)) return res.status(400).json({ error: 'Invalid Payload: roleWhitelist must be an array of strings' });
            updates.role_whitelist = roleWhitelist;
        }
        if (roleBlacklist !== undefined) {
            if (!isValidTagArray(roleBlacklist)) return res.status(400).json({ error: 'Invalid Payload: roleBlacklist must be an array of strings' });
            updates.role_blacklist = roleBlacklist;
        }
        if (enabled !== undefined) updates.enabled = Boolean(enabled);

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'Invalid Payload: at least one field is required' });
        }

        const rule = await queries.updateAutoRespondRule(req.params.ruleId, req.guildId, updates);
        if (!rule) {
            return res.status(404).json({ error: 'Rule not found for this guild' });
        }
        res.json({ success: true, rule });
    } catch (err) {
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/auto-respond/${req.params.ruleId}:`, err.message);
        res.status(500).json({ error: 'Failed to update rule' });
    }
});

/**
 * DELETE /api/guild/:guildId/auto-respond/:ruleId
 */
router.delete('/guild/:guildId/auto-respond/:ruleId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        await queries.deleteAutoRespondRule(req.params.ruleId, req.guildId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] DELETE /guild/${req.params.guildId}/auto-respond/${req.params.ruleId}:`, err.message);
        res.status(500).json({ error: 'Failed to delete rule' });
    }
});

// ============================================================================
// 3.5.c LEVELING SYSTEM (v6.2 - Dashboard Page: Level.html)
// ============================================================================
// ⚠️ إعدادات تاب General (Global Multiplier, Cooldown, Growth System,
// Notification Destination, Mention Toggle, Whitelist/Blacklist Channels,
// Level Up Message) ما لها مسارات هنا إطلاقاً - كلها أعمدة على
// setting_leveling (صف واحد لكل سيرفر) وتمر تلقائياً عبر Smart Binding
// العام (/api/guild/:guildId/setting_leveling، موجود مسبقاً بالملف).
// هذا القسم يغطي بس الأجزاء اللي تحتاج منطق خاص: مضاعفات الرتب (متعدد
// الصفوف)، وMemory Override اليدوي (يحتاج جلب اسم/صورة العضو من ديسكورد
// نفسه + حساب المستوى عبر levelingFormulas.js).

const { getLevelFromTotalXp, xpForNextLevel, normalizeGrowthSystem } = require('./levelingFormulas');

// --- Role XP Multipliers (عدة صفوف - نفس نمط auto-respond بالحرف) ---

router.get('/guild/:guildId/role-xp-multipliers', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const rows = await queries.getRoleXpMultipliers(req.guildId);
        res.json(rows);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/role-xp-multipliers:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/guild/:guildId/role-xp-multipliers', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { roleId, multiplier } = req.body || {};
        const parsedMultiplier = parseFloat(multiplier);

        if (!roleId || typeof roleId !== 'string') {
            return res.status(400).json({ error: 'Invalid Payload: roleId is required' });
        }
        if (!Number.isFinite(parsedMultiplier) || parsedMultiplier <= 0) {
            return res.status(400).json({ error: 'Invalid Payload: multiplier must be a positive number' });
        }

        // Upsert (زر واحد "Add Multiplier" يغطي إضافة/تحديث - راجع تعليق
        // upsertRoleXpMultiplier بـ databaseQueries.js)
        const row = await queries.upsertRoleXpMultiplier(req.guildId, roleId, parsedMultiplier);
        res.json({ success: true, multiplier: row });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/role-xp-multipliers:`, err.message);
        res.status(500).json({ error: 'Failed to save role multiplier' });
    }
});

router.delete('/guild/:guildId/role-xp-multipliers/:roleId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        await queries.deleteRoleXpMultiplier(req.guildId, req.params.roleId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] DELETE /guild/${req.params.guildId}/role-xp-multipliers/${req.params.roleId}:`, err.message);
        res.status(500).json({ error: 'Failed to delete role multiplier' });
    }
});

// --- Tiered Ranks Brackets (فئات نظام Tiered - قابلة للتعديل بالكامل) ---

router.get('/guild/:guildId/tiered-xp-brackets', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const rows = await queries.getTieredBrackets(req.guildId);
        res.json(rows);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/tiered-xp-brackets:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/guild/:guildId/tiered-xp-brackets', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { maxLevel, xpPerLevel, label } = req.body || {};
        const parsedMaxLevel = parseInt(maxLevel, 10);
        const parsedXpPerLevel = parseInt(xpPerLevel, 10);

        if (!Number.isInteger(parsedMaxLevel) || parsedMaxLevel <= 0) {
            return res.status(400).json({ error: 'Invalid Payload: maxLevel must be a positive integer' });
        }
        if (!Number.isInteger(parsedXpPerLevel) || parsedXpPerLevel <= 0) {
            return res.status(400).json({ error: 'Invalid Payload: xpPerLevel must be a positive integer' });
        }

        const bracket = await queries.addTieredBracket(req.guildId, parsedMaxLevel, parsedXpPerLevel, label);
        res.json({ success: true, bracket });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'A bracket ending at this level already exists.' });
        }
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/tiered-xp-brackets:`, err.message);
        res.status(500).json({ error: 'Failed to create bracket' });
    }
});

router.delete('/guild/:guildId/tiered-xp-brackets/:bracketId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        await queries.deleteTieredBracket(req.params.bracketId, req.guildId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] DELETE /guild/${req.params.guildId}/tiered-xp-brackets/${req.params.bracketId}:`, err.message);
        res.status(500).json({ error: 'Failed to delete bracket' });
    }
});

// --- Manual Member XP Override ---

/**
 * GET /api/guild/:guildId/leveling/member/:userId
 * صندوق المعاينة تحت خانة User ID بالداشبورد - يرجّع اسم العضو + صورته من
 * ديسكورد نفسه (مو من القاعدة - لازم يكونوا حديثين 100%) + مستواه/نقاطه
 * الحالية من user_levels (صفر لو عضو جديد ما له سجل لسا - مو خطأ).
 */
router.get('/guild/:guildId/leveling/member/:userId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const client = require('../index');
        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) {
            return res.status(404).json({ error: 'Bot is not in this guild' });
        }

        const member = await guild.members.fetch(req.params.userId).catch(() => null);
        if (!member) {
            return res.status(404).json({ error: 'Member not found in this guild (check the ID, or they may have left)' });
        }

        const levelRow = await queries.getUserLevel(req.guildId, req.params.userId);
        const settings = await queries.universalGet('setting_leveling', req.guildId);
        const growthSystem = normalizeGrowthSystem(settings?.xp_growth_system);
        const tieredBrackets = (growthSystem === 'tiered') ? await queries.getTieredBrackets(req.guildId) : null;

        const level = levelRow?.level ?? 0;
        const xp = levelRow?.xp ?? 0;
        const totalXp = levelRow?.total_xp ?? 0;

        res.json({
            userId: member.id,
            username: member.user.username,
            displayName: member.displayName,
            avatarUrl: member.displayAvatarURL({ size: 64 }),
            level,
            xp,
            totalXp,
            xpForNextLevel: xpForNextLevel(level, growthSystem, tieredBrackets)
        });
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/leveling/member/${req.params.userId}:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/guild/:guildId/leveling/member/:userId/override
 * body: { mode: 'add' | 'remove' | 'set', amount: number }
 */
router.post('/guild/:guildId/leveling/member/:userId/override', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { mode, amount } = req.body || {};
        const parsedAmount = parseInt(amount, 10);

        if (!['add', 'remove', 'set'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid Payload: mode must be add, remove, or set' });
        }
        if (!Number.isInteger(parsedAmount) || parsedAmount < 0) {
            return res.status(400).json({ error: 'Invalid Payload: amount must be a non-negative integer' });
        }

        const client = require('../index');
        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) {
            return res.status(404).json({ error: 'Bot is not in this guild' });
        }
        const member = await guild.members.fetch(req.params.userId).catch(() => null);
        if (!member) {
            return res.status(404).json({ error: 'Member not found in this guild (check the ID, or they may have left)' });
        }

        const settings = await queries.universalGet('setting_leveling', req.guildId);
        const growthSystem = normalizeGrowthSystem(settings?.xp_growth_system);
        const tieredBrackets = (growthSystem === 'tiered') ? await queries.getTieredBrackets(req.guildId) : null;

        const updated = await queries.applyUserXpChange(req.guildId, req.params.userId, mode, parsedAmount, growthSystem, tieredBrackets);
        res.json({ success: true, member: updated });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/leveling/member/${req.params.userId}/override:`, err.message);
        res.status(500).json({ error: 'Failed to apply XP change' });
    }
});

// ============================================================================
// 3.6 TICKET SYSTEM (Dashboard Pages: category-embed.html, automation-logs.html)
// ============================================================================
// [CHANGED] كانت كل الاستعلامات هنا مباشرة عبر require('./db') (لحد ما
// وصلتني نسخة databaseQueries.js). الحين تنادي queries.* الجديدة (قسم 6
// بذاك الملف) - نفس نمط auto-mod-rules بالضبط، بدون أي تكرار منطق.
//
// ⚠️ نفس سبب تسجيل auto-mod-rules فوق Section 5: كل هالمسارات (ticket-
// settings, ticket-categories, ticket-blacklist, ticket-auto-respond)
// أجزاء مسارها تتراوح 3-4 أجزاء - لازم تبقى مسجّلة هنا فوق الـ catch-all
// العام، وإلا تنبلع بصمت بنفس الباج اللي انصلح لـ custom-embed-draft.

// ----------------------------------------------------------------------
// 3.6.a ticket-settings (صف واحد ثابت لكل سيرفر - نفس نمط custom-embed-draft)
// ----------------------------------------------------------------------

/**
 * GET /api/guild/:guildId/ticket-settings
 * يرجّع {} لو السيرفر لسا ما حفظ أي إعداد (بدل خطأ).
 */
router.get('/guild/:guildId/ticket-settings', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const settings = await queries.getTicketSettings(req.guildId);
        res.json(settings);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/ticket-settings:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * PUT /api/guild/:guildId/ticket-settings
 * Expected body: { updates: { panel_channel_id, panel_embed_title, ...,
 *                              auto_close_warn_minutes, ... } }
 */
router.put('/guild/:guildId/ticket-settings', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { updates } = req.body;

        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Invalid Payload: "updates" object required' });
        }

        const data = await queries.upsertTicketSettings(req.guildId, updates);

        // [NEW] لو انحفظت قناة الـ Panel (أو أي حقل ثاني يخصها)، نحدّث
        // رسالة الـ Panel الفعلية بديسكورد فوراً - best-effort: ما يفشّل
        // الحفظ لو تعذّر (البوت لسه ما جاهز/ما عنده صلاحية بالقناة).
        let panelResult = null;
        if (data.panel_channel_id) {
            try {
                const client = require('../index');
                const { postOrUpdatePanel } = require('../events/ticketPanel');
                if (client.isReady()) {
                    panelResult = await postOrUpdatePanel(client, req.guildId);
                }
            } catch (panelErr) {
                console.error(`[API Router Error] postOrUpdatePanel for guild ${req.guildId}:`, panelErr.message);
            }
        }

        res.json({ success: true, data, panel: panelResult });
    } catch (err) {
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/ticket-settings:`, err.message);
        res.status(500).json({ error: 'Failed to update database' });
    }
});

// ----------------------------------------------------------------------
// 3.6.b ticket-categories (ticket_type_config - عدة صفوف لكل سيرفر)
// ----------------------------------------------------------------------
// نفس بنية auto-mod-rules بالضبط: كل تصنيف يُحفظ/يُحذف فوراً ومنفرد من
// الداشبورد (بدون batch "Save Changes" عام لهذا الجزء تحديداً) - يطابق
// زر "+ Add Category" و "×" لكل Chip بصفحة category-embed.html اللي كل
// وحدة فيهم تنفذ فوراً بلحظتها، مو مع بقية حقول الصفحة دفعة وحدة.

/**
 * GET /api/guild/:guildId/ticket-categories
 * يرجّع كل الأنواع للسيرفر، الأحدث أولاً (نفس ترتيب categoryOrder
 * بالواجهة - الجديد فوق).
 */
router.get('/guild/:guildId/ticket-categories', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const categories = await queries.getTicketCategories(req.guildId);
        res.json(categories);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/ticket-categories:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/guild/:guildId/ticket-categories
 * Expected body: { name, emoji?, categoryId?, channelBaseName?,
 *                   counterEnabled?, counterStart? }
 * باقي الحقول (embed/roles/copyable text) تُضاف بعدين عبر PUT - نفس
 * سلوك category.html: createNewCategory() يسوي POST بالاسم بس أول
 * شي، وباقي التفاصيل تتعبى من الفورم وتُحفظ لاحقاً.
 */
router.post('/guild/:guildId/ticket-categories', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { name, emoji, categoryId, channelBaseName, counterEnabled, counterStart } = req.body;

        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Invalid Payload: name is required' });
        }

        const parsedStart = parseInt(counterStart, 10);

        const category = await queries.addTicketCategory({
            guildId: req.guildId,
            name: name.trim(),
            emoji,
            categoryId,
            channelBaseName: (channelBaseName || 'ticket').trim(),
            counterEnabled,
            counterStart: parsedStart
        });

        res.json({ success: true, category });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/ticket-categories:`, err.message);
        res.status(500).json({ error: 'Failed to create category' });
    }
});

/**
 * PUT /api/guild/:guildId/ticket-categories/:typeId
 * تحديث جزئي - أي حقل موجود بـ updates ينحدّث بس هو (embed title/desc,
 * copyable text, mention_roles[], staff_roles[], restricted_roles[],
 * button_label/emoji/style, channel_base_name, counter_*, category_id).
 */
router.put('/guild/:guildId/ticket-categories/:typeId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { updates } = req.body;

        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Invalid Payload: "updates" object required' });
        }

        const category = await queries.updateTicketCategory(req.params.typeId, req.guildId, updates);
        if (!category) return res.status(404).json({ error: 'Category not found for this guild' });

        res.json({ success: true, category });
    } catch (err) {
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/ticket-categories/${req.params.typeId}:`, err.message);
        res.status(500).json({ error: 'Failed to update category' });
    }
});

/**
 * DELETE /api/guild/:guildId/ticket-categories/:typeId
 * ⚠️ ما يمنع حذف آخر تصنيف من هنا (الفحص "لازم يبقى تصنيف واحد على
 * الأقل" موجود بالواجهة بس - category.html's deleteCategoryById). لو
 * احتجنا فرضها من السيرفر نفسه لاحقاً، تضاف هنا بسهولة (COUNT قبل الحذف).
 */
router.delete('/guild/:guildId/ticket-categories/:typeId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        await queries.deleteTicketCategory(req.params.typeId, req.guildId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] DELETE /guild/${req.params.guildId}/ticket-categories/${req.params.typeId}:`, err.message);
        res.status(500).json({ error: 'Failed to delete category' });
    }
});

// ----------------------------------------------------------------------
// 3.6.c ticket-blacklist (حظر عام من فتح التذاكر - صف واحد لكل مستخدم)
// ----------------------------------------------------------------------
// يُدار غالباً من أمر /ticket-blacklist بالديسكورد (ticketsystem.js) -
// هالمسارات هنا تغطي عرضه/تعديله من الداشبورد كمان (نفس فكرة exemptions
// بالأعلى - أمر بالشات + شاشة إدارة بالداشبورد للشي نفسه).

/**
 * GET /api/guild/:guildId/ticket-blacklist
 * يرجّع كل الحظورات الحالية (منتهية أو لأ - الفلترة بالتاريخ تصير
 * بالواجهة أو بالسكجولر، مو هنا).
 */
router.get('/guild/:guildId/ticket-blacklist', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const entries = await queries.getTicketBlacklist(req.guildId);
        res.json(entries);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/ticket-blacklist:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * PUT /api/guild/:guildId/ticket-blacklist/:userId
 * Expected body: { reason?, duration? } - نفس صيغة exemptions
 * (parseDurationToTimestamp المعرّفة أعلى بالملف). duration فاضي = دائم.
 */
router.put('/guild/:guildId/ticket-blacklist/:userId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { reason, duration } = req.body;
        const expiresAt = parseDurationToTimestamp(duration);

        const data = await queries.upsertTicketBlacklist({
            guildId: req.guildId,
            userId: req.params.userId,
            reason,
            bannedBy: req.dashboardUser?.discordId || null,
            expiresAt
        });

        // [NEW] لو المحظور عضو طاقم (رتبته موجودة بـ staff_roles لأي نوع
        // تكت بهالسيرفر)، الحظر يمتد فوراً ليشمل إخفاء كل التذاكر
        // المفتوحة حالياً عنه - مو بس منع فتح تذاكر جديدة (نفس السلوك
        // الافتراضي لأي مستخدم عادي، بدون تغيير).
        let retroactiveCount = 0;
        try {
            // [FIX] نفس نمط باقي الملف بالضبط - client يُستورد محلياً هنا
            // (require('../index')) مو كمتغير عام بأعلى الملف، تفادياً
            // لمشاكل circular dependency وقت تحميل الموديولات.
            let client = null;
            try { client = require('../index'); } catch (_) { /* البوت لسه ما اشتغل */ }

            if (client && client.isReady()) {
                const { data: types } = await supabase
                    .from('ticket_type_config')
                    .select('staff_roles')
                    .eq('id_guild', req.guildId);

                const guild = await client.guilds.fetch(req.guildId).catch(() => null);
                const member = guild ? await guild.members.fetch(req.params.userId).catch(() => null) : null;

                const isStaffMember = !!member && (types || []).some(t =>
                    (Array.isArray(t.staff_roles) ? t.staff_roles : []).some(roleId => member.roles.cache.has(roleId))
                );

                if (guild && isStaffMember) {
                    const { data: openTickets } = await supabase
                        .from('ticket_record')
                        .select('id_channel')
                        .eq('id_guild', req.guildId)
                        .eq('status', 'open');

                    for (const ticket of (openTickets || [])) {
                        const channel = await guild.channels.fetch(ticket.id_channel).catch(() => null);
                        if (channel) {
                            await channel.permissionOverwrites.edit(req.params.userId, { ViewChannel: false }).catch(() => {});
                            retroactiveCount++;
                        }
                    }
                }
            }
        } catch (retroErr) {
            console.error(`[API Router Error] Retroactive staff blacklist enforcement failed for guild ${req.guildId}:`, retroErr.message);
        }

        res.json({ success: true, data, retroactiveCount });
    } catch (err) {
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/ticket-blacklist/${req.params.userId}:`, err.message);
        res.status(500).json({ error: 'Failed to update ticket blacklist' });
    }
});

/**
 * DELETE /api/guild/:guildId/ticket-blacklist/:userId
 */
router.delete('/guild/:guildId/ticket-blacklist/:userId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        await queries.deleteTicketBlacklistEntry(req.guildId, req.params.userId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] DELETE /guild/${req.params.guildId}/ticket-blacklist/${req.params.userId}:`, err.message);
        res.status(500).json({ error: 'Failed to remove ticket blacklist entry' });
    }
});

// ----------------------------------------------------------------------
// 3.6.d ticket-auto-respond (ticket_auto_respond - عدة صفوف لكل سيرفر)
// ----------------------------------------------------------------------
// نفس بنية auto-mod-rules/ticket-categories بالضبط - إضافة/حذف فوري لكل
// قاعدة لحالها من كرت "Automated Actions & Response Rules" بصفحة
// automation-logs.html.

/**
 * GET /api/guild/:guildId/ticket-auto-respond
 */
router.get('/guild/:guildId/ticket-auto-respond', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const rules = await queries.getTicketAutoRespond(req.guildId);
        res.json(rules);
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/ticket-auto-respond:`, err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/guild/:guildId/ticket-auto-respond
 * Expected body: { triggerPhrase, responseText }
 */
router.post('/guild/:guildId/ticket-auto-respond', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { triggerPhrase, responseText } = req.body;

        if (!triggerPhrase || !String(triggerPhrase).trim()) {
            return res.status(400).json({ error: 'Invalid Payload: triggerPhrase is required' });
        }
        if (!responseText || !String(responseText).trim()) {
            return res.status(400).json({ error: 'Invalid Payload: responseText is required' });
        }

        const rule = await queries.addTicketAutoRespond({
            guildId: req.guildId,
            triggerPhrase: triggerPhrase.trim(),
            responseText: responseText.trim()
        });

        res.json({ success: true, rule });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/ticket-auto-respond:`, err.message);
        res.status(500).json({ error: 'Failed to create auto-respond rule' });
    }
});

/**
 * PUT /api/guild/:guildId/ticket-auto-respond/:ruleId
 */
router.put('/guild/:guildId/ticket-auto-respond/:ruleId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { triggerPhrase, responseText } = req.body;
        const updates = {};

        if (triggerPhrase !== undefined) {
            if (!String(triggerPhrase).trim()) {
                return res.status(400).json({ error: 'Invalid Payload: triggerPhrase cannot be empty' });
            }
            updates.trigger_phrase = triggerPhrase.trim();
        }
        if (responseText !== undefined) {
            if (!String(responseText).trim()) {
                return res.status(400).json({ error: 'Invalid Payload: responseText cannot be empty' });
            }
            updates.response_text = responseText.trim();
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'Invalid Payload: at least one of triggerPhrase/responseText is required' });
        }

        const rule = await queries.updateTicketAutoRespond(req.params.ruleId, req.guildId, updates);
        if (!rule) return res.status(404).json({ error: 'Rule not found for this guild' });

        res.json({ success: true, rule });
    } catch (err) {
        console.error(`[API Router Error] PUT /guild/${req.params.guildId}/ticket-auto-respond/${req.params.ruleId}:`, err.message);
        res.status(500).json({ error: 'Failed to update auto-respond rule' });
    }
});

/**
 * DELETE /api/guild/:guildId/ticket-auto-respond/:ruleId
 */
router.delete('/guild/:guildId/ticket-auto-respond/:ruleId', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        await queries.deleteTicketAutoRespond(req.params.ruleId, req.guildId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] DELETE /guild/${req.params.guildId}/ticket-auto-respond/${req.params.ruleId}:`, err.message);
        res.status(500).json({ error: 'Failed to delete auto-respond rule' });
    }
});

// ============================================================================
// 4. MEMBER PROFILE & MODERATION (Dashboard Page: user-profile.html)
// ============================================================================
// [NEW] كل الـ endpoints هنا تخص صفحة بحث الأعضاء وصفحة البروفايل. مسجلة
// فوق Section 5 (Universal Sync) لنفس سبب custom-embed-draft بالأعلى -
// بعض هالمسارات (زي /member/:userId/roles) لها نفس عدد الأجزاء اللي ممكن
// تتصادم مستقبلاً لو أي route عام جديد انضاف.
//
// [TEMP - قبل OAuth2] ما فيه لسا هوية مشرف حقيقية جاية من تسجيل دخول
// الداشبورد. الحل المؤقت المستخدم بكل نقاط التنفيذ تحت: نمرر عضوية البوت
// نفسه (guild.members.me) كـ "منفذ" placeholder لملفات الأوامر (ban.js/
// kick.js/warn.js/mute.js تتوقع كائن moderator بخصائص .id/.tag/.roles).
// هذا يخلي فحص التسلسل الهرمي المطبق أصلاً بكل ملف يشتغل بمنطقية (البوت
// غالباً أعلى من أغلب الأعضاء)، لكن يعني id_moderator باللوق هيسجل آيدي
// البوت مؤقتاً بدل المشرف الحقيقي. ⚠️ يُستبدل هذا فوراً بهوية المشرف
// الحقيقية بمجرد تفعيل OAuth2 - علامة واضحة بكل مكان يُستخدم فيه.

/**
 * Shared helper: يجهز guild + moderator placeholder، ويطبق فحص الاستثناء
 * (Command Exceptions) على العضو المستهدف قبل أي تنفيذ - نفس الفحص
 * الموجود أصلاً بـ commandhandler.js لمسار الشات، مطبق هنا يدوياً لأن
 * الداشبورد لا يمر عبر commandhandler إطلاقاً.
 */
// [SECURITY REWRITE] requireStaffRole (كانت تعتمد على role_level مخزّن
// بجدول dashboard_staff - قيمة تُحدد مرة وحدة وقت أول تسجيل دخول، وما
// تتحدث تلقائياً لو تغيّرت صلاحيات العضو الفعلية بديسكورد بعدين) اتحذفت
// نهائياً. كل الروتات بهذا الملف تستخدم الحين requireDiscordPermission
// (مستوردة فوق من authMiddleware.js) - تتحقق حياً من صلاحية العضو الفعلية
// بديسكورد وقت كل طلب، بدل قيمة قديمة ممكن تكون ما عادت تعكس الواقع.

async function resolveDashboardContext(guildId, targetId, res, commandName = null, dashboardUser = null) {
    const client = require('../index');
    if (!client.isReady()) {
        res.status(503).json({ error: 'Bot is not ready yet. Please try again in a moment.' });
        return null;
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
        res.status(404).json({ error: 'Bot is not in this guild' });
        return null;
    }

    // [FIXED] هوية المشرف الحقيقية بدل guild.members.me - مع fallback
    // احترازي (لو ما قدرنا نجيب عضويته بالسيرفر لأي سبب) عشان core actions
    // ما تطيح بخطأ غير متوقع.
    let moderator = guild.members.me;
    if (dashboardUser?.discordId) {
        const moderatorMember = await guild.members.fetch(dashboardUser.discordId).catch(() => null);
        if (moderatorMember) moderator = moderatorMember;
    }

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (targetMember) {
        const guildSettings = await dbUtils.getGuildSettings(guildId);
        if (await isMemberCommandExempt(guildSettings, targetMember, commandName)) {
            res.status(403).json({ error: "This member's role is exempt from bot commands." });
            return null;
        }
    }

    return { guild, moderator };
}

/**
 * GET /api/guild/:guildId/members/search?q=...
 * يستخدمها search.html/search.js للبحث الحي (Autocomplete). أقصى 10 نتائج.
 *
 * ⚠️ قيد معروف: بحث ديسكورد الأصلي (members.fetch({query})) يطابق فقط
 * "يبدأ بـ" (Prefix) على اليوزرنيم/النك، وما يدعم مطابقة أي جزء من الآيدي
 * إطلاقاً. لتغطية طلبك (يطابق أي جزء بأي مكان، بالاسم أو الآيدي)، هذا
 * الـ endpoint يجمع 3 مصادر: (1) مطابقة آيدي تام لو النص كامل رقمي،
 * (2) بحث Prefix الرسمي من ديسكورد، (3) فحص محلي على كاش الأعضاء
 * الموجودين فعلياً بذاكرة البوت وقت الطلب (best-effort - دقيق فقط للأعضاء
 * اللي البوت شافهم/كاشهم مسبقاً، مو كل أعضاء السيرفر بالضرورة على السيرفرات
 * الكبيرة). لو احتجنا دقة كاملة 100% لاحقاً، الحل هو جدول كاش أعضاء دائم
 * بالقاعدة (خيار "ب" اللي ناقشناه بالخطة) - مو مطلوب الآن.
 */
router.get('/guild/:guildId/members/search', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
    try {
        const query = String(req.query.q || '').trim();
        if (!query) return res.json([]);

        const client = require('../index');
        if (!client.isReady()) {
            return res.status(503).json({ error: 'Bot is not ready yet. Please try again in a moment.' });
        }

        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) return res.status(404).json({ error: 'Bot is not in this guild' });

        const results = new Map();
        const lowerQuery = query.toLowerCase();

        // 1) مطابقة آيدي تامة (لو النص كله أرقام بطول آيدي ديسكورد)
        if (/^\d{15,20}$/.test(query)) {
            const exactMember = await guild.members.fetch(query).catch(() => null);
            if (exactMember) {
                results.set(exactMember.id, {
                    id: exactMember.id,
                    username: exactMember.user.username,
                    avatarUrl: exactMember.user.displayAvatarURL({ size: 64 })
                });
            }
        }

        // 2) بحث ديسكورد الرسمي (Prefix على اليوزرنيم/النك)
        try {
            const prefixMatches = await guild.members.fetch({ query, limit: 10 });
            for (const member of prefixMatches.values()) {
                if (results.size >= 10) break;
                results.set(member.id, {
                    id: member.id,
                    username: member.user.username,
                    avatarUrl: member.user.displayAvatarURL({ size: 64 })
                });
            }
        } catch (searchErr) {
            console.error('[API Router] Member prefix search failed:', searchErr.message);
        }

        // 3) فحص محلي على الكاش الحالي (يغطي "أي جزء" بالاسم أو الآيدي)
        if (results.size < 10) {
            for (const member of guild.members.cache.values()) {
                if (results.size >= 10) break;
                if (results.has(member.id)) continue;
                const matchesId = member.id.includes(query);
                const matchesName = member.user.username.toLowerCase().includes(lowerQuery);
                if (matchesId || matchesName) {
                    results.set(member.id, {
                        id: member.id,
                        username: member.user.username,
                        avatarUrl: member.user.displayAvatarURL({ size: 64 })
                    });
                }
            }
        }

        res.json([...results.values()].slice(0, 10));
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/members/search:`, err.message);
        res.status(500).json({ error: 'Member search failed' });
    }
});

/**
 * GET /api/guild/:guildId/member/:userId/profile
 * يجمع كل بيانات صفحة user-profile.html بطلب واحد: بيانات حية من ديسكورد
 * (رتب، حالة ميوت/بان) + كل الجداول ذات الصلة من القاعدة بالتوازي.
 */
router.get('/guild/:guildId/member/:userId/profile', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
    try {
        const { userId } = req.params;
        const client = require('../index');
        if (!client.isReady()) {
            return res.status(503).json({ error: 'Bot is not ready yet. Please try again in a moment.' });
        }

        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) return res.status(404).json({ error: 'Bot is not in this guild' });

        const member = await guild.members.fetch(userId).catch(() => null);
        const banEntry = await guild.bans.fetch(userId).catch(() => null);

        const supabase = require('./db');

        const [
            { data: logs },
            { data: warnings },
            { data: levelData },
            { data: altsAsTarget },
            { data: backupRoles },
            { data: tempActions },
            { data: moderatorLogs }
        ] = await Promise.all([
            supabase.from('log_moderation').select('*').eq('id_guild', req.guildId).eq('id_target', userId).order('created_at', { ascending: false }).limit(50),
            supabase.from('warning_active').select('*').eq('id_guild', req.guildId).eq('id_user', userId).order('created_at', { ascending: false }),
            supabase.from('user_level_data').select('*').eq('id_guild', req.guildId).eq('id_user', userId).maybeSingle(),
            supabase.from('alt_suspected').select('*').eq('id_guild', req.guildId).eq('id_user', userId).order('at_detected', { ascending: false }),
            supabase.from('backup_role_member').select('*').eq('id_guild', req.guildId).eq('id_user', userId).maybeSingle(),
            supabase.from('temp_actions').select('*').eq('id_guild', req.guildId).eq('id_user', userId).eq('processed', false),
            supabase.from('log_moderation').select('*').eq('id_guild', req.guildId).eq('id_moderator', userId).order('created_at', { ascending: false }).limit(50)
        ]);

        const isMuted = !!(member?.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now());

        // [NEW] أعلى رتبة فعلية للعضو (discord.js يوفرها جاهزة) - null لو
        // ما عنده أي رتبة غير @everyone
        const highestRole = (member && member.roles.highest.id !== req.guildId) ? {
            id: member.roles.highest.id,
            name: member.roles.highest.name,
            color: member.roles.highest.color ? `#${member.roles.highest.color.toString(16).padStart(6, '0')}` : null
        } : null;

        res.json({
            profile: member ? {
                id: member.id,
                username: member.user.username,
                tag: member.user.tag,
                avatarUrl: member.user.displayAvatarURL({ size: 128 }),
                highestRole,
                roles: member.roles.cache.filter(r => r.id !== req.guildId).map(r => ({
                    id: r.id,
                    name: r.name,
                    color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null
                })),
                isMuted,
                mutedUntil: isMuted ? member.communicationDisabledUntil : null,
                isBanned: !!banEntry,
                inServer: true
            } : {
                id: userId,
                inServer: false,
                isBanned: !!banEntry,
                username: banEntry?.user?.username || null,
                avatarUrl: banEntry?.user ? banEntry.user.displayAvatarURL({ size: 128 }) : null
            },
            logs: logs || [],
            warnings: warnings || [],
            levelData: levelData || null,
            alts: altsAsTarget || [],
            backupRoles: backupRoles?.roles || [],
            activeTempActions: tempActions || [],
            moderatorLogs: moderatorLogs || []
        });
    } catch (err) {
        console.error(`[API Router Error] GET /guild/${req.params.guildId}/member/${req.params.userId}/profile:`, err.message);
        res.status(500).json({ error: 'Failed to load member profile' });
    }
});

/**
 * POST /api/guild/:guildId/member/:userId/kick
 * Expected body: { reason }
 */
router.post('/guild/:guildId/member/:userId/kick', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.KickMembers), async (req, res) => {
    try {
        const ctx = await resolveDashboardContext(req.guildId, req.params.userId, res, 'kick', req.dashboardUser);
        if (!ctx) return;

        const { executeKick } = require('../commands/kick');
        const result = await executeKick(ctx.guild, req.params.userId, ctx.moderator, req.body.reason || 'No reason provided', dbUtils);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[API Router Error] POST /member/${req.params.userId}/kick:`, err.message);
        res.status(500).json({ error: 'Failed to execute kick' });
    }
});

/**
 * POST /api/guild/:guildId/member/:userId/ban
 * Expected body: { reason, duration } - duration مثل "1d"/"perm" (نفس صيغة ban.js)
 */
router.post('/guild/:guildId/member/:userId/ban', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.BanMembers), async (req, res) => {
    try {
        const ctx = await resolveDashboardContext(req.guildId, req.params.userId, res, 'ban', req.dashboardUser);
        if (!ctx) return;

        const { executeBan } = require('../commands/ban');
        const result = await executeBan(ctx.guild, req.params.userId, ctx.moderator, req.body.duration || 'permanent', req.body.reason || 'No reason provided', dbUtils);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[API Router Error] POST /member/${req.params.userId}/ban:`, err.message);
        res.status(500).json({ error: 'Failed to execute ban' });
    }
});

/**
 * POST /api/guild/:guildId/member/:userId/unban
 * Expected body: { reason }
 */
router.post('/guild/:guildId/member/:userId/unban', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.BanMembers), async (req, res) => {
    try {
        const client = require('../index');
        if (!client.isReady()) return res.status(503).json({ error: 'Bot is not ready yet.' });
        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) return res.status(404).json({ error: 'Bot is not in this guild' });

        let moderator = guild.members.me;
        if (req.dashboardUser?.discordId) {
            const moderatorMember = await guild.members.fetch(req.dashboardUser.discordId).catch(() => null);
            if (moderatorMember) moderator = moderatorMember;
        }

        const { executeUnban } = require('../commands/ban');
        const result = await executeUnban(guild, req.params.userId, moderator, req.body.reason || 'No reason provided', dbUtils);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] POST /member/${req.params.userId}/unban:`, err.message);
        res.status(500).json({ error: 'Failed to execute unban' });
    }
});

/**
 * POST /api/guild/:guildId/member/:userId/mute
 * Expected body: { reason, duration } - duration مثل "1h"/"1d" (نفس صيغة mute.js)
 */
router.post('/guild/:guildId/member/:userId/mute', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
    try {
        const ctx = await resolveDashboardContext(req.guildId, req.params.userId, res, 'mute', req.dashboardUser);
        if (!ctx) return;

        const { executeMute } = require('../commands/mute');
        const result = await executeMute(ctx.guild, req.params.userId, ctx.moderator, req.body.duration, req.body.reason || 'No reason provided', dbUtils);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[API Router Error] POST /member/${req.params.userId}/mute:`, err.message);
        res.status(500).json({ error: 'Failed to execute mute' });
    }
});

/**
 * POST /api/guild/:guildId/member/:userId/unmute
 * Expected body: { reason }
 */
router.post('/guild/:guildId/member/:userId/unmute', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
    try {
        const ctx = await resolveDashboardContext(req.guildId, req.params.userId, res, 'unmute', req.dashboardUser);
        if (!ctx) return;

        const { executeUnmute } = require('../commands/mute');
        const result = await executeUnmute(ctx.guild, req.params.userId, ctx.moderator, req.body.reason || 'No reason provided', dbUtils);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true });
    } catch (err) {
        console.error(`[API Router Error] POST /member/${req.params.userId}/unmute:`, err.message);
        res.status(500).json({ error: 'Failed to execute unmute' });
    }
});

/**
 * POST /api/guild/:guildId/member/:userId/warn
 * Expected body: { reason }
 */
router.post('/guild/:guildId/member/:userId/warn', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
    try {
        const ctx = await resolveDashboardContext(req.guildId, req.params.userId, res, 'warn', req.dashboardUser);
        if (!ctx) return;

        const { executeWarn } = require('../commands/warn');
        const result = await executeWarn(ctx.guild, req.params.userId, ctx.moderator, req.body.reason || 'No reason provided', dbUtils);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[API Router Error] POST /member/${req.params.userId}/warn:`, err.message);
        res.status(500).json({ error: 'Failed to execute warn' });
    }
});

/**
 * POST /api/guild/:guildId/member/:userId/unwarn
 * Expected body: { reason }
 */
router.post('/guild/:guildId/member/:userId/unwarn', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
    try {
        const ctx = await resolveDashboardContext(req.guildId, req.params.userId, res, 'unwarn', req.dashboardUser);
        if (!ctx) return;

        // [FIX] زر "Clear Warnings" بالداشبورد لازم يمسح كل التحذيرات النشطة
        // دفعة وحدة - clearAllWarnings منفصلة تماماً عن executeUnwarn
        // (اللي بقيت مخصصة لأمر الشات !unwarn - حذف تحذير وحدة فقط).
        const { clearAllWarnings } = require('../commands/warn');
        const result = await clearAllWarnings(ctx.guild, req.params.userId, ctx.moderator, req.body.reason || 'Warnings cleared via Dashboard', dbUtils);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, clearedCount: result.clearedCount });
    } catch (err) {
        console.error(`[API Router Error] POST /member/${req.params.userId}/unwarn:`, err.message);
        res.status(500).json({ error: 'Failed to clear warnings' });
    }
});

/**
 * PUT /api/guild/:guildId/member/:userId/roles
 * Expected body: { roleIds: string[] } - القائمة الكاملة للرتب المطلوبة
 * بعد الحفظ (يعني state التاغات النهائي كامل، مو بس الفرق).
 */
router.put('/guild/:guildId/member/:userId/roles', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageRoles), async (req, res) => {
    try {
        const { roleIds, reason } = req.body;
        if (!Array.isArray(roleIds)) {
            return res.status(400).json({ error: 'Invalid Payload: "roleIds" must be an array' });
        }

        const ctx = await resolveDashboardContext(req.guildId, req.params.userId, res, 'roleadd', req.dashboardUser);
        if (!ctx) return;

        const result = await syncMemberRoles(ctx.guild, req.params.userId, roleIds, ctx.moderator, dbUtils, reason);

        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[API Router Error] PUT /member/${req.params.userId}/roles:`, err.message);
        res.status(500).json({ error: 'Failed to update roles' });
    }
});

/**
 * GET /api/guild/:guildId/member/:userId/exemptions
 * يرجع استثناءات الأوامر الحالية لهذا العضو من user_command_exemption
 * (v5.3 delta). لو ما فيه صف، أو الصف منتهي الصلاحية فعلياً، يرجع حالة
 * فاضية افتراضية - مو خطأ.
 */
router.get('/guild/:guildId/member/:userId/exemptions', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ModerateMembers), async (req, res) => {
    try {
        const supabase = require('./db');
        const { data, error } = await supabase
            .from('user_command_exemption')
            .select('*')
            .eq('id_guild', req.guildId)
            .eq('id_user', req.params.userId)
            .maybeSingle();

        if (error) throw error;

        const isExpired = data?.expires_at && new Date(data.expires_at).getTime() <= Date.now();

        res.json({
            commands: (data && !isExpired) ? (data.commands || []) : [],
            reason: (data && !isExpired) ? (data.reason || '') : '',
            expiresAt: (data && !isExpired) ? data.expires_at : null
        });
    } catch (err) {
        console.error(`[API Router Error] GET /member/${req.params.userId}/exemptions:`, err.message);
        res.status(500).json({ error: 'Failed to load command exemptions' });
    }
});

/**
 * PUT /api/guild/:guildId/member/:userId/exemptions
 * Expected body: { commands: string[], reason, duration }
 * duration بنفس صيغة ban.js/mute.js (مثل "7d"، "1h") - فاضي/غير صالح =
 * بدون انتهاء تلقائي (دائم). قائمة commands فاضية = حذف الصف بالكامل
 * (المشرف شال كل التاغات).
 */
router.put('/guild/:guildId/member/:userId/exemptions', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { commands, reason, duration } = req.body;
        if (!Array.isArray(commands)) {
            return res.status(400).json({ error: 'Invalid Payload: "commands" must be an array' });
        }

        const supabase = require('./db');

        if (commands.length === 0) {
            const { error: delError } = await supabase
                .from('user_command_exemption')
                .delete()
                .eq('id_guild', req.guildId)
                .eq('id_user', req.params.userId);

            if (delError) throw delError;
            return res.json({ success: true, commands: [], expiresAt: null });
        }

        const expiresAt = parseDurationToTimestamp(duration);

        const { data, error } = await supabase
            .from('user_command_exemption')
            .upsert({
                id_guild: req.guildId,
                id_user: req.params.userId,
                commands,
                reason: reason || null,
                granted_by: null, // TEMP - يُستبدل بهوية المشرف الحقيقية بعد OAuth2
                expires_at: expiresAt,
                processed: false,
                updated_at: new Date().toISOString()
            }, { onConflict: 'id_guild,id_user' })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, commands: data.commands, expiresAt: data.expires_at });
    } catch (err) {
        console.error(`[API Router Error] PUT /member/${req.params.userId}/exemptions:`, err.message);
        res.status(500).json({ error: 'Failed to update command exemptions' });
    }
});

/**
 * POST /api/guild/:guildId/staff/self-register
 * [NEW] تسجيل تلقائي بجدول dashboard_staff بناءً على صلاحية المستخدم
 * الفعلية بديسكورد نفسه (owner/Administrator/ManageGuild) - يستدعيها
 * dashboard.js تلقائياً بكل تحميل صفحة، بدل ما تحتاج INSERT يدوي لكل
 * حساب جديد.
 *
 * ⚠️ مصدر الحقيقة هو عضوية المستخدم الفعلية بالسيرفر (عبر البوت)، مو أي
 * صلاحية OAuth مرسلة من المتصفح - غير قابل للتلاعب من طرف العميل.
 *
 * ON CONFLICT DO NOTHING (ignoreDuplicates): لو المستخدم مسجّل مسبقاً
 * بمستوى مختلف (مثلاً owner عيّنه يدوياً moderator محدد لاحقاً بواجهة
 * إدارة طاقم لسه ما بنيناها)، ما نُرجعه لمستواه الافتراضي من ديسكورد كل
 * مرة يسجل دخول - أول تسجيل بس هو اللي يحدد القيمة.
 */
router.post('/guild/:guildId/staff/self-register', requireGuildId, async (req, res) => {
    try {
        if (!req.dashboardUser) {
            return res.status(401).json({ error: 'Unauthorized: No valid user session provided.' });
        }
        if (!req.dashboardUser.discordId) {
            return res.status(400).json({ error: 'Could not resolve your Discord identity from the session.' });
        }

        const client = require('../index');
        if (!client.isReady()) {
            return res.status(503).json({ error: 'Bot is not ready yet. Please try again in a moment.' });
        }

        const guild = await client.guilds.fetch(req.guildId).catch(() => null);
        if (!guild) return res.status(404).json({ error: 'Bot is not in this server.' });

        const member = await guild.members.fetch(req.dashboardUser.discordId).catch(() => null);
        if (!member) return res.status(403).json({ error: 'You are not a member of this Discord server.' });

        let roleLevel = null;
        if (member.id === guild.ownerId) {
            roleLevel = 'owner';
        } else if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            roleLevel = 'admin';
        } else if (
            member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
            member.permissions.has(PermissionsBitField.Flags.ModerateMembers)
        ) {
            roleLevel = 'moderator';
        }

        if (!roleLevel) {
            return res.status(403).json({ error: "You don't have sufficient Discord permissions to access this server's dashboard." });
        }

        const supabase = require('./db');
        const { error } = await supabase
            .from('dashboard_staff')
            .upsert({
                id_guild: req.guildId,
                supabase_uid: req.dashboardUser.supabaseUid,
                discord_user_id: req.dashboardUser.discordId,
                role_level: roleLevel
            }, { onConflict: 'id_guild,supabase_uid', ignoreDuplicates: true });

        if (error) throw error;

        res.json({ success: true, roleLevel });
    } catch (err) {
        console.error(`[API Router Error] POST /guild/${req.params.guildId}/staff/self-register:`, err.message);
        res.status(500).json({ error: 'Failed to register staff access' });
    }
});

// ============================================================================
// 5. UNIVERSAL SYNC ROUTES (Smart Binding - generic catch-all, MUST stay LAST)
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
router.get('/guild/:guildId/:tableName', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
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
router.put('/guild/:guildId/:tableName', requireGuildId, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
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