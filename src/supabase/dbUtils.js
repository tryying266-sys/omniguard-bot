// ============================================================================
// dbUtils.js - Database Utility Wrapper (v3.2 - FIXED: Spread Override Order)
// ============================================================================
// This file is the bridge between the bot's commands/events and the
// databaseQueries.js layer.
//
// [FIX v3.1 - kept] addInfraction()/logDashboardAction() key-mapping fix, and
//       the new addLogIndex() function - both untouched in this pass, see
//       the comments still attached to each of them below.
//
// [FIX v3.2 - new, this pass] Spread-override bug (object literal key order):
//       The old file ended with:
//           module.exports = {
//               universalGet: queries.universalGet,
//               universalUpdate: queries.universalUpdate,
//               async getGuildSettings(...) {...},
//               ...
//               async addWarning(...) {...},
//               async pingDatabase() {...},
//               ...queries   // <-- spread was LAST
//           };
//       In a JS object literal, when the same key is written more than
//       once, the LAST occurrence wins - regardless of whether it came from
//       an explicit property or a spread. Since `...queries` was placed at
//       the very end, any key it also defines silently overwrote the
//       hand-written version above it.
//
//       Concrete, confirmed breakage: addWarning().
//       This file's own addWarning(guildId, userId, reason, moderatorId,
//       expiresAt) is a POSITIONAL wrapper that packs those 5 arguments
//       into the object shape databaseQueries.js's addWarning() actually
//       expects. But because `...queries` came after it in the object
//       literal, the final exported `addWarning` was actually
//       queries.addWarning itself (the object-destructuring version) - so
//       every call site using the positional form
//       `dbUtils.addWarning(guildId, userId, reason, moderatorId, expiresAt)`
//       was really calling `queries.addWarning(guildId, ...)`, which
//       immediately destructures its FIRST argument (a plain string, guildId)
//       expecting { guildId, userId, reason, moderatorId, expiresAt } on it.
//       Destructuring a string like that yields undefined for every field,
//       so every warning ever inserted through dbUtils.addWarning() was
//       silently written with id_guild/id_user/reason/id_moderator/at_expires
//       all undefined - no crash, no console error, just broken data.
//
//       universalGet / universalUpdate / pingDatabase also collide with
//       queries' own exports, but harmlessly - both sides point to the
//       exact same underlying behavior, so the override made no functional
//       difference for those three specifically. addWarning was the one
//       real casualty.
//
//       Fix: `...queries` now comes FIRST in the object literal, acting as
//       the base/default export set. Every hand-written function below it
//       (universalGet, universalUpdate, getGuildSettings, getAltAntiSettings,
//       getAutoModSettings, addInfraction, logDashboardAction, addLogIndex,
//       addWarning, saveMemberRoles, restoreMemberRoles, pingDatabase) is
//       now guaranteed to win, because later keys always win in an object
//       literal - this is now true "by construction" instead of by
//       coincidence, so it can't regress again just by adding a new
//       property to either file. Any function exported ONLY by
//       databaseQueries.js (logCommand, logModerationAction, logDashboardAudit,
//       addSuspectedAlt, backupMemberRoles, getBackupRoles, deleteBackupRoles,
//       initGuildSettings) still passes through untouched, exactly as
//       before - nothing else changed.
// ============================================================================

const queries = require('./databaseQueries');
const supabase = require('./db');

module.exports = {
    // ============================================
    // 0. BASE EXPORT SET (must stay FIRST)
    // ============================================
    // [FIXED v3.2] Spreading here first means every hand-written function
    // below always overrides its databaseQueries.js counterpart by name
    // (logCommand, logModerationAction, logDashboardAudit, addSuspectedAlt,
    // backupMemberRoles, getBackupRoles, deleteBackupRoles, initGuildSettings
    // pass through untouched since nothing below redefines them).
    ...queries,

    // ============================================
    // 1. UNIVERSAL PROXY (Universal Engine - Smart Binding)
    // ============================================
    universalGet: queries.universalGet,
    universalUpdate: queries.universalUpdate,

    /**
     * Specialized: Fetch Main Guild Settings
     */
    async getGuildSettings(guildId) {
        return await queries.universalGet('setting_guild', guildId);
    },

    /**
     * Specialized: Fetch Anti-Alt Settings
     */
    async getAltAntiSettings(guildId) {
        return await queries.universalGet('setting_alt_anti', guildId);
    },

    /**
     * Specialized: Fetch Auto-Mod/Security Settings
     */
    async getAutoModSettings(guildId) {
        return await queries.universalGet('setting_moderation_security', guildId);
    },

    /**
     * Record a Moderation Infraction
     * Used by: ban, kick, mute, warn commands.
     *
     * [FIX v3.1 - kept] Calls queries.logModerationAction() with camelCase
     * keys matching its real signature: { guildId, targetId, targetUsername,
     * moderatorId, actionType, reason, duration }.
     *
     * Call signature from command files is unchanged (same positional order
     * as before): dbUtils.addInfraction(guildId, targetId, moderatorId,
     * actionType, reason, duration). targetUsername was added as an
     * optional trailing parameter only (non-breaking).
     */
    async addInfraction(guildId, targetId, moderatorId, actionType, reason, duration = null, targetUsername = null) {
        return await queries.logModerationAction({
            guildId,
            targetId,
            targetUsername,
            moderatorId,
            actionType, // must be one of: ban, kick, mute, warn, unmute, unban
            reason: reason || 'No reason provided',
            duration: duration ? String(duration) : null
        });
    },

    /**
     * Record a Dashboard Action (Audit Log)
     * Used by: server.js (guildMemberAdd/Remove), Dashboard API.
     *
     * [FIX v3.1 - kept] Calls queries.logDashboardAudit() with camelCase
     * keys matching its real signature: { guildId, userId, description,
     * statePrevious, stateNew }. External call signature is unchanged.
     */
    async logDashboardAction(guildId, userId, actionType, description, statePrevious = null, stateNew = null) {
        return await queries.logDashboardAudit({
            guildId,
            userId,
            description: `${String(actionType).toUpperCase()}: ${description}`,
            statePrevious,
            stateNew
        });
    },

    /**
     * [v3.1 - kept] Record a Log Index entry
     * Used by: mute.js, warn.js, kick.js, ban.js
     * Links the command-execution message.id to the guild/channel/target and
     * action type, for later indexing/traceability.
     *
     * Never breaks the calling flow: any error (e.g. table doesn't exist
     * yet) is only logged to the console and returns null - never thrown -
     * matching the same philosophy as the other logging functions in
     * databaseQueries.js (logCommand, addWarning...).
     *
     * @param {string} guildId
     * @param {string} messageId - the id of the message that ran the command (message.id)
     * @param {string} channelId
     * @param {string} targetId - the id of the member the action was taken against
     * @param {string} actionType - ban | kick | mute | unmute | warn | unban
     */
    async addLogIndex(guildId, messageId, channelId, targetId, actionType) {
        try {
            const { error } = await supabase
                .from('log_index_message') // ⚠️ adjust the table name here if yours differs
                .insert({
                    id_guild: guildId,
                    id_message: messageId,
                    id_channel: channelId,
                    id_target: targetId,
                    action_type: actionType
                });

            if (error) {
                console.error('[Database Error] addLogIndex:', error.message);
                return null;
            }
            return true;
        } catch (err) {
            console.error('[Database Error] addLogIndex (exception):', err.message);
            return null;
        }
    },

    /**
     * Warning System Bridge
     * [FIXED v3.2] This positional-args wrapper is the whole point of the
     * fix above - it now reliably wins over queries.addWarning (which
     * expects a single destructured object) because ...queries is spread
     * FIRST in this file's export object, not last.
     */
    async addWarning(guildId, userId, reason, moderatorId, expiresAt) {
        return await queries.addWarning({
            guildId,
            userId,
            reason,
            moderatorId,
            expiresAt
        });
    },

    /**
     * Backup Roles Logic
     */
    async saveMemberRoles(guildId, userId, roles) {
        return await queries.backupMemberRoles(guildId, userId, roles);
    },

    /**
     * Restore Roles Logic
     */
    async restoreMemberRoles(guildId, userId) {
        return await queries.getBackupRoles(guildId, userId);
    },

    /**
     * Connectivity Check
     */
    async pingDatabase() {
        return await queries.pingDatabase();
    }
};