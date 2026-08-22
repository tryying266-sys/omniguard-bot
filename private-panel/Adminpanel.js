// ============================================================================
// Adminpanel.js - OmniGuard Admin Control Panel Frontend (v1.0)
// ============================================================================
// مستقل تماماً عن dashboard.js (المشترك بين باقي صفحات الداشبورد) - بس نفس
// آلية الجلسة بالضبط (Supabase Session Bridge) عشان يستخدم نفس تسجيل
// الدخول الموجود، بدون أي نظام مصادقة موازي.
//
// [مهم] هذا الملف "عام" تقنياً (Static Asset) لأي حد يعرف المسار السري -
// لكنه فاضي وظيفياً بدون بيانات حقيقية: أول شي يسويه بعد الجلسة هو نداء
// GET /api/panel/verify. لو فشل (401/404) يرجّع المستخدم لصفحة تسجيل
// الدخول فوراً، بدون ما يكشف أي شي عن وجود اللوحة أصلاً.
// ============================================================================

const PANEL_API_BASE = `${window.location.origin}/api/panel`;
const ACCOUNT_API_BASE = `${window.location.origin}/api`;

const SUPABASE_URL = 'https://lcnjswibemyenakwojkz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxjbmpzd2liZW15ZW5ha3dvamt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODQ0ODEsImV4cCI6MjA5OTQ2MDQ4MX0.AfbKJsd6sOK1FPz2w-rH3XT28m4eneB1uNJEyETJ9ug';

let supabaseClient = null;
let cachedUserToken = null;

function getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (cachedUserToken) headers['X-User-Token'] = cachedUserToken;
    return headers;
}

/**
 * [NEW] لو التوكن انتهى/صار غير صالح أثناء الجلسة (مو بس أول تحميل)، السيرفر
 * يرجّع 401 - بدون هذا الفحص، المستخدم يفضل واقف بالصفحة يشوف أخطاء صامتة
 * بالكونسول فقط، بدون ما يوعى إن جلسته انتهت. أي 401 يفرض تسجيل خروج فوري
 * + تحويل لصفحة تسجيل الدخول - نفس المطلوب بالضبط ("لازم ينعاد للصفحة
 * Login.html").
 */
async function forceLogoutExpiredSession() {
    console.warn('[Adminpanel] Session expired or invalid - signing out.');
    try { await supabaseClient?.auth.signOut(); } catch (_) { /* لا يهم لو فشل - بنحوّل بأي حال */ }
    if (!window.location.pathname.includes('Login.html')) {
        window.location.href = '/Login.html';
    }
}

async function panelFetch(path, options = {}) {
    const response = await fetch(`${PANEL_API_BASE}${path}`, {
        ...options,
        headers: { ...getHeaders(), ...(options.headers || {}) }
    });
    if (response.status === 401) {
        forceLogoutExpiredSession();
        throw new Error('Session expired - redirecting to login');
    }
    // 404 هنا يعني "أنت مو صاحب اللوحة" - نفس فلسفة الحماية، ما نكشف السبب بالتفصيل
    if (response.status === 404) throw new Error('Not Found');
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
}

async function initSupabaseSessionBridge() {
    if (typeof supabase === 'undefined') {
        console.warn('[Adminpanel] Supabase JS SDK not loaded.');
        window.location.href = '/Login.html';
        return;
    }

    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    const { data } = await supabaseClient.auth.getSession();
    const session = data?.session;

    if (!session) {
        window.location.href = '/Login.html';
        return;
    }

    cachedUserToken = session.access_token;

    try {
        const verify = await panelFetch('/verify');
        document.getElementById('panel_owner_label').textContent =
            session.user?.user_metadata?.full_name || session.user?.user_metadata?.name || verify.discordId;
    } catch (err) {
        // مو صاحب اللوحة (أو الهوية ما تطابق) - يرجع لصفحة الدخول العادية،
        // بدون أي رسالة تكشف إن هذا المسار مخصص للوحة تحكم أصلاً.
        window.location.href = '/Login.html';
        return;
    }

    supabaseClient.auth.onAuthStateChange((event, newSession) => {
        const newToken = newSession?.access_token || null;
        if (newToken === cachedUserToken) return;
        cachedUserToken = newToken;
        if (!newSession && event === 'SIGNED_OUT') {
            window.location.href = '/Login.html';
        }
    });

    await bootPanel();
}

// ============================================================================
// Save Button State Machine (نفس الأربع حالات المتفق عليها بالضبط)
// ============================================================================
const SAVE_STATE_CLASSES = ['state-default', 'state-dirty', 'state-saved', 'state-error'];
let isDirty = false;

function setSaveButtonState(stateClass, { text, disabled }) {
    const btn = document.getElementById('panel_save_btn');
    if (!btn) return;
    SAVE_STATE_CLASSES.forEach(c => btn.classList.remove(c));
    btn.classList.add(stateClass);
    btn.textContent = text;
    btn.disabled = disabled;
}

function markClean() {
    isDirty = false;
    setSaveButtonState('state-default', { text: 'Save Changes', disabled: true });
}

function markDirty() {
    if (isDirty) return;
    isDirty = true;
    setSaveButtonState('state-dirty', { text: 'Save Changes', disabled: false });
}

function markSaved() {
    setSaveButtonState('state-saved', { text: '✓ Saved', disabled: true });
    setTimeout(markClean, 2500);
}

function markError() {
    setSaveButtonState('state-error', { text: '⚠ Error - Retry', disabled: false });
}

function watchDirty(el, eventName = 'input') {
    if (!el) return;
    el.addEventListener(eventName, markDirty);
}

// ============================================================================
// Current Target (يقود كل الكاردات تحته - Search / Feature Flags / Actions)
// ============================================================================
// شكل currentTarget:
//   null                                          -> ما فيه اختيار
//   { type: 'user', id, name, avatarUrl }         -> مستخدم محدد
//   { type: 'server', id, name, avatarUrl }       -> سيرفر محدد
//   { type: 'all_users' }                         -> الكل (مستخدمين)
//   { type: 'all_servers' }                       -> الكل (سيرفرات)
let currentTarget = null;

function setTarget(target) {
    currentTarget = target;
    renderTargetBar();
    renderFeatureFlagsScope();
    renderDispatchAvailability();
}

function renderTargetBar() {
    const bar = document.getElementById('target_bar');
    const text = document.getElementById('target_bar_text');
    const avatar = document.getElementById('target_bar_avatar');

    document.getElementById('chip_all_users').classList.toggle('chip-active', currentTarget?.type === 'all_users');
    document.getElementById('chip_all_servers').classList.toggle('chip-active', currentTarget?.type === 'all_servers');

    if (!currentTarget) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';
    if (currentTarget.type === 'all_users') {
        text.textContent = 'Target: All Users';
        avatar.style.display = 'none';
    } else if (currentTarget.type === 'all_servers') {
        text.textContent = 'Target: All Servers';
        avatar.style.display = 'none';
    } else {
        text.textContent = `Target: ${currentTarget.name} (${currentTarget.id})`;
        if (currentTarget.avatarUrl) {
            avatar.src = currentTarget.avatarUrl;
            avatar.style.display = 'block';
        } else {
            avatar.style.display = 'none';
        }
    }

    // زر الخروج من السيرفر يظهر فقط لو الهدف سيرفر محدد (مو All)
    let leaveBtn = document.getElementById('target_bar_leave_guild');
    if (currentTarget.type === 'server') {
        if (!leaveBtn) {
            leaveBtn = document.createElement('button');
            leaveBtn.type = 'button';
            leaveBtn.id = 'target_bar_leave_guild';
            leaveBtn.className = 'btn-action';
            leaveBtn.style.marginInlineEnd = '8px';
            leaveBtn.innerHTML = '<i class="fa-solid fa-door-open"></i> Leave This Server';
            leaveBtn.addEventListener('click', handleLeaveGuild);
            bar.insertBefore(leaveBtn, document.getElementById('target_bar_clear'));
        }
    } else if (leaveBtn) {
        leaveBtn.remove();
    }

    // [NEW] زر إلغاء الحظر الجماعي - يظهر فقط لو الهدف "All Users"، عشان
    // يكون فيه طريقة يرجع الأدمن الحظر الجماعي لو فعّله (ما كانت موجودة
    // إطلاقاً بالتصميم الأصلي - راجع dispatchAction/scope==='global' تحت).
    let disableGlobalBanBtn = document.getElementById('target_bar_disable_global_ban');
    if (currentTarget.type === 'all_users') {
        if (!disableGlobalBanBtn) {
            disableGlobalBanBtn = document.createElement('button');
            disableGlobalBanBtn.type = 'button';
            disableGlobalBanBtn.id = 'target_bar_disable_global_ban';
            disableGlobalBanBtn.className = 'btn-action';
            disableGlobalBanBtn.style.marginInlineEnd = '8px';
            disableGlobalBanBtn.innerHTML = '<i class="fa-solid fa-unlock"></i> Disable Global Ban';
            disableGlobalBanBtn.addEventListener('click', handleDisableGlobalBan);
            bar.insertBefore(disableGlobalBanBtn, document.getElementById('target_bar_clear'));
        }
    } else if (disableGlobalBanBtn) {
        disableGlobalBanBtn.remove();
    }
}

async function handleDisableGlobalBan() {
    if (!confirm('This will lift the global ban and restore bot/dashboard access for everyone. Continue?')) return;
    try {
        await panelFetch('/ban-all', { method: 'DELETE' });
        alert('Global ban disabled successfully.');
        loadLogs();
    } catch (err) {
        alert(`Failed to disable global ban: ${err.message}`);
    }
}

async function handleLeaveGuild() {
    if (!currentTarget || currentTarget.type !== 'server') return;
    if (!confirm(`The bot will immediately leave "${currentTarget.name}". Continue?`)) return;
    try {
        await panelFetch('/leave-guild', {
            method: 'POST',
            body: JSON.stringify({ guildId: currentTarget.id })
        });
        alert('Left the server successfully.');
        setTarget(null);
    } catch (err) {
        alert(`Failed to leave server: ${err.message}`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('target_bar_clear').addEventListener('click', () => setTarget(null));
    document.getElementById('chip_all_users').addEventListener('click', () => setTarget({ type: 'all_users' }));
    document.getElementById('chip_all_servers').addEventListener('click', () => setTarget({ type: 'all_servers' }));
});

// ============================================================================
// Global Search - Smart Autocomplete (debounced, works from 1 character)
// ============================================================================
let searchDebounceTimer = null;

function initSearch() {
    const input = document.getElementById('global_search_input');
    input.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        const query = input.value.trim();
        if (!query) {
            renderSearchResults({ users: [], servers: [] }, true);
            return;
        }
        searchDebounceTimer = setTimeout(() => runSearch(query), 250);
    });
}

async function runSearch(query) {
    try {
        const results = await panelFetch(`/search?q=${encodeURIComponent(query)}`);
        renderSearchResults(results, false);
    } catch (err) {
        console.error('[Adminpanel] Search failed:', err.message);
    }
}

function renderSearchResults(results, isEmpty) {
    const container = document.getElementById('search_results_container');
    container.innerHTML = '';

    const total = (results.users?.length || 0) + (results.servers?.length || 0);
    if (isEmpty || total === 0) {
        container.innerHTML = `<div class="search-empty-state">${isEmpty ? 'Start typing to see live suggestions.' : 'No matches found.'}</div>`;
        return;
    }

    (results.users || []).forEach(user => {
        const row = document.createElement('div');
        row.className = 'result-row';
        row.innerHTML = `
            <img class="result-avatar" src="${user.avatarUrl}" alt="">
            <div class="result-info">
                <span class="result-name">${escapeHtml(user.displayName)}</span>
                <span class="result-meta">${user.id}</span>
            </div>
            <span class="result-type-badge type-user">User</span>
        `;
        row.addEventListener('click', () => setTarget({ type: 'user', id: user.id, name: user.displayName, avatarUrl: user.avatarUrl }));
        container.appendChild(row);
    });

    (results.servers || []).forEach(server => {
        const row = document.createElement('div');
        row.className = 'result-row';
        row.innerHTML = `
            <img class="result-avatar square" src="${server.iconUrl || 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="">
            <div class="result-info">
                <span class="result-name">${escapeHtml(server.name)}</span>
                <span class="result-meta">${server.id} · ${server.memberCount} members</span>
            </div>
            <span class="result-type-badge type-server">Server</span>
        `;
        row.addEventListener('click', () => setTarget({ type: 'server', id: server.id, name: server.name, avatarUrl: server.iconUrl }));
        container.appendChild(row);
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// ============================================================================
// Bot State & Maintenance
// ============================================================================
async function loadBotState() {
    const state = await panelFetch('/state');
    document.getElementById('full_shutdown_enabled').checked = !!state.full_shutdown_enabled;
    document.getElementById('maintenance_enabled').checked = !!state.maintenance_enabled;
    document.getElementById('maintenance_message').value = state.maintenance_message || '';
    document.getElementById('bot_online_status').value = state.online_status || 'online';
}

function initBotStateWatchers() {
    ['full_shutdown_enabled', 'maintenance_enabled'].forEach(id => watchDirty(document.getElementById(id), 'change'));
    watchDirty(document.getElementById('maintenance_message'));
    watchDirty(document.getElementById('bot_online_status'), 'change');
}

async function saveBotState() {
    return panelFetch('/state', {
        method: 'PUT',
        body: JSON.stringify({
            full_shutdown_enabled: document.getElementById('full_shutdown_enabled').checked,
            maintenance_enabled: document.getElementById('maintenance_enabled').checked,
            maintenance_message: document.getElementById('maintenance_message').value,
            online_status: document.getElementById('bot_online_status').value
        })
    });
}

// ============================================================================
// Feature Flags (15 flags - matches panel_feature_flags.flag_key exactly)
// ============================================================================
const FEATURE_FLAGS = [
    { key: 'search', label: 'Search' },
    { key: 'home', label: 'Home' },
    { key: 'general_settings', label: 'General Settings' },
    { key: 'welcome', label: 'Welcome' },
    { key: 'role_management', label: 'Role Management' },
    { key: 'auto_mod', label: 'Auto Mod' },
    { key: 'anti_alt', label: 'Anti Alt' },
    { key: 'auto_respond', label: 'Auto Respond' },
    { key: 'ticket_category', label: 'Ticket Category' },
    { key: 'ticket_panel', label: 'Ticket Panel' },
    { key: 'ticket', label: 'Ticket' },
    { key: 'level_system', label: 'Level System' },
    { key: 'custom_messages', label: 'Custom Messages' },
    { key: 'ticket_auto_log', label: 'Ticket Auto Log' },
    { key: 'command_customization', label: 'Command Customization' }
];

function renderFeatureFlagsGrid() {
    const grid = document.getElementById('feature_flags_grid');
    grid.innerHTML = '';
    FEATURE_FLAGS.forEach(flag => {
        const item = document.createElement('div');
        item.className = 'flag-item';
        item.innerHTML = `
            <span class="switch-title">${flag.label}</span>
            <label class="toggle-switch">
                <input type="checkbox" id="flag_${flag.key}" checked>
                <span class="slider"></span>
            </label>
        `;
        grid.appendChild(item);
        watchDirty(document.getElementById(`flag_${flag.key}`), 'change');
    });
}

function renderFeatureFlagsScope() {
    const hint = document.getElementById('flags_scope_hint');
    if (currentTarget?.type === 'user') {
        hint.textContent = `Applies to: ${currentTarget.name} only`;
    } else {
        hint.textContent = 'Applies to: All Users (Global default)';
    }
    loadFeatureFlags();
}

async function loadFeatureFlags() {
    const scope = currentTarget?.type === 'user' ? 'user' : 'global';
    const target = currentTarget?.type === 'user' ? currentTarget.id : '';
    try {
        const flags = await panelFetch(`/feature-flags?scope=${scope}${target ? `&target=${target}` : ''}`);
        const flagMap = Object.fromEntries(flags.map(f => [f.flag_key, f.enabled]));
        FEATURE_FLAGS.forEach(flag => {
            const el = document.getElementById(`flag_${flag.key}`);
            if (el) el.checked = flagMap[flag.key] !== false;
        });
    } catch (err) {
        console.error('[Adminpanel] Failed to load feature flags:', err.message);
    }
}

async function saveFeatureFlags() {
    const scope = currentTarget?.type === 'user' ? 'user' : 'global';
    const target_user_id = currentTarget?.type === 'user' ? currentTarget.id : null;
    const flags = {};
    FEATURE_FLAGS.forEach(flag => {
        flags[flag.key] = document.getElementById(`flag_${flag.key}`).checked;
    });
    return panelFetch('/feature-flags', {
        method: 'PUT',
        body: JSON.stringify({ scope, target_user_id, flags })
    });
}

// ============================================================================
// User Actions & Dashboard Notices (Alert / Update / Note / Ban)
// ============================================================================
const BADGE_ICONS = {
    alert: 'fa-triangle-exclamation',
    update: 'fa-arrow-up-right-dots',
    note: 'fa-note-sticky',
    ban: 'fa-gavel'
};

function renderDispatchAvailability() {
    const btn = document.getElementById('btn_send_user_action');
    const hint = document.getElementById('dispatch_hint');
    const validTarget = currentTarget && ['user', 'all_users'].includes(currentTarget.type);
    btn.disabled = !validTarget;
    hint.style.display = validTarget ? 'none' : 'block';
}

function updateActionPreview() {
    const type = document.getElementById('action_type_select').value;
    const color = document.getElementById('action_color_select').value;
    const title = document.getElementById('action_title_input').value || 'Account Action Notice';
    const message = document.getElementById('action_message_input').value ||
        'Your notification message text will be displayed here exactly as seen by the user on the dashboard.';
    const duration = document.getElementById('action_duration_input').value;

    const badge = document.getElementById('preview_badge');
    badge.className = `preview-badge badge-${color}`;
    badge.innerHTML = `<i class="fa-solid ${BADGE_ICONS[type] || 'fa-circle-info'}"></i> ${type.charAt(0).toUpperCase() + type.slice(1)}`;

    document.getElementById('preview_title').textContent = title;
    document.getElementById('preview_message').textContent = message;
    document.getElementById('preview_duration').textContent = type === 'ban'
        ? (duration ? `Expires in ${duration}` : 'Permanent')
        : '';
}

function initActionCardWatchers() {
    const typeSelect = document.getElementById('action_type_select');
    const durationGroup = document.getElementById('action_duration_group');
    const durationInput = document.getElementById('action_duration_input');

    function syncDurationAvailability() {
        const isBan = typeSelect.value === 'ban';
        durationInput.disabled = !isBan;
        durationGroup.style.opacity = isBan ? '1' : '0.45';
    }

    typeSelect.addEventListener('change', () => { syncDurationAvailability(); updateActionPreview(); });
    ['action_color_select', 'action_title_input', 'action_message_input', 'action_duration_input']
        .forEach(id => document.getElementById(id).addEventListener('input', updateActionPreview));
    document.getElementById('action_color_select').addEventListener('change', updateActionPreview);

    syncDurationAvailability();
    updateActionPreview();

    document.getElementById('btn_send_user_action').addEventListener('click', dispatchAction);
}

async function dispatchAction() {
    if (!currentTarget || !['user', 'all_users'].includes(currentTarget.type)) return;

    const actionType = document.getElementById('action_type_select').value;
    const badgeColor = document.getElementById('action_color_select').value;
    const deliveryChannel = document.getElementById('action_delivery_select').value;
    const title = document.getElementById('action_title_input').value.trim();
    const message = document.getElementById('action_message_input').value.trim();
    const duration = document.getElementById('action_duration_input').value.trim();

    if (!title || !message) {
        alert('Notice Title and Notice Content are required.');
        return;
    }

    const scope = currentTarget.type === 'all_users' ? 'global' : 'user';
    const targetUserId = currentTarget.type === 'user' ? currentTarget.id : null;

    // Ban يحتاج تأكيد إداري صريح قبل الإرسال - باقي الأنواع (Alert/Update/Note) ترسل مباشرة
    if (actionType === 'ban') {
        const who = scope === 'global' ? 'ALL users' : currentTarget.name;
        if (!confirm(`This will ban ${who} from using the bot entirely (dashboard + chat commands)${duration ? ` for ${duration}` : ' permanently'}. Continue?`)) {
            return;
        }
        try {
            // [NEW] الحظر الجماعي الحين مدعوم فعلياً - فلاق واحد بـ
            // panel_bot_state (راجع botState.js/panelRouter.js) بدل صف لكل
            // مستخدم، والسوبر أدمن مستثنى تلقائياً فما يقفل نفسه بره.
            if (scope === 'global') {
                await panelFetch('/ban-all', {
                    method: 'POST',
                    body: JSON.stringify({ reason: message, duration: duration || null })
                });
            } else {
                await panelFetch('/ban', {
                    method: 'POST',
                    body: JSON.stringify({ targetUserId, reason: message, duration: duration || null })
                });
            }

            // [NEW] الحظر نفسه نجح - نسجل كمان Account Action Notice (نفس
            // آلية alert/update/note) عشان يبان للمستخدم بالداشبورد (لو قدر
            // يفتحها) ويبقى معروض لين يضغط "I Understand" (requiresAck).
            // مستقل تماماً عن نجاح/فشل الحظر: لو فشل هذا النداء لأي سبب،
            // ما نوهم الأدمن إن الحظر فشل - الحظر أصلاً نجح فعلياً.
            try {
                await panelFetch('/actions', {
                    method: 'POST',
                    body: JSON.stringify({
                        scope,
                        targetUserId,
                        actionType: 'ban',
                        badgeColor,
                        title,
                        message,
                        deliveryChannel,
                        requiresAck: true
                    })
                });
            } catch (noticeErr) {
                console.error('[Adminpanel] Ban succeeded but failed to record dashboard notice:', noticeErr.message);
            }

            alert(scope === 'global' ? 'All users banned successfully.' : 'User banned successfully.');
            loadLogs();
        } catch (err) {
            alert(`Failed to ban: ${err.message}`);
        }
        return;
    }

    try {
        await panelFetch('/actions', {
            method: 'POST',
            body: JSON.stringify({
                scope,
                targetUserId,
                actionType,
                badgeColor,
                title,
                message,
                deliveryChannel,
                requiresAck: actionType === 'alert'
            })
        });
        alert('Notice dispatched successfully.');
        loadLogs();
    } catch (err) {
        alert(`Failed to dispatch notice: ${err.message}`);
    }
}

// ============================================================================
// [NEW] Logs - يستبدل DM Delivery Failures القديمة بالكامل. يعرض ثلاث
// فئات بنفس القائمة: حظر جماعي نشط (لو موجود) بأعلى القائمة، ثم الحظورات
// الفردية، ثم كل الإشعارات المُرسلة (Alert/Update/Note/Ban) مع حالة تسليم
// كل قناة (Dashboard/DM) وزر Undo لكل صف يستخدم endpoints الحذف الموجودة
// أصلاً (DELETE /ban/:id, /ban-all, /actions/:id).
// ============================================================================
const ACTION_TYPE_ICONS = { alert: 'fa-triangle-exclamation', update: 'fa-arrow-up-right-dots', note: 'fa-note-sticky', ban: 'fa-gavel' };

function statusPillHtml(status) {
    const label = status === 'delivered' ? 'Delivered' : status === 'failed' ? 'Failed' : 'N/A';
    return `<span class="log-status-pill status-${status}">${label}</span>`;
}

function logRowHtml({ typeClass, iconClass, iconColor, avatarUrl, title, meta, statusPills = '', undoBtnHtml = '' }) {
    const avatar = avatarUrl
        ? `<img class="log-row-avatar" src="${avatarUrl}" alt="">`
        : `<span class="log-row-avatar" style="display:flex; align-items:center; justify-content:center;"><i class="fa-solid ${iconClass}" style="color:${iconColor};"></i></span>`;
    return `
        <div class="log-row ${typeClass}">
            <div class="log-row-main">
                ${avatar}
                <div class="log-row-info">
                    <span class="log-row-title">${title}</span>
                    <span class="log-row-meta">${meta}</span>
                </div>
            </div>
            <div class="log-row-actions">
                ${statusPills}
                ${undoBtnHtml}
            </div>
        </div>
    `;
}

async function loadLogs() {
    const container = document.getElementById('logs_container');
    let data;
    try {
        data = await panelFetch('/logs');
    } catch (err) {
        console.error('[Adminpanel] Failed to load logs:', err.message);
        container.innerHTML = '<div class="search-empty-state">Failed to load logs.</div>';
        return;
    }

    const { bans = [], globalBan, actions = [] } = data;
    const rows = [];

    // 1) الحظر الجماعي - أعلى القائمة دايماً لو نشط (أهم حالة، يخص الكل)
    if (globalBan?.enabled) {
        const who = globalBan.bannedByUser?.displayName || globalBan.banned_by || 'Unknown';
        rows.push(logRowHtml({
            typeClass: 'log-type-global-ban',
            iconClass: 'fa-gavel',
            iconColor: 'var(--accent-red)',
            title: `Global Ban Active - ALL Users`,
            meta: `${escapeHtml(globalBan.reason || 'No reason provided')} · by ${escapeHtml(who)}${globalBan.at_expires ? ` · expires ${new Date(globalBan.at_expires).toLocaleString()}` : ' · permanent'}`,
            undoBtnHtml: `<button type="button" class="log-undo-btn" data-undo="global-ban"><i class="fa-solid fa-unlock"></i> Disable</button>`
        }));
    }

    // 2) الحظورات الفردية
    bans.forEach(b => {
        const who = b.user?.displayName || b.id_user;
        const by = b.bannedByUser?.displayName || b.banned_by;
        rows.push(logRowHtml({
            typeClass: 'log-type-ban',
            iconClass: 'fa-gavel',
            iconColor: 'var(--accent-red)',
            avatarUrl: b.user?.avatarUrl,
            title: `Banned: ${escapeHtml(who)} (${b.id_user})`,
            meta: `${escapeHtml(b.reason || 'No reason provided')} · by ${escapeHtml(by)}${b.at_expires ? ` · expires ${new Date(b.at_expires).toLocaleString()}` : ' · permanent'}`,
            undoBtnHtml: `<button type="button" class="log-undo-btn" data-undo="ban" data-user-id="${b.id_user}"><i class="fa-solid fa-unlock"></i> Unban</button>`
        }));
    });

    // 3) كل الإشعارات (Alert/Update/Note/Ban notice) - تشمل غير النشطة كمان (تاريخ)
    actions.forEach(a => {
        const icon = ACTION_TYPE_ICONS[a.action_type] || 'fa-circle-info';
        const target = a.scope === 'global' ? 'All Users' : (a.targetUser?.displayName || a.target_user_id || 'Unknown');
        const statusPills = statusPillHtml(a.delivery_status.dashboard) + statusPillHtml(a.delivery_status.dm);
        rows.push(logRowHtml({
            typeClass: '',
            iconClass: icon,
            iconColor: 'var(--accent-blue)',
            avatarUrl: a.targetUser?.avatarUrl,
            title: `${escapeHtml(a.title)} — ${escapeHtml(target)}`,
            meta: `${a.action_type.toUpperCase()} · ${new Date(a.at_created).toLocaleString()}${!a.active ? ' · <em>inactive</em>' : (a.scope === 'global' ? ` · ${a.acked_count} acknowledged` : '')}`,
            statusPills,
            undoBtnHtml: a.active ? `<button type="button" class="log-undo-btn" data-undo="action" data-action-id="${a.id}"><i class="fa-solid fa-eye-slash"></i> Deactivate</button>` : ''
        }));
    });

    if (rows.length === 0) {
        container.innerHTML = '<div class="search-empty-state">No logs yet.</div>';
        return;
    }

    container.innerHTML = rows.join('');

    // أزرار Undo - تفويض حدث واحد بدل مستمع لكل زر (القائمة تُعاد بناؤها كل تحديث)
    container.querySelectorAll('[data-undo]').forEach(btn => {
        btn.addEventListener('click', handleLogUndo);
    });
}

async function handleLogUndo(e) {
    const btn = e.currentTarget;
    const type = btn.dataset.undo;
    btn.disabled = true;

    try {
        if (type === 'global-ban') {
            if (!confirm('Disable the global ban and restore access for everyone?')) { btn.disabled = false; return; }
            await panelFetch('/ban-all', { method: 'DELETE' });
        } else if (type === 'ban') {
            if (!confirm(`Unban user ${btn.dataset.userId}?`)) { btn.disabled = false; return; }
            await panelFetch(`/ban/${btn.dataset.userId}`, { method: 'DELETE' });
        } else if (type === 'action') {
            if (!confirm('Deactivate this notice? It will stop being shown to its recipient(s).')) { btn.disabled = false; return; }
            await panelFetch(`/actions/${btn.dataset.actionId}`, { method: 'DELETE' });
        }
        await loadLogs();
    } catch (err) {
        alert(`Failed to undo: ${err.message}`);
        btn.disabled = false;
    }
}

// ============================================================================
// Boot Sequence
// ============================================================================
async function bootPanel() {
    try {
        renderFeatureFlagsGrid();
        initSearch();
        initBotStateWatchers();
        initActionCardWatchers();
        renderDispatchAvailability();

        await Promise.all([loadBotState(), loadFeatureFlags(), loadLogs()]);
        markClean();
    } catch (err) {
        console.error('[Adminpanel] Boot failed:', err.message);
    }

    document.getElementById('logs_refresh_btn')?.addEventListener('click', loadLogs);

    document.getElementById('panel_save_btn').addEventListener('click', async () => {
        setSaveButtonState('state-dirty', { text: 'Saving...', disabled: true });
        try {
            await Promise.all([saveBotState(), saveFeatureFlags()]);
            markSaved();
        } catch (err) {
            console.error('[Adminpanel] Save failed:', err.message);
            markError();
        }
    });
}

initSupabaseSessionBridge();