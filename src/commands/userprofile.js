/**
 * ======================================================
 * OmniGuard - User Profile & Moderation (user-profile.html)
 * ======================================================
 * يعتمد بالكامل على المتغيرات/الدوال العامة من dashboard.js:
 * API_BASE, getHeaders(), getGuildId(), showNotification().
 * لازم <script src="dashboard.js"> يكون قبل هذا الملف بالصفحة.
 *
 * ⚠️ CONFIG بالأسفل فيه كل الـ element IDs. الأسماء المؤكدة (شفتها فعلياً
 * بالملف) معلّمة "confirmed"، والباقي معلّم "ASSUMED" - راجع قائمة
 * التحقق بنهاية الرد.
 */

const CONFIG = {
    // --- Top Banner ---
    avatarImgId: 'user_avatar',              // confirmed
    usernameId: 'user_name',                 // FIXED (كان user_username غلط)
    userIdTextId: 'user_id',                 // confirmed
    statusBadgeWrapperId: 'user_status_badge', // confirmed
    statusTextId: 'user_status',             // confirmed

    // --- Kick Card ---
    kickReasonId: 'kick_reason',             // confirmed

    // --- Ban Card ---
    banReasonId: 'ban_reason',               // confirmed
    banDurationId: 'ban_delete_duration',    // FIXED - راجع الملاحظة بالأسفل، هذا الحقل الوحيد الموجود فعلياً
    unbanReasonId: 'ban_reason',             // نفس حقل السبب يُعاد استخدامه لعملية Unban (نفس الكرت)

    // --- Warn Card ---
    warnReasonId: 'warn_reason',             // confirmed

    // --- Mute Card ---
    muteDurationId: 'mute_duration',         // confirmed
    muteReasonId: 'mute_reason',             // confirmed

    // --- Roles Card ---
    rolesBoxId: 'user_assigned_roles',       // FIXED (كان roles_selector_box غلط)
    rolesDropdownId: 'userRolesDropdown',    // FIXED (كان roles_dropdown_list غلط)
    rolesReasonId: 'roles_audit_reason',     // confirmed

    // --- Command Exceptions Card ---
    exemptionBoxId: 'user_exempt_commands',       // FIXED (كان exemption_selector_box غلط)
    exemptionDropdownId: 'exemptCommandsDropdown', // FIXED (كان exemption_dropdown_list غلط)
    exemptionDurationId: 'exemption_duration',      // confirmed
    exemptionReasonId: 'exemption_reason',          // confirmed

    // --- Tables ---
    altsTableBodyId: 'alts_table_body',      // confirmed
    logsTableBodyId: 'logs_table_body',      // confirmed
    modLogTableBodyId: 'moderator_log_table_body' // confirmed
};

// أسماء الأوامر المتاحة للاستثناء - مطابقة لأسماء ملفات الأوامر الفعلية
// (name + aliases المسجّلة بـ commandhandler.js)
const EXEMPTABLE_COMMANDS = [
    'kick', 'ban', 'unban', 'mute', 'unmute', 'warn', 'unwarn', 'roleadd', 'demote'
];

// ============================================================================
// STATE
// ============================================================================
let currentGuildId = null;
let currentUserId = null;
let guildRoles = [];               // [{id, name, color}] - من endpoint الرتب الموجود أصلاً
const selectedRoleIds = new Set(); // مرجع ثابت (ما يُعاد تعيينه) عشان التاغ سيلكتور يبقى متزامن
const selectedExemptCommands = new Set();

let rolesSelector = null;
let exemptionsSelector = null;

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
 * ينفذ أي أمر (Kick/Ban/Warn/Mute/Roles/Exemptions)، يعرض "Saved" أو رسالة
 * خطأ واضحة (Error + النص يشجع على إعادة المحاولة)، ثم يعيد تحميل كل بيانات
 * الصفحة فوراً عشان الحالة (بادج الميوت/البان، اللوقات، التاغات) تنعكس
 * لحظياً بدون ما يحتاج المشرف يعمل Refresh يدوي.
 */
async function runAction(endpoint, method, payload) {
    try {
        await apiSend(method, endpoint, payload);
        showNotification('Saved', 'success');
        await Promise.all([loadProfile(), loadExemptions()]);
    } catch (err) {
        console.error(`[userprofile.js] Action failed (${endpoint}):`, err.message);
        showNotification(`Error: ${err.message}. Please retry.`, 'error');
    }
}

// ============================================================================
// TAG SELECTOR (Roles + Command Exceptions) - مستقل بالكامل، Vanilla JS
// ============================================================================
function createTagSelector({ containerId, dropdownId, getAllOptions, selectedSet }) {
    const container = document.getElementById(containerId);
    const dropdown = document.getElementById(dropdownId);

    if (!container || !dropdown) {
        console.error(`[userprofile.js] Tag selector elements not found: #${containerId} / #${dropdownId}`);
        return { render: () => {} };
    }

    dropdown.style.display = 'none';

    function render() {
        container.querySelectorAll('.tag-item').forEach(el => el.remove());
        let trigger = container.querySelector('.tag-add-trigger');

        const allOptions = getAllOptions();
        [...selectedSet].forEach(id => {
            const option = allOptions.find(o => o.id === id);
            const label = option ? option.name : id;

            const tag = document.createElement('div');
            tag.className = 'tag-item';
            tag.innerHTML = `<span>${escapeHtml(label)}</span><span class="remove-btn">×</span>`;
            tag.querySelector('.remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                selectedSet.delete(id);
                render();
            });

            container.insertBefore(tag, trigger || null);
        });

        if (!trigger) {
            trigger = document.createElement('span');
            trigger.className = 'tag-add-trigger';
            trigger.textContent = '+ Add';
            trigger.style.cssText = 'cursor:pointer;color:var(--text-secondary);font-size:12px;';
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
            });
            container.appendChild(trigger);
        }

        renderDropdown();
    }

    function renderDropdown() {
        const allOptions = getAllOptions();
        const available = allOptions.filter(o => !selectedSet.has(o.id));

        dropdown.innerHTML = available.length
            ? available.map(o => `<div class="dropdown-item" data-id="${escapeHtml(o.id)}">${escapeHtml(o.name)}</div>`).join('')
            : `<div class="dropdown-item-empty">No more options available</div>`;

        dropdown.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                selectedSet.add(item.dataset.id);
                dropdown.style.display = 'none';
                render();
            });
        });
    }

    document.addEventListener('click', (e) => {
        if (!container.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });

    return { render };
}

function initTagSelectors() {
    rolesSelector = createTagSelector({
        containerId: CONFIG.rolesBoxId,
        dropdownId: CONFIG.rolesDropdownId,
        getAllOptions: () => guildRoles.map(r => ({ id: r.id, name: r.name })),
        selectedSet: selectedRoleIds
    });

    exemptionsSelector = createTagSelector({
        containerId: CONFIG.exemptionBoxId,
        dropdownId: CONFIG.exemptionDropdownId,
        getAllOptions: () => EXEMPTABLE_COMMANDS.map(c => ({ id: c, name: c })),
        selectedSet: selectedExemptCommands
    });
}

// ============================================================================
// DATA LOADING & RENDERING
// ============================================================================
async function loadGuildRoles() {
    try {
        guildRoles = await apiGet(`/guild/${currentGuildId}/roles`);
        rolesSelector.render();
    } catch (err) {
        console.error('[userprofile.js] Failed to load guild roles:', err.message);
    }
}

async function loadProfile() {
    try {
        const data = await apiGet(`/guild/${currentGuildId}/member/${currentUserId}/profile`);
        renderTopBanner(data.profile);
        renderRoleTags(data.profile.roles || []);
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
        renderExemptionTags(data.commands || []);

        const reasonInput = document.getElementById(CONFIG.exemptionReasonId);
        if (reasonInput) reasonInput.value = data.reason || '';
        // ملاحظة: حقل المدة ما يُعاد تعبئته بقيمة نسبية (كانت "7d" وقت
        // الحفظ، مو تاريخ مطلق قابل لإعادة العرض بنفس الصيغة) - يبقى فاضي
        // عمداً، والمشرف يقدر يشوف expiresAt الفعلي لو احتجنا نعرضه لاحقاً.
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

    if (avatarEl && profile.avatarUrl) avatarEl.src = profile.avatarUrl;
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

function renderRoleTags(currentRoles) {
    selectedRoleIds.clear();
    currentRoles.forEach(r => selectedRoleIds.add(r.id));
    rolesSelector.render();
}

function renderExemptionTags(commands) {
    selectedExemptCommands.clear();
    (commands || []).forEach(c => selectedExemptCommands.add(c));
    exemptionsSelector.render();
}

function renderAltsTable(alts) {
    const tbody = document.getElementById(CONFIG.altsTableBodyId);
    if (!tbody) return;

    if (!alts.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No suspected alt accounts found.</td></tr>`;
        return;
    }

    tbody.innerHTML = alts.map(row => `
        <tr>
            <td>${escapeHtml(row.username || row.id_user)}</td>
            <td>${row.score != null ? escapeHtml(String(row.score)) + '%' : '--'}</td>
            <td>${row.at_created_account ? new Date(row.at_created_account).toLocaleDateString() : '--'}</td>
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
// ACTION BUTTONS (onclick handlers - أسماء مطابقة تماماً لما كان بالسكربت
// الداخلي القديم اللي حذفناه، عشان أي onclick="..." موجود بالـ HTML يشتغل
// بدون أي تعديل إضافي على الملف نفسه)
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
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/roles`, 'PUT', {
        roleIds: [...selectedRoleIds],
        reason
    });
}

async function saveCommandExceptions() {
    const duration = getVal(CONFIG.exemptionDurationId);
    const reason = getVal(CONFIG.exemptionReasonId);
    await runAction(`/guild/${currentGuildId}/member/${currentUserId}/exemptions`, 'PUT', {
        commands: [...selectedExemptCommands],
        duration,
        reason
    });
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

    initTagSelectors();

    await Promise.all([
        loadGuildRoles(),
        loadProfile(),
        loadExemptions()
    ]);
});