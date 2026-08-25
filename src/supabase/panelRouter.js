// ============================================================================
// panelRouter.js - Admin Control Panel API (v1.0)
// ============================================================================
// راوتر مستقل تماماً عن apiRouter.js (اللي كل route فيه مبني على guildId +
// requireDiscordPermission - صلاحية "staff بسيرفر معين"). هذا الراوتر عبر
// كل السيرفرات، لشخص واحد بس (Adminpanel owner)، فاستحق ملف وmiddleware
// منفصلين تماماً بدل ما يُحشر جنب المسار العام.
//
// [التركيب] يُركَّب بـ apiServer.js على: app.use('/api/panel', attachDashboardUser,
// requirePanelOwner, panelRouter) - يعني requirePanelOwner يُفحص مرة وحدة
// قبل كل route هنا، ما يحتاج تكراره بكل سطر.
// ============================================================================

const express = require('express');
const router = express.Router();

const panelQueries = require('./panelQueries');
const botState = require('./botState');
const { dashboardCooldown } = require('./authMiddleware');

// كل عمليات الكتابة (POST/PUT/DELETE) تمر بنفس الكولداون العام المستخدم
// بباقي الداشبورد - يحافظ على نفس سلوك زر الحفظ (رمادي/أحمر/أخضر) المتفق عليه.
router.use(dashboardCooldown);

// ----------------------------------------------------------------------------
// Utility: تحويل صيغة المدة المختصرة (1s/1m/1h/1d/1w/1mo/1y) لتاريخ ISO مستقبلي
// ----------------------------------------------------------------------------
function parseDurationToExpiryDate(duration) {
    if (!duration) return null;
    const match = String(duration).trim().match(/^(\d+)(s|m|h|d|w|mo|y)$/i);
    if (!match) return { error: true };

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const MS = {
        s: 1000,
        m: 60000,
        h: 3600000,
        d: 86400000,
        w: 604800000,
        mo: 2592000000,  // 30 يوم تقريبي
        y: 31536000000   // 365 يوم تقريبي
    };
    if (!MS[unit]) return { error: true };

    return new Date(Date.now() + MS[unit] * amount).toISOString();
}

// ----------------------------------------------------------------------------
// GET /api/panel/verify - يتأكد الفرونت إن الهوية صحيحة قبل ما يعرض أي شي
// ----------------------------------------------------------------------------
router.get('/verify', (req, res) => {
    res.json({ ok: true, discordId: req.dashboardUser.discordId });
});

// ----------------------------------------------------------------------------
// Bot State (Full Shutdown / Maintenance / Online Status)
// ----------------------------------------------------------------------------
router.get('/state', async (req, res) => {
    try {
        const state = await panelQueries.getBotState();
        if (!state) return res.status(500).json({ error: 'Failed to load bot state' });
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/state', async (req, res) => {
    try {
        const { full_shutdown_enabled, maintenance_enabled, maintenance_message, online_status } = req.body;
        const updates = {};
        if (typeof full_shutdown_enabled === 'boolean') updates.full_shutdown_enabled = full_shutdown_enabled;
        if (typeof maintenance_enabled === 'boolean') updates.maintenance_enabled = maintenance_enabled;
        if (typeof maintenance_message === 'string') updates.maintenance_message = maintenance_message;
        if (typeof online_status === 'string') {
            if (!['online', 'idle', 'dnd', 'invisible'].includes(online_status)) {
                return res.status(400).json({ error: 'Invalid online_status value' });
            }
            updates.online_status = online_status;
        }

        const updated = await panelQueries.updateBotState(updates, req.dashboardUser.discordId);

        // تحديث فوري للكاش اللي يعتمد عليه البوت (بدل انتظار 10 ثواني)
        await botState.invalidateBotState();

        // Presence يتحدّث حي فوراً لو تغيّر - نفس نمط require('./index')
        // الموجود أصلاً بـ apiServer.js لباقي الـ routes الحية.
        if (updates.online_status) {
            try {
                const client = require('../index');
                if (client.isReady && client.isReady()) {
                    client.user.setPresence({ status: updates.online_status });
                }
            } catch (presenceErr) {
                console.error('[Panel] Failed to update live presence:', presenceErr.message);
            }
        }

        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// Feature Flags
// ----------------------------------------------------------------------------
router.get('/feature-flags', async (req, res) => {
    try {
        const scope = req.query.scope === 'user' ? 'user' : 'global';
        const targetUserId = req.query.target || null;
        if (scope === 'user' && !targetUserId) {
            return res.status(400).json({ error: 'target is required when scope=user' });
        }
        const flags = await panelQueries.getFeatureFlags(scope, targetUserId);
        res.json(flags);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/feature-flags', async (req, res) => {
    try {
        const { scope, target_user_id, flags, overrideUserIds } = req.body;
        if (!scope || !flags || typeof flags !== 'object') {
            return res.status(400).json({ error: 'scope and flags are required' });
        }
        if (scope === 'user' && !target_user_id) {
            return res.status(400).json({ error: 'target_user_id is required when scope=user' });
        }

        // [NEW - Conflict Resolution] "تطبيق على الكل": المشرف اختار صراحة إن
        // التغيير العام يطغى على تخصيصات فردية موجودة لبعض المستخدمين على
        // بالضبط الفلاقات المُرسلة هنا (flags) - نحذفها أولاً (نهائياً) قبل
        // الكتابة العامة، عشان ما يفضلوا يطغون على القيمة الجديدة بعدها.
        // scope==='user' ما له علاقة بهالمنطق أصلاً (تعديل شخص واحد بالتعريف).
        if (scope === 'global' && Array.isArray(overrideUserIds) && overrideUserIds.length > 0) {
            await panelQueries.deleteFeatureFlagOverrides(Object.keys(flags), overrideUserIds);
        }

        const updated = await panelQueries.setFeatureFlags(scope, target_user_id || null, flags);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// [NEW - Conflict Resolution] فحص تعارض قبل حفظ Global: أي مستخدمين عندهم
// تخصيص فردي فعلاً على بالضبط الفلاقات اللي المشرف بصدد تغييرها (يُمرَّرها
// الفرونت بعد ما يقارن الحالة الجديدة بالقديمة - راجع Adminpanel.js). ما
// يمس أي بيانات، قراءة بس - الفرونت يقرر بعدها يعرض نافذة اختيار أو لا.
// ----------------------------------------------------------------------------
router.get('/feature-flags/conflicts', async (req, res) => {
    try {
        const flagKeys = String(req.query.flagKeys || '').split(',').map(k => k.trim()).filter(Boolean);
        if (flagKeys.length === 0) return res.json({ conflicts: [] });

        const overrides = await panelQueries.getFeatureFlagOverrides(flagKeys);

        // تجميع حسب المستخدم: { userId: ['auto_mod', 'anti_alt', ...] }
        const byUser = {};
        overrides.forEach(row => {
            if (!byUser[row.target_user_id]) byUser[row.target_user_id] = [];
            byUser[row.target_user_id].push(row.flag_key);
        });

        const client = require('../index');
        const canResolve = client?.isReady && client.isReady();

        const conflicts = Object.entries(byUser).map(([userId, keys]) => ({
            userId,
            user: canResolve ? resolveDiscordIdentity(client, userId) : { id: userId, username: null, displayName: userId, avatarUrl: null },
            flagKeys: keys
        }));

        res.json({ conflicts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// Global Search (Autocomplete) - user id / username / server id / server name
// [حدود معروفة] البحث يعتمد على كاش البوت (client.users.cache / client.guilds.cache)
// - يعني بيلقى بس المستخدمين اللي البوت شافهم فعلياً (بأي سيرفر مشترك)، مو
// أي مستخدم ديسكورد بالعالم. هذا طبيعي وحتمي لأي بوت (ما فيه "بحث شامل بكل
// ديسكورد" عبر الـ API). قناة الاقتراحات مبنية عليه ونتائجه محدودة بـ 15.
// ----------------------------------------------------------------------------
router.get('/search', (req, res) => {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        if (q.length < 1) return res.json({ users: [], servers: [] });

        const client = require('../index');
        if (!client.isReady || !client.isReady()) {
            return res.status(503).json({ error: 'Bot is not ready yet' });
        }

        const isNumericId = /^\d{15,25}$/.test(q);

        const users = [];
        for (const user of client.users.cache.values()) {
            if (user.bot) continue;
            const match = isNumericId
                ? user.id === q
                : user.username.toLowerCase().includes(q) || (user.globalName || '').toLowerCase().includes(q);
            if (match) {
                users.push({
                    id: user.id,
                    username: user.username,
                    displayName: user.globalName || user.username,
                    avatarUrl: user.displayAvatarURL({ size: 64 })
                });
            }
            if (users.length >= 15) break;
        }

        const servers = [];
        for (const guild of client.guilds.cache.values()) {
            const match = isNumericId
                ? guild.id === q
                : guild.name.toLowerCase().includes(q);
            if (match) {
                servers.push({
                    id: guild.id,
                    name: guild.name,
                    iconUrl: guild.iconURL({ size: 64 }) || null,
                    memberCount: guild.memberCount
                });
            }
            if (servers.length >= 15) break;
        }

        res.json({ users, servers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// Bot-Wide Ban (يمنع المستخدم من الداشبورد + كل أوامر البوت بكل السيرفرات)
// ----------------------------------------------------------------------------
router.get('/ban/:userId', async (req, res) => {
    try {
        const ban = await panelQueries.getUserBan(req.params.userId);
        res.json(ban || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/ban', async (req, res) => {
    try {
        const { targetUserId, reason, duration } = req.body;
        if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required' });

        let expiresAt = null;
        if (duration) {
            const parsed = parseDurationToExpiryDate(duration);
            if (!parsed || parsed.error) {
                return res.status(400).json({ error: 'Invalid duration format. Use e.g. 1s, 1m, 1h, 1d, 1w, 1mo, 1y' });
            }
            expiresAt = parsed;
        }

        const ban = await panelQueries.banUser({
            userId: targetUserId,
            reason,
            bannedBy: req.dashboardUser.discordId,
            expiresAt
        });

        await botState.invalidateBotState();
        res.json(ban);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/ban/:userId', async (req, res) => {
    try {
        await panelQueries.unbanUser(req.params.userId);
        await botState.invalidateBotState();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// [NEW] Ban All Users (Global Ban) - فلاق واحد بـ panel_bot_state بدل صف
// لكل مستخدم (راجع botState.js: isUserBotBanned يستثني السوبر أدمن تلقائياً
// عشان ما يقفل نفسه بره).
// ----------------------------------------------------------------------------
router.post('/ban-all', async (req, res) => {
    try {
        const { reason, duration } = req.body;

        let expiresAt = null;
        if (duration) {
            const parsed = parseDurationToExpiryDate(duration);
            if (!parsed || parsed.error) {
                return res.status(400).json({ error: 'Invalid duration format. Use e.g. 1s, 1m, 1h, 1d, 1w, 1mo, 1y' });
            }
            expiresAt = parsed;
        }

        const state = await panelQueries.setGlobalBan({
            reason,
            bannedBy: req.dashboardUser.discordId,
            expiresAt
        });

        await botState.invalidateBotState();
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/ban-all', async (req, res) => {
    try {
        const state = await panelQueries.clearGlobalBan();
        await botState.invalidateBotState();
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// Admin Actions (Alert / Update / Note) - "Account Action Notice"
// ----------------------------------------------------------------------------
router.post('/actions', async (req, res) => {
    try {
        const {
            scope, targetUserId, actionType, badgeColor,
            title, message, deliveryChannel, requiresAck, overrideUserIds
        } = req.body;

        if (!scope || !actionType || !title || !message) {
            return res.status(400).json({ error: 'scope, actionType, title and message are required' });
        }
        if (scope === 'user' && !targetUserId) {
            return res.status(400).json({ error: 'targetUserId is required when scope=user' });
        }

        const action = await panelQueries.createAdminAction({
            scope,
            targetUserId: targetUserId || null,
            actionType,
            badgeColor,
            title,
            message,
            deliveryChannel,
            requiresAck: !!requiresAck,
            createdBy: req.dashboardUser.discordId
        });

        // [NEW - Conflict Resolution] "تطبيق على الكل": المشرف اختار صراحة إن
        // هالإشعار العام الجديد يطغى على أي إشعار فردي فعّال حالياً لمستخدمين
        // محددين - نعطّل إشعاراتهم الفردية نهائياً (Permanent - راجع تعليق
        // deactivateActiveIndividualActionsForUsers) عشان getActiveNoticeForUser
        // يرجع يعرض لهم هالإشعار العام الجديد بدل ما يتجاهلونه. مستقل عن نجاح/
        // فشل إرسال الإشعار نفسه (اللي أصلاً نجح فوق هذا السطر).
        if (scope === 'global' && Array.isArray(overrideUserIds) && overrideUserIds.length > 0) {
            try {
                await panelQueries.deactivateActiveIndividualActionsForUsers(overrideUserIds);
            } catch (overrideErr) {
                console.error('[Panel] Failed to override individual notices:', overrideErr.message);
            }
        }

        // إرسال الـ DM لو مطلوب (dm أو both) ولو الهدف مستخدم محدد (مو Global بالكامل)
        if ((deliveryChannel === 'dm' || deliveryChannel === 'both') && targetUserId) {
            try {
                const client = require('../index');
                const user = await client.users.fetch(targetUserId);
                await user.send(`**${title}**\n${message}`);
            } catch (dmErr) {
                console.error('[Panel] DM delivery failed:', dmErr.message);
                await panelQueries.markDmFailed(action.id);
                action.dm_delivery_failed = true;
            }
        }

        res.json(action);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// [NEW - Conflict Resolution] فحص تعارض قبل إرسال إشعار Global: أي مستخدمين
// عندهم إشعار فردي فعّال حالياً (يطغى دايماً على أي Global جديد - راجع
// getActiveNoticeForUser). قراءة بس، الفرونت يقرر بعدها يعرض نافذة اختيار.
// ----------------------------------------------------------------------------
router.get('/actions/active-individual', async (req, res) => {
    try {
        const activeActions = await panelQueries.listActiveIndividualActions();

        const client = require('../index');
        const canResolve = client?.isReady && client.isReady();

        const conflicts = activeActions.map(a => ({
            userId: a.target_user_id,
            user: canResolve ? resolveDiscordIdentity(client, a.target_user_id) : { id: a.target_user_id, username: null, displayName: a.target_user_id, avatarUrl: null },
            actionId: a.id,
            actionType: a.action_type,
            title: a.title,
            at_created: a.at_created
        }));

        res.json({ conflicts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/actions/:id', async (req, res) => {
    try {
        await panelQueries.deactivateAdminAction(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// [NEW] Logs - يستبدل /dm-failures القديمة (كانت تعرض فشل الـ DM بس).
// يجمع: الحظر الفردي + حالة الحظر الجماعي + كل الإشعارات (Alert/Update/
// Note/Ban) مع حالة تسليم كل قناة، بهوية Discord محلولة (اسم + صورة) من
// كاش البوت لو متوفرة - نفس أسلوب /search فوق. كل صف يحمل معلومات كافية
// لأزرار Undo بالواجهة (تستخدم endpoints الحذف الموجودة أصلاً: DELETE
// /ban/:userId, DELETE /ban-all, DELETE /actions/:id - ما احتجنا endpoints
// جديدة للتراجع، موجودة فعلاً).
// ----------------------------------------------------------------------------
function resolveDiscordIdentity(client, id) {
    if (!id) return null;
    const user = client?.users?.cache?.get(id);
    if (!user) return { id, username: null, displayName: id, avatarUrl: null };
    return {
        id,
        username: user.username,
        displayName: user.globalName || user.username,
        avatarUrl: user.displayAvatarURL({ size: 64 })
    };
}

router.get('/logs', async (req, res) => {
    try {
        const client = require('../index');
        const canResolve = client?.isReady && client.isReady();

        const [bans, botState_, actions] = await Promise.all([
            panelQueries.listAllBans(),
            panelQueries.getBotState(),
            panelQueries.listAllActions({ limit: 100 })
        ]);

        const individualBans = bans.map(b => ({
            id_user: b.id_user,
            user: canResolve ? resolveDiscordIdentity(client, b.id_user) : null,
            reason: b.reason,
            banned_by: b.banned_by,
            bannedByUser: canResolve ? resolveDiscordIdentity(client, b.banned_by) : null,
            at_created: b.at_created,
            at_expires: b.at_expires
        }));

        const globalBan = botState_?.global_ban_enabled ? {
            enabled: true,
            reason: botState_.global_ban_reason,
            banned_by: botState_.global_ban_by,
            bannedByUser: canResolve ? resolveDiscordIdentity(client, botState_.global_ban_by) : null,
            at_expires: botState_.global_ban_expires,
            at_updated: botState_.at_updated
        } : { enabled: false };

        const actionLogs = actions.map(a => {
            const dmAttempted = a.delivery_channel === 'dm' || a.delivery_channel === 'both';
            const dashboardAttempted = a.delivery_channel === 'dashboard' || a.delivery_channel === 'both';
            return {
                id: a.id,
                scope: a.scope,
                target_user_id: a.target_user_id,
                targetUser: (canResolve && a.target_user_id) ? resolveDiscordIdentity(client, a.target_user_id) : null,
                action_type: a.action_type,
                badge_color: a.badge_color,
                title: a.title,
                message: a.message,
                delivery_channel: a.delivery_channel,
                requires_ack: a.requires_ack,
                active: a.active,
                acked_count: a.acked_count,
                created_by: a.created_by,
                at_created: a.at_created,
                // [NEW] حالة تسليم واضحة لكل قناة - dashboard دايماً "delivered"
                // منطقياً طالما مُختارة (قراءة سحب، ما فيها فشل شبكي حقيقي)،
                // dm تعتمد فعلياً على dm_delivery_failed.
                delivery_status: {
                    dashboard: dashboardAttempted ? 'delivered' : 'not_attempted',
                    dm: !dmAttempted ? 'not_attempted' : (a.dm_delivery_failed ? 'failed' : 'delivered')
                }
            };
        });

        res.json({ bans: individualBans, globalBan, actions: actionLogs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------------
// Leave Guild - مستقل تماماً عن نظام الحظر، يُستدعى من نفس نتيجة البحث
// ----------------------------------------------------------------------------
router.post('/leave-guild', async (req, res) => {
    try {
        const { guildId } = req.body;
        if (!guildId) return res.status(400).json({ error: 'guildId is required' });

        const client = require('../index');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Bot is not in this guild' });

        await guild.leave();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;