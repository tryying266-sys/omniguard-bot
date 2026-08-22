// ============================================================================
// apiServer.js - OmniGuard Dashboard Backend API Server (v3.0 - Universal)
// ============================================================================
// تحديث: تم الحفاظ على كافة وظائف الأمان، التوجيه، وخدمة الصفحات الثابتة.
// تم التأكد من عدم فقدان أي بيانات (Discord Token, API Key, Middleware logic).
// ============================================================================

const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// استيراد الـ Router المطور (الذي سيقبل مسارات التزامن الشاملة)
const apiRouter = require('./supabase/apiRouter');
const dbUtils = require('./supabase/dbUtils');
// [SECURITY REWRITE] طبقة الهوية والصلاحيات الموحّدة (راجع authMiddleware.js) -
// نفس التطبيق يستخدمه apiRouter.js كمان.
const { attachDashboardUser, requireDiscordPermission, requirePanelOwner, dashboardCooldown, PermissionsBitField } = require('./supabase/authMiddleware');
const panelRouter = require('./supabase/panelRouter');
const panelQueries = require('./supabase/panelQueries');
const DISCORD_API = 'https://discord.com/api/v10';
const botHeaders = { Authorization: `Bot ${process.env.DISCORD_TOKEN}` };

/**
 * Utility function to fetch data from Discord API
 * (محافظة على وظيفتها الأصلية لجلب بيانات السيرفر الحية)
 */
async function discordFetch(endpoint) {
    const res = await fetch(`${DISCORD_API}${endpoint}`, { headers: botHeaders });
    if (!res.ok) {
        const err = new Error(`Discord API Error: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

const app = express();
const PORT = process.env.PORT || process.env.DASHBOARD_API_PORT || 4000;

// Express Middleware
app.use(express.json());
app.use(cors());

// ============================================
// [NEW] Global Access Gate - يغطي الداشبورد كامل: حظر فردي/جماعي + وضع
// الصيانة، ببوابة واحدة موحّدة قبل أي route (بدل تكرار الفحص بكل route).
// ============================================
// [مهم - SERVER-SIDE ENFORCEMENT] الحظر السابق كان موجود، لكن الصيانة
// كانت client-side بس (بانر بالواجهة) - يعني أي حد يقدر يتجاوزها بسهولة
// (تعطيل JS، نداء الـ API مباشرة، إلخ). الحين: أثناء الصيانة، أي طلب API
// من أي مستخدم غير السوبر أدمن يُرفض هنا مباشرة بغض النظر عن الواجهة -
// حماية فعلية على مستوى السيرفر، مو مجرد إخفاء بصري.
//
// السوبر أدمن مستثنى بالكامل من الحظر والصيانة معاً (نفس استثناء
// isUserBotBanned لكن هنا عالمي على كل الـ routes، عشان يقدر يوصل
// لـ Adminpanel نفسها ويوقف الصيانة/الحظر الجماعي - وإلا يقفل نفسه بره).
const { isUserBotBanned, getBotState } = require('./supabase/botState');

// استثناء صريح لمسارات account-notice (GET + POST /:id/ack) و
// maintenance-status من البوابة العامة. بدونه: المستخدم المحظور/بوضع
// الصيانة يضرب رفض على *كل* طلب - بما فيه بالضبط الطلب اللي يجيب له
// إشعار "تم حظرك" أو رسالة الصيانة، فتنتج مفارقة: يُمنع من رؤية سبب
// المنع. هذا الاستثناء لا يوسّع أي صلاحية فعلية - كلا الـ endpoint ترجّع
// بيانات خاصة بصاحب الطلب نفسه أو عامة غير حساسة فقط.
const ACCESS_GATE_EXEMPT_PATHS = ['/api/account-notice', '/api/maintenance-status'];
function isAccessGateExempt(path) {
    return ACCESS_GATE_EXEMPT_PATHS.some(p => path === p || path.startsWith(`${p}/`));
}

app.use(async (req, res, next) => {
    if (isAccessGateExempt(req.path)) return next();

    const token = req.headers['x-user-token'];
    if (!token) return next(); // ما فيه هوية أصلاً - الرفض الطبيعي يصير لاحقاً بمكانه المعتاد

    await attachDashboardUser(req, res, () => {});
    const discordId = req.dashboardUser?.discordId;
    const isSuperAdmin = discordId && discordId === process.env.SUPER_ADMIN_DISCORD_ID;

    if (!isSuperAdmin && discordId) {
        if (isUserBotBanned(discordId)) {
            return res.status(403).json({ error: 'Your account has been banned from using OmniGuard.', banned: true });
        }
        if (getBotState().maintenanceEnabled) {
            return res.status(503).json({ error: 'OmniGuard is currently under scheduled maintenance.', maintenance: true });
        }
    }
    next();
});

// ============================================
// 1. Security Middleware (Authentication)
// ============================================
// [SECURITY REWRITE] الطبقة القديمة كانت تتحقق من مفتاح ثابت واحد
// (DASHBOARD_API_KEY) مشترك بين كل المستخدمين - وهذا المفتاح كان مكشوف
// بالكامل بملف dashboard.js (visible بـ View Source لأي زائر). حُذفت
// نهائياً. الحماية الفعلية الحين: attachDashboardUser + requireDiscordPermission
// المستوردين فوق - يتحققون من هوية Supabase الحقيقية وصلاحية ديسكورد
// الحية لكل طلب.

// ============================================
// 2. Live Discord Data Endpoints
// ============================================

/**
 * Fetch Text Channels for a specific Guild
 */
app.get('/api/guild/:guildId/channels', attachDashboardUser, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const allChannels = await discordFetch(`/guilds/${req.params.guildId}/channels`);
        const channels = allChannels
            .filter(c => c.type === 0)
            .map(c => ({ id: c.id, name: c.name }));
        res.json(channels);
    } catch (error) {
        console.error('[API Error] Fetch Channels:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

/**
 * Fetch Roles for a specific Guild
 */
app.get('/api/guild/:guildId/roles', attachDashboardUser, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const allRoles = await discordFetch(`/guilds/${req.params.guildId}/roles`);
        const roles = allRoles
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map(r => ({
                id: r.id,
                name: r.name,
                color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : '#000000'
            }));
        res.json(roles);
    } catch (error) {
        console.error('[API Error] Fetch Roles:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

/**
 * [NEW] يرجّع قائمة IDs السيرفرات اللي البوت موجود فيها فعلياً حالياً.
 * الداشبورد يستخدمها فوراً بعد اللوجن عشان يقسّم سيرفرات المستخدم
 * الإدارية لقسمين: "مُدارة فعلاً" (البوت موجود) مقابل "لسه ما انضافت"
 * (البوت مو موجود) - نفس الأسلوب اللي تسويه البوتات الاحترافية.
 * القراءة من client.guilds.cache مباشرة (نفس الـ process - راجع
 * require('./index') بآخر هذا الملف) - فورية، بدون أي طلب فعلي لديسكورد.
 */
  app.get('/api/bot/guilds', attachDashboardUser, (req, res) => {
    if (!req.dashboardUser) {
        return res.status(401).json({ error: 'Unauthorized: No valid user session provided.' });
    }
    try {
        const client = require('./index');
        if (!client.isReady || !client.isReady()) {
            return res.status(503).json({ error: 'Bot is not ready yet. Please try again in a moment.' });
        }
        const guildIds = client.guilds.cache.map(g => g.id);
        res.json({ guildIds });
    } catch (error) {
        console.error('[API Error] Fetch Bot Guilds:', error.message);
        res.status(500).json({ error: 'Failed to fetch bot guild list' });
    }
});

// ============================================
// 3. Guild Management Endpoints
// ============================================

/**
 * Update Bot Nickname in a specific Guild
 * (محافظة على وظيفة التحديث الفوري للقب البوت)
 */
app.put('/api/guild/:guildId/nickname', attachDashboardUser, dashboardCooldown, requireDiscordPermission(PermissionsBitField.Flags.ManageGuild), async (req, res) => {
    try {
        const { nickname } = req.body;
        const guildId = req.params.guildId;
        
        await fetch(`${DISCORD_API}/guilds/${guildId}/members/@me`, {
            method: 'PATCH',
            headers: { ...botHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ nick: nickname })
        });

        // [GRS Fix] لازم تحديث nickname_server بقاعدة البيانات كمان، وإلا
        // GRS.js بيرجّع النيكنيم القديم عند أي حدث guildMemberUpdate قادم.
        await dbUtils.universalUpdate('setting_guild', guildId, { nickname_server: nickname });
        
        res.json({ success: true });
    } catch (error) {
        console.error('[API Error] Nickname Update:', error.message);
        res.status(500).json({ error: 'Failed to update nickname on Discord' });
    }
});

/**
 * [NEW] Middleware: يحاول يتعرف على هوية المستخدم المسجل دخول (لو أرسل
 * هيدر X-User-Token) ويحط النتيجة بـ req.dashboardUser. لا يرفض الطلب لو
 * فشل أو ما فيه توكن - هذا فحص "تعريف هوية" بس، الرفض الفعلي (403) يصير
 * لاحقاً على مستوى كل route حساس بـ apiRouter.js (عبر requireStaffRole)،
 * حسب هل الـ route يحتاج هوية أصلاً أو لا.
 */

// Route database requests to the Supabase API Router
// [SECURITY REWRITE] ما فيه authMiddleware (مفتاح ثابت) هنا بعد الآن -
// كل route حساس جوه apiRouter.js يتحقق بنفسه الحين عبر requireDiscordPermission.
// [NEW] كولداون الحفظ (dashboardCooldown) *ما* يحتاج يُضاف هنا - apiRouter.js
// نفسه مسجّل عليه (`router.use(dashboardCooldown)` بأعلى ذاك الملف)، فيغطي
// كل route جواه تلقائياً. لو انضاف مستقبلاً أي route كتابة (POST/PUT/DELETE)
// *مباشر* هنا بـ apiServer.js (خارج apiRouter.js تماماً، زي /nickname فوق)،
// لازم يُضاف dashboardCooldown لسلسلة الميدلويرات الخاصة فيه يدوياً - نفس
// ما صار بالضبط بـ route الـ /nickname فوق.
app.use('/api', attachDashboardUser, apiRouter);

// ============================================
// 3.5 [NEW] Admin Control Panel (Adminpanel.html) - Owner-Only Surface
// ============================================
// [SECURITY DESIGN - مهم تقرأه] نفس فلسفة كل صفحات الداشبورد الموجودة أصلاً:
// ملف الـ HTML/JS نفسه "عام" تقنياً (Static Asset)، لكن فاضي وظيفياً بدون
// أي بيانات - كل استدعاء API فعلي (verify/state/search/ban/actions...)
// يمر عبر requirePanelOwner ويرجّع 404 لأي حد غيرك. هذا اضطراري تقنياً،
// مو تهاون: توكن الهوية (X-User-Token) يُرسل فقط من JS بعد ما الصفحة تفتح
// وتتحقق من جلسة Supabase بالمتصفح (نفس آلية dashboard.js بالضبط) - أول
// GET خام للصفحة (فتح رابط بالمتصفح) ما يقدر يحمل هيدر مخصص أصلاً، فما
// ينفع نحط requirePanelOwner على تقديم الملف نفسه (كان سيقفل حتى عليك أنت).
//
// الحماية الفعلية إذن هي: (1) مسار سري غير متوقَّع PANEL_SECRET_PATH -
// محتاج تحدده بـ .env، ما تحزره أي دودة بحث أو زائر عشوائي، (2) الصفحة
// فاضية تمامًا بدون أي بيانات حقيقية لين تنجح requirePanelOwner على كل
// نداء API. أي حد غيرك يفتح الرابط (لو خمّنه) بيشوف صفحة فاضية ما تشتغل،
// وكل استدعاء API يرجع 404 بالضبط.
if (!process.env.PANEL_SECRET_PATH) {
    console.error('[Panel Security] PANEL_SECRET_PATH is not set in .env - Adminpanel will NOT be reachable at all until you set it (e.g. PANEL_SECRET_PATH=/x7k9-ctrl-2891).');
}
const PANEL_SECRET_PATH = process.env.PANEL_SECRET_PATH || '/__panel_disabled__';
const privatePanelFolder = path.join(__dirname, '..', 'private-panel');
app.use(PANEL_SECRET_PATH, express.static(privatePanelFolder, { extensions: ['html'] }));

// كل عمليات الأدمن الفعلية (بحث، حظر، إشعارات، حالة البوت...) محمية هنا -
// هذا هو خط الدفاع الحقيقي، مو تقديم الملف فوق.
app.use('/api/panel', attachDashboardUser, requirePanelOwner, panelRouter);

// ============================================
// 3.6 [NEW] Account Action Notice - endpoint عام لكل مستخدم داشبورد عادي
// ============================================
// مختلف تماماً عن /api/panel/* فوق: هذا لأي مستخدم مسجّل دخول عادي (مو
// بس صاحب اللوحة) عشان يشوف الإشعار الفعّال المُوجّه له (أو العام/Global)
// وقت ما يفتح داشبوردة هو - نفس البطاقة "Dashboard Preview" اللي تُبنى
// بـ Adminpanel.html، لكن هنا الجهة المستقبِلة الفعلية.
app.get('/api/account-notice', attachDashboardUser, async (req, res) => {
    if (!req.dashboardUser?.discordId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const notice = await panelQueries.getActiveNoticeForUser(req.dashboardUser.discordId);
        res.json(notice || null);
    } catch (error) {
        console.error('[API Error] Fetch Account Notice:', error.message);
        res.status(500).json({ error: 'Failed to load account notice' });
    }
});

app.post('/api/account-notice/:id/ack', attachDashboardUser, async (req, res) => {
    if (!req.dashboardUser?.discordId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        await panelQueries.acknowledgeNotice(req.params.id, req.dashboardUser.discordId);
        res.json({ success: true });
    } catch (error) {
        console.error('[API Error] Ack Account Notice:', error.message);
        res.status(500).json({ error: 'Failed to acknowledge notice' });
    }
});

// ============================================
// [NEW] Public Maintenance Status - endpoint عام خفيف (بدون requirePanelOwner)
// عشان dashboard.js يعرض شاشة حجب كاملة لو maintenance_enabled=true. مستثنى
// كمان من البوابة العامة (ACCESS_GATE_EXEMPT_PATHS فوق) - حتى المستخدم
// المحظور/بوضع الصيانة له حق يعرف السبب، بدون ما يكشف أي تفاصيل حساسة
// (full_shutdown/تفاصيل الحظر الجماعي غير مُرجعة هنا إطلاقاً).
// [NEW] attachDashboardUser هنا (اختياري - ما يرفض الطلب لو فشل) عشان
// نحسب bypass: هل هذا بالضبط السوبر أدمن؟ الفرونت يحتاجها يقرر يحجب
// نفسه أو لا - المقارنة الفعلية بـ SUPER_ADMIN_DISCORD_ID تصير هنا فقط
// (سيرفر)، ما تُكشف القيمة نفسها للعميل إطلاقاً.
// ============================================
app.get('/api/maintenance-status', attachDashboardUser, async (req, res) => {
    try {
        const status = await panelQueries.getPublicMaintenanceStatus();
        const isSuperAdmin = !!(req.dashboardUser?.discordId && req.dashboardUser.discordId === process.env.SUPER_ADMIN_DISCORD_ID);
        res.json({
            maintenance_enabled: status.maintenance_enabled === true,
            maintenance_message: status.maintenance_message || '',
            bypass: isSuperAdmin
        });
    } catch (error) {
        console.error('[API Error] Fetch Maintenance Status:', error.message);
        res.status(500).json({ error: 'Failed to load maintenance status' });
    }
});

// ============================================
// 3.7 [NEW] Effective Feature Flags - endpoint عام لكل مستخدم داشبورد عادي
// ============================================
// يرجّع الفلاقات الفعلية للمستخدم المسجّل دخول حالياً (استثناء فردي له لو
// موجود، وإلا الافتراضي العام) - dashboard.js يناديه بكل صفحة عشان يخفي
// عناصر الشريط الجانبي المقفولة + يمنع الوصول المباشر بالرابط للصفحة نفسها.
app.get('/api/feature-flags/effective', attachDashboardUser, async (req, res) => {
    if (!req.dashboardUser?.discordId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const flags = await panelQueries.getEffectiveFlagsForUser(req.dashboardUser.discordId);
        res.json(flags);
    } catch (error) {
        console.error('[API Error] Fetch Effective Feature Flags:', error.message);
        res.status(500).json({ error: 'Failed to load feature flags' });
    }
});

// ============================================
// 4. Static File Hosting
// ============================================
const staticFolder = path.join(__dirname, '..', 'Page');
app.use(express.static(staticFolder, { extensions: ['html'] }));

// Serve Dashboard UI
app.get('/', (req, res) => {
    res.sendFile(path.join(staticFolder, 'index.html'));
});

// ============================================
// 5. Server Initialization
// ============================================
app.listen(PORT, () => {
    console.log('==================================================');
    console.log(`[OmniGuard API] Gateway is running on port: ${PORT}`);
    console.log(`[OmniGuard API] Mode: Universal/Dynamic Binding Enabled`);
    console.log('==================================================');
});

// [NEW] تشغيل البوت (client.login) بنفس عملية Node هذي - عشان نستخدم
// Web Service مجاني وحد بدل Background Worker (مدفوع) + Web Service.
// index.js يفتح اتصال Discord Gateway بشكل مستقل، لا يتعارض مع Express
// فوق - الاثنين يشتغلون بالتوازي بنفس العملية (Node قادر يدير أكثر من
// اتصال I/O غير متزامن بنفس الوقت بدون مشكلة).

const deployCommands = require('./deploy-commands');

// تشغيل دالة رفع الأوامر أولاً، وبمجرد انتهائها يتم تشغيل البوت
deployCommands().then(() => {
    require('./index');
}).catch(err => {
    console.error('[Deploy Error]:', err);
    require('./index'); // تشغيل البوت حتى لو فشل رفع الأوامر لضمان عدم توقف الخدمة
});

// Global Error Handler
process.on('uncaughtException', (err) => {
    console.error('[Fatal System Error]:', err);
});