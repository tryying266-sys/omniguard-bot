// ============================================================================
// roleSync.js - Dashboard Role Management (Exact-ID Sync, No Fuzzy Search)
// ============================================================================
// [v2] أضيف بارامتر reason + إشعارات roleadd/demote لكل رتبة تتغيّر (نفس
// القوالب المستخدمة أصلاً بـ roleadd.js) - كان الملف يطبّق التغيير
// بصمت بدون أي DM أو رسالة قناة، الحين يطابق سلوك أوامر الشات.

/**
 * CORE LOGIC: syncMemberRoles
 * @param {import('discord.js').Guild} guild
 * @param {string} targetId
 * @param {string[]} desiredRoleIds
 * @param {import('discord.js').User} moderator
 * @param {Object} dbUtils
 * @param {?string} reason - سبب التغيير (يُستخدم باللوق وبكل إشعار)
 * @param {?import('discord.js').Channel} channel
 */
async function syncMemberRoles(guild, targetId, desiredRoleIds, moderator, dbUtils, reason = null, channel = null) {
    try {
        const targetMember = await guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) return { success: false, error: "Member not found in this server." };

        const botMember = guild.members.me;
        const finalReason = reason || 'No reason provided';

        const currentRoleIds = targetMember.roles.cache
            .filter(r => r.id !== guild.id)
            .map(r => r.id);

        const desired = new Set(desiredRoleIds || []);
        const current = new Set(currentRoleIds);

        const toAdd = [...desired].filter(id => !current.has(id));
        const toRemove = [...current].filter(id => !desired.has(id));

        const added = [];
        const removed = [];
        const skipped = [];

        for (const roleId of [...toAdd, ...toRemove]) {
            const role = guild.roles.cache.get(roleId);
            if (!role) { skipped.push(roleId); continue; }
            if (!role.editable || botMember.roles.highest.position <= role.position) {
                skipped.push(roleId);
                continue;
            }
        }

        const { notifyCommandExecution } = require('./commandNotifications');

        for (const roleId of toAdd) {
            if (skipped.includes(roleId)) continue;
            try {
                const role = guild.roles.cache.get(roleId);
                await targetMember.roles.add(roleId, `Dashboard: Role sync by ${moderator?.tag || 'Dashboard'} | ${finalReason}`);
                added.push(roleId);

                // [NEW] نفس إشعار roleadd.js بالضبط
                try {
                    await notifyCommandExecution({
                        guild, targetMember, moderator, channel,
                        action: 'roleadd', reason: finalReason, roleName: role?.name || 'Unknown Role', duration: null
                    });
                } catch (notifyErr) {
                    console.error('[RoleSync] roleadd notification failed:', notifyErr.message);
                }
            } catch (err) {
                console.error(`[RoleSync Error] Failed to add role ${roleId}:`, err.message);
                skipped.push(roleId);
            }
        }

        for (const roleId of toRemove) {
            if (skipped.includes(roleId)) continue;
            try {
                const role = guild.roles.cache.get(roleId);
                await targetMember.roles.remove(roleId, `Dashboard: Role sync by ${moderator?.tag || 'Dashboard'} | ${finalReason}`);
                removed.push(roleId);

                // [NEW] نفس إشعار "Demote" الموجود أصلاً بـ roleadd.js
                try {
                    await notifyCommandExecution({
                        guild, targetMember, moderator, channel,
                        action: 'demote', reason: finalReason, roleName: role?.name || 'Unknown Role', duration: null
                    });
                } catch (notifyErr) {
                    console.error('[RoleSync] demote notification failed:', notifyErr.message);
                }
            } catch (err) {
                console.error(`[RoleSync Error] Failed to remove role ${roleId}:`, err.message);
                skipped.push(roleId);
            }
        }

        if ((added.length > 0 || removed.length > 0) && dbUtils?.addInfraction) {
            const summary = `Roles synced via Dashboard | Added: ${added.length} | Removed: ${removed.length}`;
            try {
                await dbUtils.addInfraction(
                    guild.id, targetId, moderator?.id || null, 'roleadd',
                    reason ? `${summary} | Reason: ${reason}` : summary,
                    null, targetMember.user.tag
                );
            } catch (logErr) {
                console.error('[RoleSync] addInfraction failed:', logErr.message);
            }
        }

        return { success: true, added, removed, skipped };

    } catch (err) {
        console.error('[RoleSync Engine Error]:', err);
        return { success: false, error: "Internal error during role sync." };
    }
}

module.exports = {
    syncMemberRoles
};