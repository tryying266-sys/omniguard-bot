// ============================================================================
// events/server.js - OmniGuard Event Handler (v3.1 - Unified AutoRole System)
// ============================================================================
// Handles core Discord events: Guild Join, Member Join, and Member Leave.
// Fully integrated with Smart Binding (IDs match SQL columns exactly).
// All system outputs and internal logic are in English.
//
// [MERGE v3.1] The old Role Restore system here used the wrong table/column
//       (setting_moderation_security.role_restore_on_rejoin) which was never
//       the real source of truth - the correct schema was always
//       setting_guild.autorole_enabled + the backup_role_member table
//       (previously living, unused, inside the standalone AutoRole.js file).
//       That standalone file was never required anywhere in index.js, so its
//       logic has been merged directly into this file and AutoRole.js has
//       been deleted to avoid two competing systems existing side by side.
// ============================================================================

const antiAlt = require('../commands/AntiAlt');
const supabase = require('../supabase/db');

// ----------------------------------------------------------------------
// AutoRole table/column names (merged from the old standalone AutoRole.js)
// ----------------------------------------------------------------------
const TABLE_BACKUP = 'backup_role_member';   // id_guild, id_user, roles (text[]), at_updated
const TABLE_SETTING = 'setting_guild';       // ... , autorole_enabled (boolean)

/**
 * Registers all server-side event listeners
 * @param {Object} client - Discord Client Instance
 * @param {Object} dbUtils - Universal Database Wrapper
 */
function registerServerEvents(client, dbUtils) {

    // ------------------------------------------------------------------
    // 1. BOT JOINS A NEW GUILD
    // ------------------------------------------------------------------
    client.on('guildCreate', async (guild) => {
        try {
            console.log(`[OmniGuard] Joined new guild: ${guild.name} (${guild.id})`);
            // Initialize all 5 settings tables for the new guild via RPC
            await dbUtils.initGuildSettings(guild.id);
            console.log(`[OmniGuard] Default settings initialized for: ${guild.name}`);
        } catch (error) {
            console.error(`[GuildCreate Error - ${guild.id}]:`, error.message);
        }
    });

    // ------------------------------------------------------------------
    // 2. MEMBER JOINS THE GUILD
    // ------------------------------------------------------------------
    client.on('guildMemberAdd', async (member) => {
        const guildId = member.guild.id;

        try {
            // --- A) ANTI-ALT SYSTEM ---
            // Table: setting_alt_anti
            // [FIX] كان هذا القسم فيه فحص بدائي مكتوب يدوياً هنا (عمر الحساب فقط،
            // ban/kick فقط، بدون mute) وما كان يستخدم AntiAlt.js إطلاقاً رغم إنه
            // جاهز وأقوى بكثير (نظام نقاط بـ10 أبعاد + Honeypot + mute يشتغل صح).
            // الآن نفوّض القرار بالكامل له، فيصير يقرأ كل أعمدة setting_alt_anti
            // المتقدمة الفعلية بدل ما تضل هياكل فارغة.
            await antiAlt.handleMemberJoin(member);

            // AntiAlt.js يطرد/يحظر داخلياً بدون ما يرجع لنا قيمة تدلنا هل نفّذ
            // إجراء أو لأ. فبدل الاعتماد على return داخل الملف نفسه، نتأكد هنا:
            // لو العضو صار مو موجود بالسيرفر (طرد/حظر) نوقف قبل رسالة الترحيب
            // والرتب التلقائية بالأسفل - بالضبط نفس سلوك الكود القديم بس بشكل
            // مستقل عن تفاصيل تنفيذ AntiAlt.js الداخلية.
            const stillInGuild = await member.guild.members.fetch(member.id).catch(() => null);
            if (!stillInGuild) return;

            // --- B) ROLE RESTORE SYSTEM (AutoRole) ---
            // Table: setting_guild (autorole_enabled) + backup_role_member
            // [MERGE v3.1] استبدلنا الفحص القديم الخاطئ (setting_moderation_security
            // .role_restore_on_rejoin) بالمصدر الصحيح: عمود autorole_enabled
            // بجدول setting_guild، وجدول backup_role_member للتخزين/الاسترجاع -
            // نفس الآلية اللي كانت مكتوبة بملف AutoRole.js المنفصل غير المفعّل.
            const autoRoleEnabled = await isAutoRoleEnabled(guildId);
            if (autoRoleEnabled) {
                await restoreRoleBackup(member);
            }

            // --- C) AUTO-ROLES SYSTEM ---
            // Table: setting_management_role
            const roleSettings = await dbUtils.universalGet('setting_management_role', guildId);
            if (roleSettings) {
                // [MOVED] "User Auto-Roles" كان هنا، لكن Rolemanagement.js
                // (assignAutoRoles) صار يتكفّل فيه، بالإضافة لجدولة إزالة
                // مؤقتة عبر role_delay_config/role_removal_schedule ما كانت
                // موجودة هنا إطلاقاً. إبقاء الاثنين كان سيضيف نفس الرتب
                // مرتين (نفس النتيجة النهائية لكن استدعاء API زايد بلا داعٍ).
                // Bot Auto-Roles
                if (member.user.bot && roleSettings.new_bot_auto_roles?.length > 0) {
                    await member.roles.add(roleSettings.new_bot_auto_roles).catch(() => {});
                }
                // Delayed Roles
                if (!member.user.bot && roleSettings.delayed_target_role && roleSettings.time_delayed) {
                    const delayMs = parseDurationToMs(roleSettings.time_delayed);
                    if (delayMs) {
                        setTimeout(async () => {
                            const stillMember = await member.guild.members.fetch(member.id).catch(() => null);
                            if (stillMember) {
                                await stillMember.roles.add(roleSettings.delayed_target_role).catch(() => {});
                            }
                        }, delayMs);
                    }
                }
            }

            // --- D) WELCOME MESSAGE SYSTEM ---
            // [MOVED] كان الإرسال هنا مباشرة، لكن welcome.js صار هو المسؤول
            // الوحيد عن هذا (نفس جدول setting_leave_welcome، بنسخة أغنى:
            // كرت صورة، متغيرات أكثر، فحص صلاحيات القناة). إبقاء الاثنين
          // كان سيرسل رسالة ترحيب + DM مكررين لكل عضو جديد.

            // Audit Log
            await dbUtils.logDashboardAction(guildId, member.id, 'join', `Member joined: ${member.user.tag}`);

        } catch (error) {
            console.error(`[guildMemberAdd Error - ${guildId}]:`, error);
        }
    });

    // ------------------------------------------------------------------
    // 3. MEMBER LEAVES THE GUILD
    // ------------------------------------------------------------------
    client.on('guildMemberRemove', async (member) => {
        const guildId = member.guild.id;

        try {
            // --- A) ROLE BACKUP (AutoRole) ---
            // Table: setting_guild (autorole_enabled) + backup_role_member
            // [MERGE v3.1] استبدلنا الحفظ القديم غير المشروط (dbUtils.saveMemberRoles
            // بدون فحص تفعيل، وبدون استثناء الرتب المُدارة) بمنطق AutoRole.js:
            // يحفظ فقط لو autorole_enabled مفعّل، ويستثني رتب @everyone والرتب
            // المُدارة تلقائياً (بوتات/بوستر/انتغريشن).
            const autoRoleEnabled = await isAutoRoleEnabled(guildId);
            if (autoRoleEnabled) {
                await saveRoleBackup(member);
            }

            // --- B) LEAVE MESSAGE ---
            // [MOVED] نفس السبب أعلاه: welcome.js (sendLeaveMessage) صار
            // المسؤول الوحيد عن هذا لتفادي رسالة مغادرة مكررة.

            // Audit Log
            await dbUtils.logDashboardAction(guildId, member.id, 'leave', `Member left: ${member.user?.tag || member.id}`);

        } catch (error) {
            console.error(`[guildMemberRemove Error - ${guildId}]:`, error.message);
        }
    });
}

// ============================================================================
// AUTOROLE HELPER FUNCTIONS (merged from the old standalone AutoRole.js)
// ============================================================================

/**
 * هل ميزة AutoRole مفعّلة لهذا السيرفر؟
 */
async function isAutoRoleEnabled(guildId) {
    try {
        const { data, error } = await supabase
            .from(TABLE_SETTING)
            .select('autorole_enabled')
            .eq('id_guild', guildId)
            .single();

        if (error) {
            console.error(`[AutoRole] فشل جلب إعدادات السيرفر ${guildId}:`, error.message);
            return false;
        }

        return data?.autorole_enabled === true;
    } catch (err) {
        console.error('[AutoRole] خطأ غير متوقع بفحص autorole_enabled:', err);
        return false;
    }
}

/**
 * حفظ رتب العضو عند المغادرة (لو الميزة مفعّلة)
 */
async function saveRoleBackup(member) {
    try {
        // نستثني رتبة @everyone والرتب المُدارة تلقائياً (بوتات/بوستر/انتغريشن)
        const roleIds = member.roles.cache
            .filter((role) => role.id !== member.guild.id && !role.managed)
            .map((role) => role.id);

        if (roleIds.length === 0) return;

        const { error } = await supabase
            .from(TABLE_BACKUP)
            .upsert(
                {
                    id_guild: member.guild.id,
                    id_user: member.id,
                    roles: roleIds,
                    at_updated: new Date().toISOString(),
                },
                { onConflict: 'id_guild,id_user' } // مفتاح PRIMARY KEY (id_guild, id_user) بالجدول أصلاً - يكفي لـ upsert
            );

        if (error) {
            console.error(
                `[AutoRole] فشل حفظ رتب العضو ${member.id} بسيرفر ${member.guild.id}:`,
                error.message
            );
            return;
        }

        console.log(
            `[AutoRole] تم حفظ ${roleIds.length} رتبة للعضو ${member.user?.tag || member.id} (${member.guild.name})`
        );
    } catch (err) {
        console.error('[AutoRole] خطأ غير متوقع أثناء حفظ الرتب:', err);
    }
}

/**
 * استعادة رتب العضو عند رجوعه (لو الميزة مفعّلة وعنده سجل محفوظ)
 */
async function restoreRoleBackup(member) {
    try {
        const { data, error } = await supabase
            .from(TABLE_BACKUP)
            .select('roles')
            .eq('id_guild', member.guild.id)
            .eq('id_user', member.id)
            .single();

        // ما فيه سجل محفوظ لهذا العضو بهذا السيرفر
        if (error || !data || !Array.isArray(data.roles) || data.roles.length === 0) {
            return;
        }

        const guild = member.guild;
        const botMember = guild.members.me;

        if (!botMember?.permissions.has('ManageRoles')) {
            console.warn(
                `[AutoRole] البوت ما عنده صلاحية Manage Roles بسيرفر ${guild.name}, تجاهلت الاستعادة.`
            );
            return;
        }

        const botHighestPosition = botMember.roles.highest.position;

        // نفلتر الرتب المحفوظة: موجودة فعلياً + أقل من أعلى رتبة عند البوت +
        // مو @everyone ومو رتبة مُدارة
        const validRoleIds = data.roles.filter((roleId) => {
            const role = guild.roles.cache.get(roleId);
            return (
                role &&
                role.id !== guild.id &&
                !role.managed &&
                role.position < botHighestPosition
            );
        });

        if (validRoleIds.length === 0) return;

        // [User-facing note]: this reason string appears in Discord's Audit Log
        await member.roles.add(validRoleIds, 'AutoRole: Restored previous roles after member rejoined');

        console.log(
            `[AutoRole] تم استرجاع ${validRoleIds.length} رتبة للعضو ${member.user?.tag || member.id} (${guild.name})`
        );

        // Cleanup: remove the backup row after a successful restore so old
        // data doesn't accumulate in backup_role_member.
        await supabase
            .from(TABLE_BACKUP)
            .delete()
            .eq('id_guild', guild.id)
            .eq('id_user', member.id);

    } catch (err) {
        console.error('[AutoRole] خطأ غير متوقع أثناء استعادة الرتب:', err);
    }
}

// ============================================================================
// GENERAL HELPER FUNCTIONS
// ============================================================================

/**
 * Parses duration strings (e.g., 10m, 1h) into milliseconds
 */
function parseDurationToMs(duration) {
    if (!duration) return null;
    const match = String(duration).match(/^(\d+)\s*(s|min|m|h|d|w)$/i);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const MS = {
        s: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000, w: 604800000
    };
    return (MS[unit] || 60000) * amount;
}

module.exports = { registerServerEvents };