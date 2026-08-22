// ============================================================================
// panelQueries.js - Database Layer for the Admin Control Panel (v1.0)
// ============================================================================
// ملف مستقل تماماً عن databaseQueries.js (ما لمسناه ولا سطر) - كل الجداول
// هنا بادئة panel_ فقط، ونطاقها Cross-Guild (بدون id_guild)، فمنطقياً
// تستاهل طبقة منفصلة بدل ما تُحشر بملف databaseQueries.js الموجود أصلاً
// (المخصص لإعدادات كل سيرفر لحاله عبر universalGet/universalUpdate).
// ============================================================================

const supabase = require('./db');

// ----------------------------------------------------------------------------
// 1. Bot State (Full Shutdown / Maintenance / Online Status)
// ----------------------------------------------------------------------------

async function getBotState() {
    const { data, error } = await supabase
        .from('panel_bot_state')
        .select('*')
        .eq('id', 1)
        .single();

    if (error) {
        console.error('[PanelQueries] getBotState failed:', error.message);
        return null;
    }
    return data;
}

async function updateBotState(updates, updatedByDiscordId) {
    const payload = { ...updates, updated_by: updatedByDiscordId, at_updated: new Date().toISOString() };
    const { data, error } = await supabase
        .from('panel_bot_state')
        .update(payload)
        .eq('id', 1)
        .select()
        .single();

    if (error) throw new Error(`updateBotState failed: ${error.message}`);
    return data;
}

/**
 * [NEW] Ban All Users - فلاق واحد بـ panel_bot_state (نفس صف Singleton
 * full_shutdown/maintenance) بدل صف منفصل لكل مستخدم. راجع botState.js:
 * isUserBotBanned() للفحص الفعلي + استثناء السوبر أدمن.
 */
async function setGlobalBan({ reason, bannedBy, expiresAt = null }) {
    const { data, error } = await supabase
        .from('panel_bot_state')
        .update({
            global_ban_enabled: true,
            global_ban_reason: reason || 'No reason provided',
            global_ban_by: bannedBy,
            global_ban_expires: expiresAt,
            at_updated: new Date().toISOString()
        })
        .eq('id', 1)
        .select()
        .single();

    if (error) throw new Error(`setGlobalBan failed: ${error.message}`);
    return data;
}

async function clearGlobalBan() {
    const { data, error } = await supabase
        .from('panel_bot_state')
        .update({
            global_ban_enabled: false,
            global_ban_reason: null,
            global_ban_by: null,
            global_ban_expires: null,
            at_updated: new Date().toISOString()
        })
        .eq('id', 1)
        .select()
        .single();

    if (error) throw new Error(`clearGlobalBan failed: ${error.message}`);
    return data;
}

/**
 * [NEW] نسخة عامة خفيفة من حالة البوت - تُستخدم من endpoint عام
 * (/api/maintenance-status) تقدر أي صفحة داشبورد عادية تناديه (بدون
 * requirePanelOwner). ترجّع بس حقول الصيانة - ما تكشف full_shutdown أو
 * تفاصيل الحظر الجماعي (حساسة/داخلية) لغير السوبر أدمن.
 */
async function getPublicMaintenanceStatus() {
    const { data, error } = await supabase
        .from('panel_bot_state')
        .select('maintenance_enabled, maintenance_message')
        .eq('id', 1)
        .single();

    if (error) {
        console.error('[PanelQueries] getPublicMaintenanceStatus failed:', error.message);
        return { maintenance_enabled: false, maintenance_message: '' };
    }
    return data;
}

// ----------------------------------------------------------------------------
// 2. Feature Flags
// ----------------------------------------------------------------------------

/**
 * يرجّع الـ 15 فلاق لنطاق معيّن. لو scope='user' ومافيه صفوف مخصصة له بعد،
 * يرجع صفوف الـ global كـ fallback (نفس فلسفة "الافتراضي يسري لين يُستثنى").
 */
// [FIX] target_user_id بقاعدة البيانات NOT NULL - '' هو سنتينل "لا يوجد
// مستخدم محدد" (راجع تعليق panel_schema_delta.sql للسبب الكامل: عمود
// داخل PRIMARY KEY يصير NOT NULL تلقائياً، وupsert(onConflict:...) بمكتبة
// Supabase JS ما يدعم Partial Unique Index). كل الدوال هنا تحوّل تلقائياً
// بين null (بمنطق التطبيق بباقي الملفات: panelRouter.js/Adminpanel.js)
// و '' (بقاعدة البيانات فعلياً) - لا حاجة لأي تغيير بأي ملف ثاني.
const NO_TARGET_SENTINEL = '';

async function getFeatureFlags(scope = 'global', targetUserId = null) {
    const query = supabase.from('panel_feature_flags').select('*').eq('scope', scope);
    const { data, error } = scope === 'user'
        ? await query.eq('target_user_id', targetUserId || NO_TARGET_SENTINEL)
        : await query;

    if (error) {
        console.error('[PanelQueries] getFeatureFlags failed:', error.message);
        return [];
    }

    // لو طلبنا نطاق مستخدم ومافيه أي استثناء مخزّن له، نرجّع الـ global كافتراضي
    if (scope === 'user' && (!data || data.length === 0)) {
        const { data: globalRows } = await supabase
            .from('panel_feature_flags')
            .select('*')
            .eq('scope', 'global');
        return globalRows || [];
    }

    return data || [];
}

async function setFeatureFlags(scope, targetUserId, flagsMap) {
    const rows = Object.entries(flagsMap).map(([flag_key, enabled]) => ({
        scope,
        target_user_id: scope === 'global' ? NO_TARGET_SENTINEL : targetUserId,
        flag_key,
        enabled,
        at_updated: new Date().toISOString()
    }));

    const { data, error } = await supabase
        .from('panel_feature_flags')
        .upsert(rows, { onConflict: 'scope,target_user_id,flag_key' })
        .select();

    if (error) throw new Error(`setFeatureFlags failed: ${error.message}`);
    return data;
}

// ----------------------------------------------------------------------------
// 3. Bot-Wide User Bans
// ----------------------------------------------------------------------------

async function getUserBan(userId) {
    const { data, error } = await supabase
        .from('panel_user_bans')
        .select('*')
        .eq('id_user', userId)
        .maybeSingle();

    if (error) {
        console.error('[PanelQueries] getUserBan failed:', error.message);
        return null;
    }
    return data;
}

async function banUser({ userId, reason, bannedBy, expiresAt = null }) {
    const { data, error } = await supabase
        .from('panel_user_bans')
        .upsert({
            id_user: userId,
            reason: reason || 'No reason provided',
            banned_by: bannedBy,
            at_expires: expiresAt
        }, { onConflict: 'id_user' })
        .select()
        .single();

    if (error) throw new Error(`banUser failed: ${error.message}`);
    return data;
}

async function unbanUser(userId) {
    const { error } = await supabase.from('panel_user_bans').delete().eq('id_user', userId);
    if (error) throw new Error(`unbanUser failed: ${error.message}`);
    return true;
}

/**
 * [NEW - Logs] كل الحظورات الفردية الحالية (نشطة فعلياً - ما فيه عمود
 * active بهذا الجدول، الحذف هو الإزالة الفعلية عبر unbanUser). تُستخدم
 * من endpoint /logs الموحّد بـ Adminpanel.
 */
async function listAllBans() {
    const { data, error } = await supabase
        .from('panel_user_bans')
        .select('*')
        .order('at_created', { ascending: false });

    if (error) {
        console.error('[PanelQueries] listAllBans failed:', error.message);
        return [];
    }
    return data || [];
}

// ----------------------------------------------------------------------------
// 4. Admin Actions (Alert / Update / Note - "Account Action Notice")
// ----------------------------------------------------------------------------

async function createAdminAction({
    scope, targetUserId = null, actionType, badgeColor = 'red',
    title, message, deliveryChannel = 'dashboard', requiresAck = false, createdBy
}) {
    const { data, error } = await supabase
        .from('panel_admin_actions')
        .insert({
            scope,
            target_user_id: scope === 'global' ? null : targetUserId,
            action_type: actionType,
            badge_color: badgeColor,
            title,
            message,
            delivery_channel: deliveryChannel,
            requires_ack: requiresAck,
            created_by: createdBy
        })
        .select()
        .single();

    if (error) throw new Error(`createAdminAction failed: ${error.message}`);
    return data;
}

async function markDmFailed(actionId) {
    const { error } = await supabase
        .from('panel_admin_actions')
        .update({ dm_delivery_failed: true })
        .eq('id', actionId);
    if (error) console.error('[PanelQueries] markDmFailed failed:', error.message);
}

/**
 * [REPLACED listDmFailures] - Logs الآن تعرض كل الإشعارات (مو بس اللي فشل
 * الـ DM فيها) مع حالة تسليم كل قناة على حدة:
 *   - dashboard: دايماً "delivered" منطقياً طالما delivery_channel تشملها
 *     (قراءة سحب Pull-based، ما فيها "فشل" فعلي بمعنى شبكي - راجع Adminpanel.js
 *     لعرض هذا بوضوح للأدمن).
 *   - dm: يعتمد على dm_delivery_failed (لو القناة تشمل dm/both أصلاً).
 * acked_count يُحسب بنداء منفصل لجدول panel_action_acks ويُدمج هنا بدل
 * join مباشر (Supabase JS ما يدعم COUNT مجمّع بسهولة بنفس الاستعلام).
 */
async function listAllActions({ limit = 100 } = {}) {
    const { data: actions, error } = await supabase
        .from('panel_admin_actions')
        .select('*')
        .order('at_created', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('[PanelQueries] listAllActions failed:', error.message);
        return [];
    }
    if (!actions || actions.length === 0) return [];

    const actionIds = actions.map(a => a.id);
    const { data: acks } = await supabase
        .from('panel_action_acks')
        .select('action_id')
        .in('action_id', actionIds);

    const ackCounts = {};
    (acks || []).forEach(a => {
        ackCounts[a.action_id] = (ackCounts[a.action_id] || 0) + 1;
    });

    return actions.map(a => ({ ...a, acked_count: ackCounts[a.id] || 0 }));
}

async function deactivateAdminAction(actionId) {
    const { error } = await supabase
        .from('panel_admin_actions')
        .update({ active: false, at_updated: new Date().toISOString() })
        .eq('id', actionId);
    if (error) throw new Error(`deactivateAdminAction failed: ${error.message}`);
    return true;
}

/**
 * يرجّع الإشعار الفعّال (Active) اللي يخص هذا المستخدم تحديداً - يفضّل
 * إشعار فردي (scope='user') على العام (scope='global') لو الاثنين موجودين
 * بنفس الوقت. يستثني أي إشعار عام سبق ووافق عليه هذا المستخدم (عبر panel_action_acks).
 */
async function getActiveNoticeForUser(userId) {
    const { data: userScoped } = await supabase
        .from('panel_admin_actions')
        .select('*')
        .eq('active', true)
        .eq('scope', 'user')
        .eq('target_user_id', userId)
        .order('at_created', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (userScoped) return userScoped;

    const { data: acked } = await supabase
        .from('panel_action_acks')
        .select('action_id')
        .eq('id_user', userId);
    const ackedIds = (acked || []).map(a => a.action_id);

    let globalQuery = supabase
        .from('panel_admin_actions')
        .select('*')
        .eq('active', true)
        .eq('scope', 'global')
        .order('at_created', { ascending: false })
        .limit(1);

    if (ackedIds.length > 0) {
        globalQuery = globalQuery.not('id', 'in', `(${ackedIds.join(',')})`);
    }

    const { data: globalScoped } = await globalQuery.maybeSingle();
    return globalScoped || null;
}

/**
 * [FIX] كان يسجّل ack بس بغض النظر عن scope - صحيح لـ scope='global'
 * (كل شخص يقفلها لحاله، تبقى نشطة للباقين لين ينتهي عمرها/يوقفها الأدمن
 * يدوياً)، لكن غلط لـ scope='user' (إشعار مخصص لشخص واحد بالتعريف - ما
 * فيه أي داعي لتتبع ack منفصل، ولازم يختفي نهائياً من أول ضغطة Understand/
 * Dismiss، وإلا يرجع يبان بأي تحميل صفحة جديد للمستخدم نفسه لأنه يبقى
 * active=true). الحل: نفحص الـ scope أول - لو 'user' نستدعي
 * deactivateAdminAction() مباشرة (يخفيه نهائياً، هذا هو "مرة وحدة بس"
 * المطلوب)، ولو 'global' نبقي السلوك القديم (تسجيل ack بس، يبقى نشط
 * للباقين).
 */
async function acknowledgeNotice(actionId, userId) {
    const { data: action, error: fetchError } = await supabase
        .from('panel_admin_actions')
        .select('scope')
        .eq('id', actionId)
        .maybeSingle();

    if (fetchError) throw new Error(`acknowledgeNotice failed: ${fetchError.message}`);

    if (action?.scope === 'user') {
        return deactivateAdminAction(actionId);
    }

    const { error } = await supabase
        .from('panel_action_acks')
        .upsert({ action_id: actionId, id_user: userId }, { onConflict: 'action_id,id_user' });
    if (error) throw new Error(`acknowledgeNotice failed: ${error.message}`);
    return true;
}

/**
 * [NEW] يرجّع خريطة مسطّحة {flag_key: enabled} فعلية لمستخدم معيّن - يفضّل
 * أي صف مخصص له (scope='user') على القيمة العامة (scope='global') لنفس
 * الـ flag_key، ويكمّل الباقي من العام. يُستخدم من endpoint خفيف عام
 * (/api/feature-flags/effective) تقدر أي صفحة داشبورد عادية تناديه.
 */
async function getEffectiveFlagsForUser(discordId) {
    const { data: globalRows, error: globalErr } = await supabase
        .from('panel_feature_flags')
        .select('flag_key, enabled')
        .eq('scope', 'global');

    if (globalErr) {
        console.error('[PanelQueries] getEffectiveFlagsForUser (global) failed:', globalErr.message);
        return {};
    }

    const map = Object.fromEntries((globalRows || []).map(r => [r.flag_key, r.enabled]));

    if (discordId) {
        const { data: userRows } = await supabase
            .from('panel_feature_flags')
            .select('flag_key, enabled')
            .eq('scope', 'user')
            .eq('target_user_id', discordId);

        (userRows || []).forEach(r => { map[r.flag_key] = r.enabled; });
    }

    return map;
}

module.exports = {
    getBotState,
    updateBotState,
    setGlobalBan,
    clearGlobalBan,
    getPublicMaintenanceStatus,
    getFeatureFlags,
    setFeatureFlags,
    getEffectiveFlagsForUser,
    getUserBan,
    banUser,
    unbanUser,
    listAllBans,
    createAdminAction,
    markDmFailed,
    listAllActions,
    deactivateAdminAction,
    getActiveNoticeForUser,
    acknowledgeNotice
};