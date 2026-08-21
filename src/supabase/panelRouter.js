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
        const { scope, target_user_id, flags } = req.body;
        if (!scope || !flags || typeof flags !== 'object') {
            return res.status(400).json({ error: 'scope and flags are required' });
        }
        if (scope === 'user' && !target_user_id) {
            return res.status(400).json({ error: 'target_user_id is required when scope=user' });
        }
        const updated = await panelQueries.setFeatureFlags(scope, target_user_id || null, flags);
        res.json(updated);
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
            title, message, deliveryChannel, requiresAck
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

router.delete('/actions/:id', async (req, res) => {
    try {
        await panelQueries.deactivateAdminAction(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/dm-failures', async (req, res) => {
    try {
        const failures = await panelQueries.listDmFailures();
        res.json(failures);
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