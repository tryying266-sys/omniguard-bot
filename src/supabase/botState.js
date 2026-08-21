// ============================================================================
// botState.js - Shared In-Memory Cache for Panel State (v1.0)
// ============================================================================
// نقطة الحقيقة الوحيدة لحالة البوت العامة (Full Shutdown / Maintenance /
// Online Status) وحظر المستخدمين البوت-وايد (panel_user_bans). يُستخدم من:
//
//   - client.js               -> يقرر يبتلع الأحداث أو لا (Full Shutdown)
//   - commands/commandhandler.js -> بوابة Maintenance/Ban لمسار البريفكس
//   - slashCommandsHandler.js -> نفس البوابة بالضبط لمسار السلاش
//   - index.js                -> ضبط الـ Presence عند 'ready' وبعد كل تحديث
//   - panelRouter.js          -> يكتب التحديثات ويصفّر الكاش فوراً (invalidate)
//
// [التصميم] كاش بالذاكرة (In-Memory) يتحدّث دوري كل REFRESH_INTERVAL_MS، بدل
// ما كل رسالة/أمر يسوي استعلام Supabase مستقل - نفس فلسفة inFlightMemberFetches
// بـ authMiddleware.js (تقليل الضغط + سرعة الفحص، وهو أمر يُفحص لكل رسالة/أمر
// بالبوت كامل). أي تحديث فعلي من الـ Adminpanel (PUT) يستدعي invalidate() فوراً
// عشان ما ينتظر البوت لين الدورة الجاية.
// ============================================================================

const supabase = require('./db');

const REFRESH_INTERVAL_MS = 10000; // 10 ثواني - كافية لتحديث حي بدون ضغط زايد

let cachedBotState = {
    fullShutdownEnabled: false,
    maintenanceEnabled: false,
    maintenanceMessage: 'OmniGuard is currently under scheduled maintenance. Please try again later.',
    onlineStatus: 'online',
    // [NEW] Ban All Users - فلاق واحد بدل صف لكل مستخدم بـ panel_user_bans
    // (راجع isUserBotBanned تحت لمنطق الاستثناء + انتهاء الصلاحية).
    globalBanEnabled: false,
    globalBanReason: null,
    globalBanExpires: null
};

// Set<string> - قائمة IDs المحظورين حالياً (بعد استبعاد المنتهية صلاحيتها)
let cachedBannedUserIds = new Set();

let refreshTimer = null;
let lastRefreshAt = 0;

/**
 * يجلب حالة البوت + قائمة المحظورين من Supabase ويحدّث الكاش المحلي.
 * لا يرمي استثناء أبداً - أي خطأ يُسجَّل بس، والكاش القديم يفضل مستخدم
 * (Fail-Safe: لو Supabase وقع لحظياً، البوت يكمّل بآخر حالة معروفة بدل ما يعطّل نفسه).
 */
async function refreshBotState() {
    try {
        const { data: stateRow, error: stateErr } = await supabase
            .from('panel_bot_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (!stateErr && stateRow) {
            // [NEW] الحظر الجماعي "فعّال" فقط لو enabled=true وما انتهت صلاحيته
            // بعد (نفس فلسفة تصفية panel_user_bans تحت بـ at_expires) - نحسبها
            // هنا مرة وحدة عشان isUserBotBanned تبقى فحص Set/boolean بسيط بدون
            // مقارنة تواريخ بكل نداء.
            const globalBanExpires = stateRow.global_ban_expires || null;
            const globalBanNotExpired = !globalBanExpires || new Date(globalBanExpires) > new Date();

            cachedBotState = {
                fullShutdownEnabled: stateRow.full_shutdown_enabled === true,
                maintenanceEnabled: stateRow.maintenance_enabled === true,
                maintenanceMessage: stateRow.maintenance_message || cachedBotState.maintenanceMessage,
                onlineStatus: stateRow.online_status || 'online',
                globalBanEnabled: stateRow.global_ban_enabled === true && globalBanNotExpired,
                globalBanReason: stateRow.global_ban_reason || null,
                globalBanExpires
            };
        }

        const nowIso = new Date().toISOString();
        const { data: bans, error: bansErr } = await supabase
            .from('panel_user_bans')
            .select('id_user, at_expires')
            .or(`at_expires.is.null,at_expires.gt.${nowIso}`);

        if (!bansErr && Array.isArray(bans)) {
            cachedBannedUserIds = new Set(bans.map(b => b.id_user));
        }

        lastRefreshAt = Date.now();
    } catch (err) {
        console.error('[BotState] Refresh failed (keeping last known state):', err.message);
    }
}

/**
 * يبدأ دورة التحديث الدوري. يُستدعى مرة وحدة من index.js وقت 'ready'.
 */
function startBotStatePolling() {
    if (refreshTimer) return; // idempotent - ما يبدأ مرتين
    refreshBotState(); // تحميل فوري أول مرة، ما ننتظر أول Interval
    refreshTimer = setInterval(refreshBotState, REFRESH_INTERVAL_MS);
    console.log('[BotState] Polling started (every 10s)');
}

/**
 * يُستدعى من panelRouter.js فوراً بعد أي PUT ناجح - يفرض تحديث فوري بدل
 * انتظار الدورة الجاية (تجربة استخدام أفضل: التغيير ينعكس على البوت مباشرة).
 */
async function invalidateBotState() {
    await refreshBotState();
}

/**
 * قراءة متزامنة سريعة (Sync) - تُستخدم بكل نقطة فحص (commandhandler.js,
 * slashCommandsHandler.js, client.js) بدون أي await، عشان ما تبطئ أي شي.
 */
function getBotState() {
    return cachedBotState;
}

/**
 * [FIX] الحين تفحص الحظر الفردي (panel_user_bans) وكمان الحظر الجماعي
 * (panel_bot_state.global_ban_enabled) بنداء واحد - كل مكان بالبوت يستخدم
 * هذي الدالة (commandhandler.js/slashCommandsHandler.js/apiServer.js)
 * يستفيد من الحظر الجماعي تلقائياً بدون أي تعديل إضافي بتلك الملفات.
 *
 * [SAFETY] السوبر أدمن (SUPER_ADMIN_DISCORD_ID بـ .env) مستثنى صراحة من
 * الحظر الجماعي - وإلا لو فعّله على نفسه بالغلط (أو بالحظر الفردي أيضاً
 * بنفس المنطق)، يفقد كل وصول للداشبورد/البوت بما فيها Adminpanel نفسها
 * اللي يقدر يلغي الحظر منها - قفل ذاتي بدون مخرج.
 */
function isUserBotBanned(discordId) {
    if (discordId && discordId === process.env.SUPER_ADMIN_DISCORD_ID) return false;
    if (cachedBannedUserIds.has(discordId)) return true;
    if (cachedBotState.globalBanEnabled) return true;
    return false;
}

module.exports = {
    startBotStatePolling,
    invalidateBotState,
    getBotState,
    isUserBotBanned,
    // للتشخيص/الاختبار فقط
    _debugLastRefreshAt: () => lastRefreshAt
};