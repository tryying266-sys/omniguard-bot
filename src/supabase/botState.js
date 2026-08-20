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
    onlineStatus: 'online'
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
            cachedBotState = {
                fullShutdownEnabled: stateRow.full_shutdown_enabled === true,
                maintenanceEnabled: stateRow.maintenance_enabled === true,
                maintenanceMessage: stateRow.maintenance_message || cachedBotState.maintenanceMessage,
                onlineStatus: stateRow.online_status || 'online'
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

function isUserBotBanned(discordId) {
    return cachedBannedUserIds.has(discordId);
}

module.exports = {
    startBotStatePolling,
    invalidateBotState,
    getBotState,
    isUserBotBanned,
    // للتشخيص/الاختبار فقط
    _debugLastRefreshAt: () => lastRefreshAt
};