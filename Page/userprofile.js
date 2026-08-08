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

    // --- Command Exceptions Card ---
    exemptionBoxId: 'user_exempt_commands',
    exemptionDropdownId: 'exemptCommandsDropdown',
    exemptionDurationId: 'exemption_duration',
    exemptionReasonId: 'exemption_reason',

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
    wireActionButton('exemptions_submit_btn', [CONFIG.exemptionReasonId, CONFIG.exemptionDurationId]);
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
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/unwarn`, 'POST', { reason: 'Cleared via Dashboard' });
}

async function executeMute(btn) {
    const duration = getVal(CONFIG.muteDurationId);
    const reason = getVal(CONFIG.muteReasonId);
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/mute`, 'POST', { duration, reason });
}

async function undoMute(btn) {
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/unmute`, 'POST', { reason: 'Removed via Dashboard' });
}

async function saveUserRoles(btn) {
    const reason = getVal(CONFIG.rolesReasonId);
    const roleIds = collectTags(`#${CONFIG.rolesBoxId}`); // من dashboard.js
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/roles`, 'PUT', { roleIds, reason });
}

async function saveCommandExceptions(btn) {
    const duration = getVal(CONFIG.exemptionDurationId);
    const reason = getVal(CONFIG.exemptionReasonId);
    const commands = collectTags(`#${CONFIG.exemptionBoxId}`); // من dashboard.js
    await runAction(btn, `/guild/${currentGuildId}/member/${currentUserId}/exemptions`, 'PUT', { commands, duration, reason });
}

// ============================================================================
// COMMAND EXCEPTIONS DROPDOWN (يدوي - data-source="commands" غير مدعوم
// بـ dashboard.js، على عكس data-source="roles" اللي يتعبى تلقائياً)
// ============================================================================
function populateExemptCommandsDropdown() {
    const dropdown = document.getElementById(CONFIG.exemptionDropdownId);
    if (!dropdown) {
        console.error(`[userprofile.js] Exemption dropdown #${CONFIG.exemptionDropdownId} not found.`);
        return;
    }

    dropdown.innerHTML = '';
    EXEMPTABLE_COMMANDS.forEach(cmd => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.textContent = cmd;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            addDiscordTag(CONFIG.exemptionBoxId, cmd, cmd); // من dashboard.js - يمنع التكرار تلقائياً
            dropdown.classList.remove('show');
        });
        dropdown.appendChild(item);
    });
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

        // lookupType=null - أسماء الأوامر نص حر، ما تحتاج ترجمة زي الرتب
        renderTags(`#${CONFIG.exemptionBoxId}`, data.commands || [], null);

        const reasonInput = document.getElementById(CONFIG.exemptionReasonId);
        if (reasonInput) reasonInput.value = data.reason || '';
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
        avatarEl.style.display = ''; // يلغي display:none اللي حطها onerror التلقائي وقت src="" الأولي
    }
    if (usernameEl) usernameEl.textContent = profile.username || 'Unknown User';
    if (idEl) idEl.textContent = profile.id;

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
            <td>${escapeHtml(row.duration || '--')}</td>
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
            <td>${escapeHtml(row.duration || '--')}</td>
        </tr>
    `).join('');
}

// ============================================================================
// ACTION BUTTONS (أسماء الدوال مطابقة تماماً لـ onclick="..." الموجودة
// بالـ HTML أصلاً)
// ============================================================================
async function executeKick() {
    const reason = getVal(CONFIG.kickReasonId);
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/kick`, 'POST', { reason });
}

async function executeBan() {
    const reason = getVal(CONFIG.banReasonId);
    const duration = getVal(CONFIG.banDurationId);
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/ban`, 'POST', { reason, duration });
}

async function undoBan() {
    const reason = getVal(CONFIG.unbanReasonId) || 'Unbanned via Dashboard';
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/unban`, 'POST', { reason });
}

async function executeWarn() {
    const reason = getVal(CONFIG.warnReasonId);
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/warn`, 'POST', { reason });
}

async function undoWarn() {
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/unwarn`, 'POST', { reason: 'Cleared via Dashboard' });
}

async function executeMute() {
    const duration = getVal(CONFIG.muteDurationId);
    const reason = getVal(CONFIG.muteReasonId);
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/mute`, 'POST', { duration, reason });
}

async function undoMute() {
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/unmute`, 'POST', { reason: 'Removed via Dashboard' });
}

async function saveUserRoles() {
    const reason = getVal(CONFIG.rolesReasonId);
    const roleIds = collectTags(`#${CONFIG.rolesBoxId}`); // من dashboard.js
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/roles`, 'PUT', { roleIds, reason });
}

async function saveCommandExceptions() {
    const duration = getVal(CONFIG.exemptionDurationId);
    const reason = getVal(CONFIG.exemptionReasonId);
    const commands = collectTags(`#${CONFIG.exemptionBoxId}`); // من dashboard.js
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/exemptions`, 'PUT', { commands, duration, reason });
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

    populateExemptCommandsDropdown(); // ثابتة، بدون حاجة لانتظار أي طلب شبكة
    wireAllActionButtons(); // [NEW] يهيئ حالة الأزرار (رمادي/أحمر) قبل أي تحميل بيانات

    // fetchGuildStructure() (من dashboard.js) لازم تخلص أول - تعبّي
    // guildStructure.roles اللي renderTags(..., 'roles') يعتمد عليها لعرض
    // أسماء الرتب الصحيحة، وتعبّي #userRolesDropdown تلقائياً بنفس الاستدعاء.
    await fetchGuildStructure();

    await Promise.all([
        loadProfile(),
        loadExemptions()
    ]);
});