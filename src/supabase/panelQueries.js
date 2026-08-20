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

async function listDmFailures() {
    const { data, error } = await supabase
        .from('panel_admin_actions')
        .select('*')
        .eq('dm_delivery_failed', true)
        .eq('active', true)
        .order('at_created', { ascending: false });

    if (error) {
        console.error('[PanelQueries] listDmFailures failed:', error.message);
        return [];
    }
    return data || [];
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

async function acknowledgeNotice(actionId, userId) {
    const { error } = await supabase
        .from('panel_action_acks')
        .upsert({ action_id: actionId, id_user: userId }, { onConflict: 'action_id,id_user' });
    if (error) throw new Error(`acknowledgeNotice failed: ${error.message}`);
    return true;
}

module.exports = {
    getBotState,
    updateBotState,
    getFeatureFlags,
    setFeatureFlags,
    getUserBan,
    banUser,
    unbanUser,
    createAdminAction,
    markDmFailed,
    listDmFailures,
    deactivateAdminAction,
    getActiveNoticeForUser,
    acknowledgeNotice
};