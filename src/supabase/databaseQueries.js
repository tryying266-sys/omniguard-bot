const supabase = require('./db');

/**
 * ============================================================================
 * databaseQueries.js - Universal Database Engine (v4.1 - Multi-Row Fix)
 * ============================================================================
 * تم مطابقة هذا الملف سطراً بسطر مقابل ai_studio_code.sql (Schema v4.0) اللي
 * رفعته. أغلب الدوال متطابقة فعلاً مع أسماء الأعمدة (Smart Binding شغّال صح
 * لست جداول الإعدادات: setting_guild, setting_alt_anti,
 * setting_moderation_security, setting_management_role, setting_leave_welcome,
 * setting_leveling).
 *
 * [FIX v4.0] cleanRow(): كانت فيها خطأ منطقي يخلّيها Dead Code (شرح مفصّل
 *         بأسفل الدالة نفسها) - مُصلحة سابقاً، بدون تغيير هنا.
 *
 * [FIX v4.1 - جديد] مشكلة .single() مع الجداول متعددة الصفوف لكل سيرفر:
 *         universalGet() كانت تستخدم .single() دائماً بغض النظر عن نوع
 *         الجدول. .single() بـ PostgREST تفترض صفاً واحداً بالضبط - وهذا
 *         صحيح لجداول الإعدادات الست (PK = id_guild فقط)، لكنه خطأ لجدول
 *         مثل role_delay_config اللي مفتاحه الأساسي (id_guild, id_role) -
 *         يعني ممكن عدة صفوف (عدة رتب) لنفس السيرفر. أي سيرفر عنده أكثر من
 *         رتبة مُهيّأة بـ "تأخير" كان هذا المسار سيفشل أو - الأخطر - يرجّع
 *         بيانات فاضية بصمت (PGRST116 مستخدم من PostgREST لكل من حالة "0
 *         صفوف" و"أكثر من صف"، فالكود القديم كان يبلعها بدون throw ويرجّع
 *         null، فتختفي بيانات الداشبورد بصمت بدل ما تظهر رسالة خطأ واضحة).
 *
 *         الحل: مصفوفة MULTI_ROW_TABLES تحدد الجداول اللي فيها أكثر من صف
 *         لكل سيرفر. universalGet() الآن تتفرّع:
 *           - جدول متعدد الصفوف → SELECT عادي بدون .single()، يرجّع مصفوفة
 *             (حتى لو فاضية []، مش null).
 *           - جدول صف واحد (الوضع الافتراضي والسابق) → نفس السلوك القديم
 *             بالضبط، بدون أي تغيير.
 *
 *         universalUpdate() أيضاً تحمي نفسها الآن: لو الجدول متعدد الصفوف،
 *         ترفض الطلب برسالة خطأ واضحة بدل ما تنفّذ UPDATE أعمى بشرط
 *         WHERE id_guild فقط - كان هذا سيكتب نفس القيم فوق *كل* صفوف
 *         السيرفر دفعة وحدة (مثلاً كل الرتب تاخذ نفس delay_duration، أو
 *         الأسوأ لو أُرسل id_role ضمن updates بالغلط يتكرر بكل الصفوف).
 *         الجداول متعددة الصفوف تحتاج مسار API مخصص يحدد الصف بالضبط (نفس
 *         نمط custom_embed_draft بـ apiRouter.js) - مو المسار العام.
 * ============================================================================
 */

/**
 * أسماء الأعمدة من نوع TEXT[] في السكيما الفعلية (ai_studio_code.sql).
 * تُستخدم فقط داخل cleanRow() لتحويل null -> [] بأمان (بدون التأثير على
 * أي عمود نصي/رقمي آخر ممكن يكون null بشكل شرعي، مثل channel_welcome).
 */
const ARRAY_COLUMNS = new Set([
    'whitelisted_channels',       // setting_guild
    'blacklisted_channels',       // setting_guild
    'roles_exempt_commands',      // setting_guild
    'roles_exempt_warn',          // setting_moderation_security
    'words_bad_custom',           // setting_moderation_security
    'dashboard_access_roles',     // setting_management_role
    'roles_admin_bot',            // setting_management_role
    'new_user_auto_roles',        // setting_management_role
    'new_bot_auto_roles',         // setting_management_role
    'ignored_channels',           // setting_leveling
    'roles',                      // backup_role_member
    'honeypot_channel_ids',       // setting_alt_anti
    'channel_whitelist',          // auto_respond_rules
    'channel_blacklist',          // auto_respond_rules
    'role_whitelist',             // auto_respond_rules
    'role_blacklist'              // auto_respond_rules
]);

/**
 * [NEW - v4.1] جداول فيها أكثر من صف لكل سيرفر (المفتاح الأساسي ليس
 * id_guild لوحده). universalGet/universalUpdate يتصرفان معها بشكل مختلف
 * عن جداول الإعدادات "صف واحد لكل سيرفر".
 *
 * role_delay_config: PK = (id_guild, id_role) - راجع omniguard_schema_v5.sql.
 * auto_mod_rule_config: عدة قواعد لكل (سيرفر + نوع) - راجع v5.3 delta.
 *         [ملاحظة] هذا الجدول لا يُقرأ فعلياً عبر المسار العام (auto-mod.html
 *         تستخدم مسارات مخصصة /guild/:guildId/auto-mod-rules - راجع Section
 *         3.5 بـ apiRouter.js). أُضيف هنا فقط كطبقة حماية دفاعية إضافية: لو
 *         أي كود مستقبلي استدعى المسار العام بالغلط لهذا الجدول، سيرجع
 *         مصفوفة بدل ما يفشل بصمت أو يكسر UPDATE على كل قواعد السيرفر دفعة
 *         وحدة.
 *
 * أضف أي جدول آخر متعدد الصفوف هنا لو احتجت الداشبورد يقرأه عبر المسار
 * العام مستقبلاً (مثل role_removal_schedule لو صار له صفحة داشبورد).
 *
 * [NEW - Ticket System v5.5] نفس منطق auto_mod_rule_config بالضبط: الأربعة
 * تحت (ticket_type_config, ticket_blacklist, ticket_auto_respond,
 * ticket_record) لا تُقرأ فعلياً عبر المسار العام - automation-logs.html /
 * category-embed.html تستخدمان مسارات apiRouter.js مخصصة (Section 3.6:
 * /guild/:guildId/ticket-categories, /ticket-blacklist, /ticket-auto-respond).
 * أُضيفوا هنا فقط كطبقة حماية دفاعية إضافية - نفس السبب بالضبط.
 * ⚠️ setting_ticket_system متعمّد مو هنا: هو فعلاً صف واحد بالـ PK
 * (id_guild) - بس يُدار عبر مساره المخصص (ticket-settings) لأنه مو جزء
 * من init_guild_settings() ويحتاج upsert حقيقي، مو لأنه multi-row.
 */
const MULTI_ROW_TABLES = new Set([
    'role_delay_config',
    'auto_mod_rule_config',
    'ticket_type_config',
    'ticket_blacklist',
    'ticket_auto_respond',
    'ticket_record',
    'auto_respond_rules',           // [NEW] راجع v6.1 delta - نفس سبب الحماية الدفاعية بالضبط
    'role_xp_multipliers',          // [NEW] راجع v6.2 delta - PK = (id_guild, id_role)
    'user_levels',                  // [NEW] راجع v6.2 delta - PK = (id_guild, id_user)
    'tiered_xp_brackets'            // [NEW] راجع v6.2 delta - عدة فئات لكل سيرفر
]);

/**
 * Helper: Cleans the returned row to ensure known array columns are never null.
 * [FIXED - v4.0] الشرط القديم كان مستحيل التحقق (Dead Code) - راجع الشرح
 * بالأعلى بترويسة الملف.
 * @param {Object} row
 */
function cleanRow(row) {
    if (!row) return null;
    const cleaned = { ...row };
    for (const key in cleaned) {
        if (cleaned[key] === null && ARRAY_COLUMNS.has(key)) {
            cleaned[key] = [];
        }
    }
    return cleaned;
}

// ============================================
// 1. UNIVERSAL CORE (Smart Binding Support)
// ============================================
// ✅ تحقّقت: عمود المطابقة id_guild موجود Primary Key في كل جداول الإعدادات
// الست (setting_guild, setting_alt_anti, setting_moderation_security,
// setting_management_role, setting_leave_welcome, setting_leveling)
// بالضبط زي ما تفترض الدالتين تحت لحالة "صف واحد". ما فيه أي تعديل مطلوب
// على هذا الجزء.

/**
 * Dynamically fetches data from any settings table.
 * [FIX v4.1] تتفرّع الآن حسب نوع الجدول (صف واحد / عدة صفوف لكل سيرفر) -
 * راجع شرح MULTI_ROW_TABLES بالأعلى.
 * @param {string} tableName
 * @param {string} guildId
 * @returns {Promise<Object|Array|null>} كائن واحد لجداول الإعدادات، أو
 *          مصفوفة (حتى لو فاضية) لو الجدول متعدد الصفوف.
 */
async function universalGet(tableName, guildId) {
    if (MULTI_ROW_TABLES.has(tableName)) {
        const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .eq('id_guild', guildId);

        if (error) {
            console.error(`[Database Error] GET ${tableName} (multi-row):`, error.message);
            throw error;
        }
        return (data || []).map(cleanRow);
    }

    const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .eq('id_guild', guildId)
        .single();

    if (error && error.code !== 'PGRST116') {
        console.error(`[Database Error] GET ${tableName}:`, error.message);
        throw error;
    }
    return cleanRow(data);
}

/**
 * Dynamically updates any settings table.
 * [FIX v4.1] الجداول متعددة الصفوف تُرفض هنا بدل ما تُنفَّذ بـ UPDATE أعمى
 * على WHERE id_guild فقط (كان سيكتب نفس القيم فوق كل صفوف السيرفر دفعة
 * وحدة). تحتاج مسار API مخصص يحدد الصف بالضبط (نفس نمط custom_embed_draft).
 * @param {string} tableName
 * @param {string} guildId
 * @param {Object} updates
 */
async function universalUpdate(tableName, guildId, updates) {
    if (MULTI_ROW_TABLES.has(tableName)) {
        const err = new Error(
            `Table "${tableName}" stores multiple rows per guild and cannot be safely ` +
            `updated through the generic endpoint (WHERE id_guild alone would overwrite ` +
            `every row for this guild). Use a dedicated route that also targets the ` +
            `specific row (e.g. id_role).`
        );
        err.code = 'MULTI_ROW_UNSUPPORTED';
        throw err;
    }

    const { data, error } = await supabase
        .from(tableName)
        .update(updates)
        .eq('id_guild', guildId)
        .select();

    if (error) {
        console.error(`[Database Error] UPDATE ${tableName}:`, error.message);
        throw error;
    }
    return cleanRow(data[0]);
}

// ============================================
// 2. LOGGING ENGINE (Activity Tracking)
// ============================================

/**
 * ⚠️ [SCHEMA GAP] جدول "log_command_bot" غير موجود في ai_studio_code.sql.
 * الدالة لن تكسر البوت (الخطأ يُمسك بالأسفل ويُطبع فقط بالكونسول) لكن ولا
 * سجل بيتحفظ فعلياً إلى أن تنشئ الجدول. لو حبيت تفعّلها، الصق هذا بمحرر
 * Supabase SQL (الأعمدة تطابق تماماً ما ترسله الدالة تحت):
 *
 *   CREATE TABLE IF NOT EXISTS log_command_bot (
 *       id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *       id_guild      TEXT NOT NULL REFERENCES setting_guild(id_guild) ON DELETE CASCADE,
 *       id_user       TEXT NOT NULL,
 *       username      TEXT,
 *       name_command  TEXT NOT NULL,
 *       id_channel    TEXT,
 *       message_raw   TEXT,
 *       created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *   ALTER TABLE log_command_bot ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY staff_read_command_log ON log_command_bot FOR SELECT USING (is_dashboard_staff(id_guild));
 *
 * ملاحظة: omniguard_schema_v5.sql (السكيما الأحدث اللي رفعتها بمحادثة
 * ثانية) بالفعل يُنشئ هذا الجدول - لو نفّذته فعلاً هذي الملاحظة تصير غير
 * ضرورية وستشتغل الدالة تلقائياً.
 */
async function logCommand({ guildId, userId, username, commandName, channelId, rawMessage }) {
    const { error } = await supabase.from('log_command_bot').insert({
        id_guild: guildId,
        id_user: userId,
        username,
        name_command: commandName,
        id_channel: channelId,
        message_raw: rawMessage
    });
    if (error) console.error('[Database Error] logCommand:', error.message);
}

// ✅ تحقّقت: تطابق كامل مع جدول log_moderation (id_guild, id_target,
// username_target, id_moderator, action_type, reason, duration موجودين
// بالضبط بهذي الأسماء، وaction_type CHECK يقبل نفس القيم المُرسلة من
// ban/kick/mute/warn/unmute/unban). لا حاجة لأي تعديل.
async function logModerationAction({ guildId, targetId, targetUsername, moderatorId, actionType, reason, duration }) {
    const { error } = await supabase.from('log_moderation').insert({
        id_guild: guildId,
        id_target: targetId,
        username_target: targetUsername,
        id_moderator: moderatorId,
        action_type: actionType,
        reason,
        duration
    });
    if (error) console.error('[Database Error] logModerationAction:', error.message);
}

/**
 * ⚠️ [SCHEMA GAP] جدول "log_audit_dashboard" غير موجود في ai_studio_code.sql
 * (لكنه موجود بـ omniguard_schema_v5.sql). نفس الوضع: لا كراش، فقط لا يُحفظ
 * شي فعلياً حالياً إذا كنت لسه على السكيما القديمة.
 */
async function logDashboardAudit({ guildId, userId, description, statePrevious, stateNew }) {
    const { error } = await supabase.from('log_audit_dashboard').insert({
        id_guild: guildId,
        id_user: userId,
        description_action: description,
        state_previous: statePrevious,
        state_new: stateNew
    });
    if (error) console.error('[Database Error] logDashboardAudit:', error.message);
}

// ✅ تحقّقت: تطابق كامل مع جدول alt_suspected (id_guild, id_user, username,
// url_avatar, at_created_account, action_taken) و action_taken CHECK يقبل
// بالضبط ('Banned','Kicked','Muted','Flagged') المُرسلة من server.js. لا
// تعديل مطلوب.
async function addSuspectedAlt({ guildId, userId, username, avatarUrl, accountCreatedAt, actionTaken }) {
    const { error } = await supabase.from('alt_suspected').insert({
        id_guild: guildId,
        id_user: userId,
        username,
        url_avatar: avatarUrl,
        at_created_account: accountCreatedAt,
        action_taken: actionTaken
    });
    if (error) console.error('[Database Error] addSuspectedAlt:', error.message);
}

// ============================================
// 3. MEMBER UTILITIES (Backups & Warnings)
// ============================================
// ✅ تحقّقت: backup_role_member (id_guild, id_user, roles, at_updated) و
// warning_active (id_guild, id_user, reason, id_moderator, at_expires)
// متطابقتان تماماً مع السكيما. لا تعديل مطلوب على الدوال الأربع تحت.

async function backupMemberRoles(guildId, userId, roles) {
    const { error } = await supabase.from('backup_role_member').upsert({
        id_guild: guildId,
        id_user: userId,
        roles,
        at_updated: new Date().toISOString()
    });
    if (error) console.error('[Database Error] backupMemberRoles:', error.message);
}

async function getBackupRoles(guildId, userId) {
    const { data, error } = await supabase
        .from('backup_role_member')
        .select('roles')
        .eq('id_guild', guildId)
        .eq('id_user', userId)
        .single();
    if (error && error.code !== 'PGRST116') console.error('[Database Error] getBackupRoles:', error.message);
    return data;
}

async function deleteBackupRoles(guildId, userId) {
    const { error } = await supabase
        .from('backup_role_member')
        .delete()
        .eq('id_guild', guildId)
        .eq('id_user', userId);
    if (error) console.error('[Database Error] deleteBackupRoles:', error.message);
}

async function addWarning({ guildId, userId, reason, moderatorId, expiresAt }) {
    const { error } = await supabase.from('warning_active').insert({
        id_guild: guildId,
        id_user: userId,
        reason,
        id_moderator: moderatorId,
        at_expires: expiresAt
    });
    if (error) console.error('[Database Error] addWarning:', error.message);
}

// ============================================
// 4. AUTO-MOD DYNAMIC INFRACTION RULES (v5.3)
// ============================================
// auto_mod_rule_config: عدة قواعد لكل (سيرفر + نوع warn/mute/kick). يستبدل
// نظام Tier1/Tier2 الثابت القديم (limit_trigger_warn/limit_trigger_severe -
// أعمدة متروكة الآن، راجع COMMENT ON COLUMN بملف v5.3 delta). هذا الجدول
// متعدد الصفوف فعلياً (راجع MULTI_ROW_TABLES بالأعلى)، فلا يُدار عبر
// universalGet/universalUpdate - يستخدم مسارات apiRouter.js مخصصة
// (/guild/:guildId/auto-mod-rules) تنادي الدوال الأربع تحت مباشرة.

/**
 * يرجع كل القواعد لسيرفر معيّن (كل الأنواع)، أو نوع واحد بس لو مُرِّر
 * ruleType. مرتبة تصاعدياً حسب threshold عشان تظهر بترتيب منطقي بالواجهة.
 * @param {string} guildId
 * @param {'warn'|'mute'|'kick'|null} ruleType
 */
async function getAutoModRules(guildId, ruleType = null) {
    let query = supabase.from('auto_mod_rule_config').select('*').eq('id_guild', guildId);
    if (ruleType) query = query.eq('rule_type', ruleType);
    query = query.order('threshold', { ascending: true });

    const { data, error } = await query;
    if (error) {
        console.error('[Database Error] getAutoModRules:', error.message);
        throw error;
    }
    return data || [];
}

/**
 * ينشئ قاعدة جديدة. يرمي الخطأ الخام لو القيد UNIQUE(id_guild, rule_type,
 * threshold) أو أي CHECK constraint (تطابق action مع rule_type، أو duration
 * مع action='kick') انتهك - apiRouter.js يحوّل err.code (23505/23514) لرسالة
 * مفهومة، فما نبتلعه هنا.
 * @param {{guildId:string, ruleType:string, threshold:number, action:string, duration:?string}} params
 */
async function addAutoModRule({ guildId, ruleType, threshold, action, duration }) {
    const { data, error } = await supabase
        .from('auto_mod_rule_config')
        .insert({
            id_guild: guildId,
            rule_type: ruleType,
            threshold,
            action,
            duration: duration || null
        })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] addAutoModRule:', error.message);
        throw error;
    }
    return data;
}

/**
 * يعدّل قاعدة موجودة. eq('id_guild', guildId) هنا مو مجرد فلترة إضافية -
 * هي فحص ملكية فعلي يمنع تعديل قاعدة تخص سيرفر ثاني حتى لو ruleId تخمّن
 * بالغلط أو انتقل بطريقة خاطئة. يرجع null (مو throw) لو ما فيه صف مطابق
 * (id غلط أو يخص سيرفر ثاني) - apiRouter.js يحولها لـ 404 نظيف.
 * @param {string} ruleId
 * @param {string} guildId
 * @param {{threshold:?number, action:?string, duration:?string}} updates
 */
async function updateAutoModRule(ruleId, guildId, updates) {
    const payload = { ...updates, updated_at: new Date().toISOString() };

    const { data, error } = await supabase
        .from('auto_mod_rule_config')
        .update(payload)
        .eq('id', ruleId)
        .eq('id_guild', guildId)
        .select()
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // ما فيه صف مطابق - راجع الشرح أعلاه
        console.error('[Database Error] updateAutoModRule:', error.message);
        throw error;
    }
    return data;
}

/**
 * يحذف قاعدة. نفس فحص الملكية بـ eq('id_guild', guildId) أعلاه. لا يرمي
 * خطأ لو ما فيه صف مطابق أصلاً (حذف غير موجود = نجاح ساكت، متوافق مع سلوك
 * زر الحذف الفوري بالواجهة).
 * @param {string} ruleId
 * @param {string} guildId
 */
async function deleteAutoModRule(ruleId, guildId) {
    const { error } = await supabase
        .from('auto_mod_rule_config')
        .delete()
        .eq('id', ruleId)
        .eq('id_guild', guildId);

    if (error) {
        console.error('[Database Error] deleteAutoModRule:', error.message);
        throw error;
    }
    return true;
}

// ============================================
// 6. TICKET SYSTEM (Schema v5.5 - setting_ticket_system, ticket_type_config,
//    ticket_blacklist, ticket_auto_respond)
// ============================================
// [NEW] نُقلت هنا من apiRouter.js (كانت مؤقتاً require('./db') مباشرة
// داخل الراوتر نفسه، لحد ما وصلتني نسخة هذا الملف). نفس فلسفة القسم 4
// (auto_mod_rule_config) بالأعلى بالحرف.

/**
 * Ticket Settings (setting_ticket_system) - صف واحد لكل سيرفر، مو جزء من
 * init_guild_settings() (نفس سبب custom_embed_draft بـ apiRouter.js) -
 * GET يرجع {} لو لسا ما انحفظ شي (بدل ما يفشل)، وPUT يسوي upsert حقيقي
 * مو UPDATE عمياء تفترض إن الصف موجود مسبقاً.
 */
async function getTicketSettings(guildId) {
    const { data, error } = await supabase
        .from('setting_ticket_system')
        .select('*')
        .eq('id_guild', guildId)
        .maybeSingle();

    if (error) {
        console.error('[Database Error] getTicketSettings:', error.message);
        throw error;
    }
    return data || {};
}

async function upsertTicketSettings(guildId, updates) {
    const { data, error } = await supabase
        .from('setting_ticket_system')
        .upsert({
            id_guild: guildId,
            ...updates,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id_guild' })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] upsertTicketSettings:', error.message);
        throw error;
    }
    return data;
}

/**
 * Ticket Categories (ticket_type_config) - عدة صفوف لكل سيرفر. نفس بنية
 * دوال auto_mod_rule_config (القسم 4) بالحرف: إضافة/تعديل/حذف فوري لكل
 * صف لحاله من category-embed.html.
 */
async function getTicketCategories(guildId) {
    const { data, error } = await supabase
        .from('ticket_type_config')
        .select('*')
        .eq('id_guild', guildId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[Database Error] getTicketCategories:', error.message);
        throw error;
    }
    return data || [];
}

async function addTicketCategory({ guildId, name, emoji, categoryId, channelBaseName, counterEnabled, counterStart }) {
    const { data, error } = await supabase
        .from('ticket_type_config')
        .insert({
            id_guild: guildId,
            name,
            emoji: emoji || null,
            category_id: categoryId || null,
            channel_base_name: channelBaseName || 'ticket',
            counter_enabled: counterEnabled !== undefined ? !!counterEnabled : true,
            counter_start: Number.isInteger(counterStart) && counterStart > 0 ? counterStart : 1
        })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] addTicketCategory:', error.message);
        throw error;
    }
    return data;
}

/**
 * eq('id_guild', guildId) هنا فحص ملكية فعلي (نفس updateAutoModRule) -
 * يمنع تعديل تصنيف يخص سيرفر ثاني حتى لو typeId تخمّن صح. يرجع null
 * (مو throw) لو ما فيه صف مطابق - apiRouter.js يحوّلها 404 نظيف.
 */
async function updateTicketCategory(typeId, guildId, updates) {
    const payload = { ...updates, updated_at: new Date().toISOString() };

    const { data, error } = await supabase
        .from('ticket_type_config')
        .update(payload)
        .eq('id', typeId)
        .eq('id_guild', guildId)
        .select()
        .maybeSingle();

    if (error) {
        console.error('[Database Error] updateTicketCategory:', error.message);
        throw error;
    }
    return data;
}

async function deleteTicketCategory(typeId, guildId) {
    const { error } = await supabase
        .from('ticket_type_config')
        .delete()
        .eq('id', typeId)
        .eq('id_guild', guildId);

    if (error) {
        console.error('[Database Error] deleteTicketCategory:', error.message);
        throw error;
    }
    return true;
}

/**
 * Ticket Blacklist (ticket_blacklist) - صف واحد لكل (سيرفر + مستخدم)،
 * PK = (id_guild, id_user). يُدار من أمر /ticket-blacklist بالديسكورد
 * (ticketsystem.js) وكمان من الداشبورد - نفس فكرة user_command_exemption
 * (القسم 2 أعلاه): آخر حظر يستبدل القديم، بدون تراكم صفوف.
 */
async function getTicketBlacklist(guildId) {
    const { data, error } = await supabase
        .from('ticket_blacklist')
        .select('*')
        .eq('id_guild', guildId)
        .order('updated_at', { ascending: false });

    if (error) {
        console.error('[Database Error] getTicketBlacklist:', error.message);
        throw error;
    }
    return data || [];
}

async function upsertTicketBlacklist({ guildId, userId, reason, bannedBy, expiresAt }) {
    const { data, error } = await supabase
        .from('ticket_blacklist')
        .upsert({
            id_guild: guildId,
            id_user: userId,
            reason: reason || null,
            banned_by: bannedBy || null,
            expires_at: expiresAt || null,
            processed: false,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id_guild,id_user' })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] upsertTicketBlacklist:', error.message);
        throw error;
    }
    return data;
}

async function deleteTicketBlacklistEntry(guildId, userId) {
    const { error } = await supabase
        .from('ticket_blacklist')
        .delete()
        .eq('id_guild', guildId)
        .eq('id_user', userId);

    if (error) {
        console.error('[Database Error] deleteTicketBlacklistEntry:', error.message);
        throw error;
    }
    return true;
}

/**
 * Ticket Auto Respond (ticket_auto_respond) - عدة صفوف لكل سيرفر. نفس
 * بنية دوال auto_mod_rule_config CRUD بالحرف.
 */
async function getTicketAutoRespond(guildId) {
    const { data, error } = await supabase
        .from('ticket_auto_respond')
        .select('*')
        .eq('id_guild', guildId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('[Database Error] getTicketAutoRespond:', error.message);
        throw error;
    }
    return data || [];
}

async function addTicketAutoRespond({ guildId, triggerPhrase, responseText }) {
    const { data, error } = await supabase
        .from('ticket_auto_respond')
        .insert({
            id_guild: guildId,
            trigger_phrase: triggerPhrase,
            response_text: responseText
        })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] addTicketAutoRespond:', error.message);
        throw error;
    }
    return data;
}

async function updateTicketAutoRespond(ruleId, guildId, updates) {
    const { data, error } = await supabase
        .from('ticket_auto_respond')
        .update(updates)
        .eq('id', ruleId)
        .eq('id_guild', guildId)
        .select()
        .maybeSingle();

    if (error) {
        console.error('[Database Error] updateTicketAutoRespond:', error.message);
        throw error;
    }
    return data;
}

async function deleteTicketAutoRespond(ruleId, guildId) {
    const { error } = await supabase
        .from('ticket_auto_respond')
        .delete()
        .eq('id', ruleId)
        .eq('id_guild', guildId);

    if (error) {
        console.error('[Database Error] deleteTicketAutoRespond:', error.message);
        throw error;
    }
    return true;
}

/**
 * Auto Respond (auto_respond_rules) - عدة قواعد لكل سيرفر. راجع v6.1
 * delta. نفس بنية دوال auto_mod_rule_config / ticket_auto_respond
 * بالحرف (get all / add / update / delete)، بس بحقول أكثر (4 مصفوفات
 * تاقات + match_type + cooldown + enabled).
 */
async function getAutoRespondRules(guildId) {
    const { data, error } = await supabase
        .from('auto_respond_rules')
        .select('*')
        .eq('id_guild', guildId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('[Database Error] getAutoRespondRules:', error.message);
        throw error;
    }
    return (data || []).map(cleanRow);
}

/**
 * ينشئ قاعدة رد تلقائي جديدة. القيم الافتراضية (trigger_keyword فاضي،
 * response_message فاضي، match_type='contains', cooldown=10, enabled=true)
 * تسمح بإنشاء "كرت فاضي" فوري من زر "Add New Auto Response" بالواجهة -
 * المستخدم يعبّي الحقول بعدها ويحفظ (نفس تجربة auto-mod-rules).
 */
async function addAutoRespondRule({ guildId, triggerKeyword, matchType, cooldownSeconds, responseMessage, channelWhitelist, channelBlacklist, roleWhitelist, roleBlacklist, enabled }) {
    const { data, error } = await supabase
        .from('auto_respond_rules')
        .insert({
            id_guild: guildId,
            trigger_keyword: triggerKeyword ?? '',
            match_type: matchType || 'contains',
            cooldown_seconds: Number.isInteger(cooldownSeconds) ? cooldownSeconds : 10,
            response_message: responseMessage ?? '',
            channel_whitelist: channelWhitelist || [],
            channel_blacklist: channelBlacklist || [],
            role_whitelist: roleWhitelist || [],
            role_blacklist: roleBlacklist || [],
            enabled: enabled !== undefined ? enabled : true
        })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] addAutoRespondRule:', error.message);
        throw error;
    }
    return cleanRow(data);
}

/**
 * يعدّل قاعدة موجودة (تعديل جزئي - بس الحقول المُمرّرة بـ updates).
 * eq('id_guild', guildId) فحص ملكية زي باقي دوال هالقسم بالضبط. يرجع
 * null (مو throw) لو ما فيه صف مطابق - apiRouter.js يحولها لـ 404.
 */
async function updateAutoRespondRule(ruleId, guildId, updates) {
    const payload = { ...updates, updated_at: new Date().toISOString() };

    const { data, error } = await supabase
        .from('auto_respond_rules')
        .update(payload)
        .eq('id', ruleId)
        .eq('id_guild', guildId)
        .select()
        .maybeSingle();

    if (error) {
        console.error('[Database Error] updateAutoRespondRule:', error.message);
        throw error;
    }
    return cleanRow(data);
}

async function deleteAutoRespondRule(ruleId, guildId) {
    const { error } = await supabase
        .from('auto_respond_rules')
        .delete()
        .eq('id', ruleId)
        .eq('id_guild', guildId);

    if (error) {
        console.error('[Database Error] deleteAutoRespondRule:', error.message);
        throw error;
    }
    return true;
}

// ============================================
// 6.5 LEVELING SYSTEM (v6.2 - Level.html)
// ============================================
const { getLevelFromTotalXp, normalizeGrowthSystem } = require('./levelingFormulas');

/**
 * Tiered Ranks Brackets - فئات نظام Tiered قابلة للتعديل بالكامل من
 * الداشبورد (عدة صفوف لكل سيرفر، مرتبة تصاعدياً حسب max_level).
 */
async function getTieredBrackets(guildId) {
    const { data, error } = await supabase
        .from('tiered_xp_brackets')
        .select('*')
        .eq('id_guild', guildId)
        .order('max_level', { ascending: true });

    if (error) {
        console.error('[Database Error] getTieredBrackets:', error.message);
        throw error;
    }
    return data || [];
}

async function addTieredBracket(guildId, maxLevel, xpPerLevel, label) {
    const { data, error } = await supabase
        .from('tiered_xp_brackets')
        .insert({ id_guild: guildId, max_level: maxLevel, xp_per_level: xpPerLevel, label: label || null })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] addTieredBracket:', error.message);
        throw error;
    }
    return data;
}

async function deleteTieredBracket(bracketId, guildId) {
    const { error } = await supabase
        .from('tiered_xp_brackets')
        .delete()
        .eq('id', bracketId)
        .eq('id_guild', guildId);

    if (error) {
        console.error('[Database Error] deleteTieredBracket:', error.message);
        throw error;
    }
    return true;
}

/**
 * Role XP Multipliers - عدة صفوف لكل سيرفر (PK: id_guild + id_role).
 */
async function getRoleXpMultipliers(guildId) {
    const { data, error } = await supabase
        .from('role_xp_multipliers')
        .select('*')
        .eq('id_guild', guildId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('[Database Error] getRoleXpMultipliers:', error.message);
        throw error;
    }
    return (data || []).map(cleanRow);
}

/**
 * إضافة/تحديث مضاعف رتبة - Upsert بالحرف (نفس زر "Add Multiplier" الوحيد
 * بالتصميم يغطي الحالتين: رتبة جديدة، أو تحديث رتبة موجودة بنفس الاسم).
 */
async function upsertRoleXpMultiplier(guildId, roleId, multiplier) {
    const { data, error } = await supabase
        .from('role_xp_multipliers')
        .upsert({ id_guild: guildId, id_role: roleId, multiplier }, { onConflict: 'id_guild,id_role' })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] upsertRoleXpMultiplier:', error.message);
        throw error;
    }
    return cleanRow(data);
}

async function deleteRoleXpMultiplier(guildId, roleId) {
    const { error } = await supabase
        .from('role_xp_multipliers')
        .delete()
        .eq('id_guild', guildId)
        .eq('id_role', roleId);

    if (error) {
        console.error('[Database Error] deleteRoleXpMultiplier:', error.message);
        throw error;
    }
    return true;
}

/**
 * بيانات عضو واحد (level.html Manual Override preview box، وLevel.js
 * بالبوت لجلب حالته الحالية). يرجع null لو ما عنده أي سجل لسا (عضو جديد
 * صفر XP - حالة طبيعية جداً، مو خطأ).
 */
async function getUserLevel(guildId, userId) {
    const { data, error } = await supabase
        .from('user_levels')
        .select('*')
        .eq('id_guild', guildId)
        .eq('id_user', userId)
        .maybeSingle();

    if (error) {
        console.error('[Database Error] getUserLevel:', error.message);
        throw error;
    }
    return cleanRow(data);
}

/**
 * القلب الحسابي المشترك بين Manual Override (apiRouter.js) ومحرك البوت
 * (commands/Level.js) - أي تغيير بنقاط عضو (طبيعي من رسالة، أو يدوي من
 * الداشبورد) يمر من هنا، فمستحيل يصير تعارض حسابي بين الطرفين.
 *
 * mode: 'add' (يضيف amount) | 'remove' (يطرح amount، لا يقل عن صفر) |
 *       'set' (يثبّت total_xp بالضبط على amount).
 *
 * level/xp (التقدّم بالمستوى الحالي) يُعاد حسابهم دايماً من total_xp حسب
 * growthSystem الحالي - يعني لو المشرف غيّر نظام الصعوبة، أول تعديل جديد
 * لأي عضو يصحح مستواه تلقائياً (راجع تعليق التصميم بـ levelingFormulas.js).
 */
async function applyUserXpChange(guildId, userId, mode, amount, growthSystem, tieredBrackets) {
    const current = await getUserLevel(guildId, userId);
    const currentTotal = current ? Number(current.total_xp) : 0;

    let newTotal;
    if (mode === 'add') newTotal = currentTotal + amount;
    else if (mode === 'remove') newTotal = Math.max(0, currentTotal - amount);
    else if (mode === 'set') newTotal = Math.max(0, amount);
    else throw new Error(`Invalid mode: ${mode}`);

    const { level, xp } = getLevelFromTotalXp(newTotal, normalizeGrowthSystem(growthSystem), tieredBrackets);

    const { data, error } = await supabase
        .from('user_levels')
        .upsert({
            id_guild: guildId,
            id_user: userId,
            total_xp: newTotal,
            level,
            xp,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id_guild,id_user' })
        .select()
        .single();

    if (error) {
        console.error('[Database Error] applyUserXpChange:', error.message);
        throw error;
    }
    return cleanRow(data);
}

// ============================================
// 7. SYSTEM INITIALIZATION
// ============================================
// ✅ تحقّقت: دالة init_guild_settings(p_guild_id TEXT) موجودة بالضبط بنفس
// الاسم واسم المعامل بالسكيما، وتُنشئ صفوف افتراضية بست جداول الإعدادات.
// setting_guild.id_guild هو نفسه العمود المُستخدم في pingDatabase. لا تعديل.

/**
 * Initializes all settings tables for a new guild using SQL RPC.
 */
async function initGuildSettings(guildId) {
    const { data, error } = await supabase.rpc('init_guild_settings', { p_guild_id: guildId });
    if (error) {
        console.error('[Database Error] initGuildSettings:', error.message);
        return null;
    }
    return data;
}

/**
 * Verifies if the database connection is alive.
 */
async function pingDatabase() {
    const { data, error } = await supabase.from('setting_guild').select('id_guild').limit(1);
    if (error) throw error;
    return data;
}

module.exports = {
    // Core Engine
    universalGet,
    universalUpdate,

    // Logging
    logCommand,
    logModerationAction,
    logDashboardAudit,
    addSuspectedAlt,

    // Member Utilities
    backupMemberRoles,
    getBackupRoles,
    deleteBackupRoles,
    addWarning,

    // Auto-Mod Dynamic Rules (v5.3)
    getAutoModRules,
    addAutoModRule,
    updateAutoModRule,
    deleteAutoModRule,

    // Ticket System (v5.5)
    getTicketSettings,
    upsertTicketSettings,
    getTicketCategories,
    addTicketCategory,
    updateTicketCategory,
    deleteTicketCategory,
    getTicketBlacklist,
    upsertTicketBlacklist,
    deleteTicketBlacklistEntry,
    getTicketAutoRespond,
    addTicketAutoRespond,
    updateTicketAutoRespond,
    deleteTicketAutoRespond,

    // Auto Respond (v6.1)
    getAutoRespondRules,
    addAutoRespondRule,
    updateAutoRespondRule,
    deleteAutoRespondRule,

    // Leveling System (v6.2)
    getRoleXpMultipliers,
    upsertRoleXpMultiplier,
    deleteRoleXpMultiplier,
    getTieredBrackets,
    addTieredBracket,
    deleteTieredBracket,
    getUserLevel,
    applyUserXpChange,

    // System
    initGuildSettings,
    pingDatabase
};