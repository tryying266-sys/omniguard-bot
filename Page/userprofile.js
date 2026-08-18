/**
 * ======================================================
 * OmniGuard - User Profile & Moderation (user-profile.html)
 * ======================================================
 * يعتمد بالكامل على المتغيرات/الدوال العامة من dashboard.js:
 * API_BASE, getHeaders(), getGuildId(), showNotification(), toggleDropdown(),
 * fetchGuildStructure(), addDiscordTag(), collectTags(), renderTags().
 * لازم <script src="dashboard.js"> يكون قبل هذا الملف بالصفحة.
 *
 * [مراجعة] الرتب: صندوق #user_assigned_roles عليه data-source="roles" أصلاً
 * بالـ HTML - يعني fetchGuildStructure() + populateDiscordSelectors()
 * (الموجودتين بـ dashboard.js) تعبّي قائمة الرتب المنسدلة تلقائياً، بدون أي
 * كود إضافي هنا. الاستثناءات: data-source="commands" غير مدعومة بـ
 * dashboard.js (تتعامل بس مع roles/channels)، فنعبّيها يدوياً بالأسفل.
 */

const CONFIG = {
    // --- Top Banner ---
    avatarImgId: 'user_avatar',
    usernameId: 'user_name',
    userIdTextId: 'user_id',
    statusBadgeWrapperId: 'user_status_badge',
    statusTextId: 'user_status',

    // --- Kick Card ---
    kickReasonId: 'kick_reason',

    // --- Ban Card ---
    banReasonId: 'ban_reason',
    banDurationId: 'ban_delete_duration', // راجع الملاحظة عن تضارب الـ label - بانتظار تأكيدك
    unbanReasonId: 'ban_reason',

    // --- Warn Card ---
    warnReasonId: 'warn_reason',

    // --- Mute Card ---
    muteDurationId: 'mute_duration',
    muteReasonId: 'mute_reason',

    // --- Roles Card ---
    rolesBoxId: 'user_assigned_roles',
    rolesReasonId: 'roles_audit_reason',

    // --- Command Exceptions Card (مبسّط لمفتاح تشغيل واحد) ---
    exemptionToggleId: 'exemption_toggle',
    exemptionStatusId: 'exemption_toggle_status',

    // --- Tables ---
    altsTableBodyId: 'alts_table_body',
    logsTableBodyId: 'logs_table_body',
    modLogTableBodyId: 'moderator_log_table_body'
};

// أسماء الأوامر المتاحة للاستثناء - مطابقة لأسماء ملفات الأوامر الفعلية
const EXEMPTABLE_COMMANDS = [
    'kick', 'ban', 'unban', 'mute', 'unmute', 'warn', 'unwarn', 'roleadd', 'demote'
];

// ============================================================================
// STATE
// ============================================================================
let currentGuildId = null;
let currentUserId = null;

// ============================================================================
// API HELPERS
// ============================================================================
function getUserId() {
    return new URLSearchParams(window.location.search).get('userId');
}

async function apiGet(endpoint) {
    const res = await fetch(`${API_BASE}${endpoint}`, { headers: getHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
}

async function apiSend(method, endpoint, payload) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        method,
        headers: getHeaders(),
        body: JSON.stringify(payload || {})
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
}

function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

/**
 * [NEW] حالة كل زر تنفيذ مستقلة عن الثاني - بديل عن الإشعار الفوقي
 * (alert القديم). idle=رمادي معطّل | dirty=أحمر قابل للضغط | saved=أخضر
 * مؤقت | error=أحمر ثابت "Error - Retry" لحد إعادة المحاولة.
 */
const BUTTON_ORIGINAL_HTML = new Map();
const savedStateTimers = new Map(); // زر لكل مؤقت مستقل (مش مؤقت عام واحد)

function setButtonState(btn, state) {
    if (!btn) return;
    if (!BUTTON_ORIGINAL_HTML.has(btn)) BUTTON_ORIGINAL_HTML.set(btn, btn.innerHTML);

    clearTimeout(savedStateTimers.get(btn));
    btn.classList.remove('btn-idle', 'btn-saved', 'btn-error');

    if (state === 'idle') {
        btn.innerHTML = BUTTON_ORIGINAL_HTML.get(btn);
        btn.classList.add('btn-idle');
        btn.disabled = true;
    } else if (state === 'dirty') {
        btn.innerHTML = BUTTON_ORIGINAL_HTML.get(btn);
        btn.disabled = false;
    } else if (state === 'saved') {
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
        btn.classList.add('btn-saved');
        btn.disabled = true;
        // يرجع لحالته الطبيعية (dirty، قابل للضغط مرة ثانية) بعد 2.5 ثانية
        savedStateTimers.set(btn, setTimeout(() => setButtonState(btn, 'dirty'), 2500));
    } else if (state === 'error') {
        btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Error - Retry';
        btn.classList.add('btn-error');
        btn.disabled = false; // يبقى قابل للضغط لإعادة المحاولة، بدون رجوع تلقائي
    }
}

/**
 * ينفذ أي أمر: يحوّل الزر لأخضر "Saved" لمدة 2.5 ثانية عند النجاح، أو أحمر
 * "Error - Retry" ثابت عند الفشل (بدون أي إشعار فوقي منبثق).
 */
async function runAction(btn, endpoint, method, payload) {
    try {
        await apiSend(method, endpoint, payload);
        setButtonState(btn, 'saved');
        await Promise.all([loadProfile(), loadExemptions()]);
    } catch (err) {
        console.error(`[userprofile.js] Action failed (${endpoint}):`, err.message);
        setButtonState(btn, 'error');
    }
}

/**
 * [NEW] يربط كل زر بالحقول المرتبطة فيه: طالما كل الحقول فاضية، الزر رمادي
 * معطّل (idle). بمجرد ما يُكتب أي شي بأي حقل مرتبط، الزر يصير أحمر قابل
 * للضغط (dirty). أزرار بدون حقول مرتبطة (Unban/Unmute/Clear Warnings) تبقى
 * قابلة للضغط دائماً - ما فيه شي نراقبه لتفعيلها.
 *
 * ⚠️ لأزرار الرتب/الاستثناءات: راقبت حقل السبب بس (roles_audit_reason /
 * exemption_reason)، مو تغييرات التاغات نفسها - addDiscordTag() (من
 * dashboard.js) ما تُطلق حدث input/change قياسي، فمراقبتها مباشرة تحتاج
 * تعديل على dashboard.js نفسه. لو تبيها تتفعل بمجرد إضافة/حذف تاغ بدون
 * كتابة بالسبب، قلي.
 */
function wireActionButton(buttonId, watchedInputIds) {
    const btn = document.getElementById(buttonId);
    if (!btn) {
        console.error(`[userprofile.js] Button #${buttonId} not found.`);
        return;
    }

    BUTTON_ORIGINAL_HTML.set(btn, btn.innerHTML);

    if (!watchedInputIds || watchedInputIds.length === 0) {
        setButtonState(btn, 'dirty'); // دائماً قابل للضغط
        return;
    }

    setButtonState(btn, 'idle');

    const checkDirty = () => {
        const hasValue = watchedInputIds.some(id => getVal(id) !== '');
        setButtonState(btn, hasValue ? 'dirty' : 'idle');
    };

    watchedInputIds.forEach(id => {
        const input = document.getElementById(id);
        if (input) input.addEventListener('input', checkDirty);
    });
}

function wireAllActionButtons() {
    wireActionButton('kick_submit_btn', [CONFIG.kickReasonId]);
    wireActionButton('ban_submit_btn', [CONFIG.banReasonId, CONFIG.banDurationId]);
    wireActionButton('unban_submit_btn', []);
    wireActionButton('warn_submit_btn', [CONFIG.warnReasonId]);
    wireActionButton('unwarn_submit_btn', []);
    wireActionButton('mute_submit_btn', [CONFIG.muteDurationId, CONFIG.muteReasonId]);
    wireActionButton('unmute_submit_btn', []);
    wireActionButton('roles_submit_btn', [CONFIG.rolesReasonId]);
    // [REMOVED] exemptions_submit_btn ما عاد موجود - الكرت صار مفتاح تشغيل
    // بسيط، مو زر submit عادي.

    const exemptionToggleEl = document.getElementById(CONFIG.exemptionToggleId);
    if (exemptionToggleEl) exemptionToggleEl.addEventListener('change', handleExemptionToggle);
}

// ============================================================================
// ACTION BUTTONS (كل دالة تستقبل الزر نفسه (btn) - ممرر عبر onclick="...(this)")
// ============================================================================
async function executeKick(btn) {
    const reason = getVal(CONFIG.kickReasonId);
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/kick`, 'POST', { reason });
}

async function executeBan(btn) {
    const reason = getVal(CONFIG.banReasonId);
    const duration = getVal(CONFIG.banDurationId);
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/ban`, 'POST', { reason, duration });
}

async function undoBan(btn) {
    const reason = getVal(CONFIG.unbanReasonId) || 'Unbanned via Dashboard';
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/unban`, 'POST', { reason });
}

async function executeWarn(btn) {
    const reason = getVal(CONFIG.warnReasonId);
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/warn`, 'POST', { reason });
}

async function undoWarn(btn) {
    // [FIXED] نفس منطق undoMute - سبب حقيقي بدل نص ثابت
    const reason = getVal(CONFIG.warnReasonId) || 'Cleared via Dashboard';
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/unwarn`, 'POST', { reason });
}

async function executeMute(btn) {
    const duration = getVal(CONFIG.muteDurationId);
    const reason = getVal(CONFIG.muteReasonId);
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/mute`, 'POST', { duration, reason });
}

async function undoMute(btn) {
    // [FIXED] نفس نمط undoBan (يعيد استخدام حقل السبب الخاص بالميوت نفسه)
    // بدل نص ثابت - عشان الـ DM يوصل بنفس السبب اللي كتبه المشرف
    const reason = getVal(CONFIG.muteReasonId) || 'Removed via Dashboard';
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/unmute`, 'POST', { reason });
}

async function saveUserRoles(btn) {
    const reason = getVal(CONFIG.rolesReasonId);
    const roleIds = collectTags(`#${CONFIG.rolesBoxId}`); // من dashboard.js
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/roles`, 'PUT', { roleIds, reason });
}



// ============================================================================
// COMMAND EXCEPTIONS TOGGLE (مبسّط - بدون سبب، بدون مدة، بدون DM)
// ============================================================================
/**
 * تفعيل/إلغاء استثناء العضو من كل الأوامر مرة وحدة (بدل قائمة أوامر
 * منفصلة). "مفعّل" = EXEMPTABLE_COMMANDS كاملة تُرسل للجدول، "معطّل" =
 * قائمة فاضية (نفس منطق الحذف الموجود أصلاً بـ apiRouter.js). ينفذ فورًا
 * عند التبديل، بدون زر حفظ منفصل.
 */
async function handleExemptionToggle(e) {
    const toggle = e.target;
    const statusEl = document.getElementById(CONFIG.exemptionStatusId);
    const wasChecked = !toggle.checked; // الحالة قبل هالتبديل (للرجوع لها لو فشل)

    toggle.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving...';

    try {
        await apiSend('PUT', `/guild/${currentGuildId}/member/${currentUserId}/exemptions`, {
            commands: toggle.checked ? EXEMPTABLE_COMMANDS : []
        });
        if (statusEl) {
            statusEl.textContent = 'Saved';
            setTimeout(() => { statusEl.textContent = ''; }, 2000);
        }
    } catch (err) {
        console.error('[userprofile.js] Exemption toggle failed:', err.message);
        toggle.checked = wasChecked; // رجوع للحالة السابقة عند الفشل
        if (statusEl) statusEl.textContent = 'Failed - try again';
    } finally {
        toggle.disabled = false;
    }
}

// ============================================================================
// DATA LOADING & RENDERING
// ============================================================================
async function loadProfile() {
    try {
        const data = await apiGet(`/guild/${currentGuildId}/member/${currentUserId}/profile`);
        renderTopBanner(data.profile);

        // renderTags() (من dashboard.js) - lookupType='roles' يترجم كل ID
        // لاسم الرتبة الحقيقي عبر guildStructure.roles (لازم fetchGuildStructure
        // يكون خلص قبل هذا الاستدعاء - مضمون من ترتيب init() بالأسفل)
        const currentRoleIds = (data.profile.roles || []).map(r => r.id);
        renderTags(`#${CONFIG.rolesBoxId}`, currentRoleIds, 'roles');

        renderAltsTable(data.alts || []);
        renderLogsTable(data.logs || []);
        renderModeratorLogTable(data.moderatorLogs || []);
    } catch (err) {
        console.error('[userprofile.js] Failed to load profile:', err.message);
        showNotification('Failed to load member profile.', 'error');
    }
}

async function loadExemptions() {
    try {
        const data = await apiGet(`/guild/${currentGuildId}/member/${currentUserId}/exemptions`);
        const toggle = document.getElementById(CONFIG.exemptionToggleId);
        if (toggle) toggle.checked = (data.commands || []).length > 0;
    } catch (err) {
        console.error('[userprofile.js] Failed to load exemptions:', err.message);
    }
}

function renderTopBanner(profile) {
    if (!profile) return;

    const avatarEl = document.getElementById(CONFIG.avatarImgId);
    const usernameEl = document.getElementById(CONFIG.usernameId);
    const idEl = document.getElementById(CONFIG.userIdTextId);
    const badgeEl = document.getElementById(CONFIG.statusBadgeWrapperId);
    const statusTextEl = document.getElementById(CONFIG.statusTextId);

    if (avatarEl && profile.avatarUrl) {
        avatarEl.src = profile.avatarUrl;
        avatarEl.style.display = '';
        if (avatarEl.nextElementSibling) avatarEl.nextElementSibling.style.display = 'none'; // يخفي أيقونة الـ fallback الاحتياطية
    }
    if (usernameEl) usernameEl.textContent = profile.username || 'Unknown User';
    if (idEl) idEl.textContent = profile.id;

    const roleBadgeEl = document.getElementById('user_highest_role_badge');
    const roleTextEl = document.getElementById('user_highest_role');
    if (profile.highestRole && roleBadgeEl && roleTextEl) {
        roleTextEl.textContent = profile.highestRole.name;
        roleBadgeEl.style.display = '';
        roleBadgeEl.style.color = profile.highestRole.color || '';
        roleBadgeEl.style.borderColor = profile.highestRole.color || '';
    } else if (roleBadgeEl) {
        roleBadgeEl.style.display = 'none';
    }

    let statusLabel = 'Active';
    let statusClass = 'status-active';

    if (profile.isBanned) {
        statusLabel = 'Banned';
        statusClass = 'status-banned';
    } else if (!profile.inServer) {
        statusLabel = 'Not in server';
        statusClass = '';
    } else if (profile.isMuted) {
        statusLabel = 'Muted';
        statusClass = 'status-muted';
    }

    if (statusTextEl) statusTextEl.textContent = statusLabel;
    if (badgeEl) {
        badgeEl.classList.remove('status-active', 'status-muted', 'status-banned');
        if (statusClass) badgeEl.classList.add(statusClass);
    }
}

function renderAltsTable(alts) {
    const tbody = document.getElementById(CONFIG.altsTableBodyId);
    if (!tbody) return;

    if (!alts.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No suspected alt accounts found.</td></tr>`;
        return;
    }

    tbody.innerHTML = alts.map(row => `
        <tr>
            <td>${escapeHtml(row.username || row.id_user)}</td>
            <td>${escapeHtml(row.id_user)}</td>
            <td>${row.at_created_account ? new Date(row.at_created_account).toLocaleDateString() : '--'}</td>
            <td>${row.score != null ? escapeHtml(String(row.score)) + '%' : '--'}</td>
            <td>${escapeHtml(row.action_taken || 'Flagged')}</td>
        </tr>
    `).join('');
}

/**
 * [NEW] يحوّل قيمة المدة الخام من القاعدة لصيغة مقروءة. القيمة المخزّنة
 * غير موحّدة (مشكلة موجودة أصلاً بالبيانات، مو بس بالعرض):
 * - ban.js/mute.js يخزنون رقم دقائق خام (Math.round(ms/60000)) - مثلاً "7200"
 * - warn.js (التصعيد التلقائي) يخزن نص المدة الأصلي كما هو - مثلاً "12h"
 * هذي الدالة تتعامل مع الحالتين: لو القيمة أصلاً نص مدة (رقم+وحدة)، تُعرض
 * كما هي. لو رقم خام، تُعتبر دقائق وتُحوّل لصيغة مركّبة (يوم/ساعة/دقيقة).
 */
function formatLogDuration(raw) {
    if (!raw) return '--';
    const str = String(raw).trim();

    // خريطة كل الصيغ المختصرة الممكنة (من inputs الداشبورد أو تصعيد warn.js) -> كلمة كاملة
    const UNIT_WORDS = {
        s: 'second', sec: 'second', secs: 'second', second: 'second', seconds: 'second',
        m: 'minute', min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute',
        h: 'hour', hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour',
        d: 'day', day: 'day', days: 'day',
        w: 'week', wk: 'week', week: 'week', weeks: 'week',
        mo: 'month', month: 'month', months: 'month',
        y: 'year', yr: 'year', year: 'year', years: 'year'
    };

    const pluralize = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    // الحالة 1: نص مدة جاهز بصيغة مختصرة مثل "12h" أو "30min" -> يتحول لكلمة كاملة
    const textMatch = str.match(/^(\d+)\s*([a-zA-Z]+)$/);
    if (textMatch) {
        const amount = parseInt(textMatch[1], 10);
        const unitWord = UNIT_WORDS[textMatch[2].toLowerCase()];
        return unitWord ? pluralize(amount, unitWord) : str; // وحدة غير معروفة -> اعرضها خام بدل ما نخفيها
    }

    // الحالة 2: رقم دقائق خام (من ban.js/mute.js)
    const totalMinutes = parseInt(str, 10);
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return str;

    const units = [
        { key: 'year', mins: 525600 },
        { key: 'month', mins: 43200 },
        { key: 'week', mins: 10080 },
        { key: 'day', mins: 1440 },
        { key: 'hour', mins: 60 },
        { key: 'minute', mins: 1 }
    ];

    const parts = [];
    let remaining = totalMinutes;
    for (const u of units) {
        const count = Math.floor(remaining / u.mins);
        if (count > 0) {
            parts.push(pluralize(count, u.key));
            remaining -= count * u.mins;
        }
    }

    return parts.length ? parts.join(' ') : pluralize(totalMinutes, 'minute');
}

function renderLogsTable(logs) {
    const tbody = document.getElementById(CONFIG.logsTableBodyId);
    if (!tbody) return;

    if (!logs.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No moderation history or action logs recorded for this user.</td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(row => `
        <tr>
            <td>${new Date(row.created_at).toLocaleString()}</td>
            <td>${escapeHtml(row.action_type)}</td>
            <td>${escapeHtml(row.id_moderator || '--')}</td>
            <td>${escapeHtml(row.reason || '--')}</td>
            <td>${formatLogDuration(row.duration)}</td>
        </tr>
    `).join('');
}

function renderModeratorLogTable(logs) {
    const tbody = document.getElementById(CONFIG.modLogTableBodyId);
    if (!tbody) return;

    if (!logs.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">This member has not executed any moderation actions.</td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(row => `
        <tr>
            <td>${new Date(row.created_at).toLocaleString()}</td>
            <td>${escapeHtml(row.action_type)}</td>
            <td>${escapeHtml(row.id_target)}</td>
            <td>${escapeHtml(row.reason || '--')}</td>
            <td>${formatLogDuration(row.duration)}</td>
        </tr>
    `).join('');
}



// ============================================================================
// TABS & MISC
// ============================================================================
function switchTab(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    btnElement.classList.add('active');
}

function copyUserId() {
    const idText = document.getElementById(CONFIG.userIdTextId).textContent;
    if (idText && idText !== '--') {
        navigator.clipboard.writeText(idText);
        showNotification('Copied', 'success');
    }
}

// ============================================================================
// INIT
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    currentGuildId = getGuildId();
    currentUserId = getUserId();

    if (!currentGuildId || !currentUserId) {
        showNotification('Missing guild or user ID in the URL.', 'error');
        return;
    }

    wireAllActionButtons(); // يهيئ حالة الأزرار + مفتاح الاستثناء قبل أي تحميل بيانات

    // fetchGuildStructure() (من dashboard.js) لازم تخلص أول - تعبّي
    // guildStructure.roles اللي renderTags(..., 'roles') يعتمد عليها لعرض
    // أسماء الرتب الصحيحة، وتعبّي #userRolesDropdown تلقائياً بنفس الاستدعاء.
    await fetchGuildStructure();

    await Promise.all([
        loadProfile(),
        loadExemptions()
    ]);
});