/**
 * ======================================================
 * OmniGuard - Member Search (search.html)
 * ======================================================
 * بحث حي عن الأعضاء (Autocomplete) - يعتمد بالكامل على المتغيرات/الدوال
 * العامة المعرّفة بـ dashboard.js (API_BASE, getHeaders, getGuildId).
 * لازم <script src="dashboard.js"> يكون قبل هذا الملف بملف search.html.
 *
 * Endpoint المستخدم: GET /api/guild/:guildId/members/search?q=...
 * (يرجع array من { id, username, avatarUrl })
 *
 * ⚠️ افتراضات عن عناصر HTML - عدّل الثابتين تحت لو الأسماء مختلفة عندك:
 *   - خانة الكتابة: id="memberSearchInput"
 *   - حاوية النتائج (جوا نفس الكرت): id="searchResultsContainer"
 */

const SEARCH_INPUT_ID = 'global_search_input';
const RESULTS_CONTAINER_ID = 'search_results_container';
const DEBOUNCE_MS = 300;
const DEFAULT_EMPTY_MESSAGE = '<div class="search-empty-state">Enter a query above to display results.</div>';

// --- Helpers خاصة بهذا الملف بس ---

function debounce(fn, delay) {
    let timeoutId = null;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

let currentRequestToken = 0; // يمنع نتائج قديمة تظهر بعد نتائج أحدث (Race Condition)

async function performMemberSearch(query) {
    const container = document.getElementById(RESULTS_CONTAINER_ID);
    if (!container) {
        console.error(`[search.js] Results container #${RESULTS_CONTAINER_ID} not found.`);
        return;
    }

    if (!query) {
        container.innerHTML = DEFAULT_EMPTY_MESSAGE;
        return;
    }

    const guildId = getGuildId(); // من dashboard.js
    if (!guildId) {
        container.innerHTML = '<div class="search-empty">Could not determine the current server.</div>';
        return;
    }

    const requestToken = ++currentRequestToken;
    container.innerHTML = '<div class="search-empty-state">Searching...</div>';

    try {
        const res = await fetch(
            `${API_BASE}/guild/${guildId}/members/search?q=${encodeURIComponent(query)}`,
            { headers: getHeaders() } // من dashboard.js - نفس نمط التوثيق المستخدم بكل الصفحات
        );

        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.error || `Request failed (${res.status})`);
        }

        const results = await res.json();

        // تجاهل نتائج طلب قديم لو المستخدم كتب حرف إضافي بعده
        if (requestToken !== currentRequestToken) return;

        renderSearchResults(results, container);
    } catch (err) {
        if (requestToken !== currentRequestToken) return;
        console.error('[search.js] Search failed:', err.message);
        container.innerHTML = '<div class="search-empty-state">Something went wrong. Please try again.</div>';
    }
}

function renderSearchResults(results, container) {
    if (!results || results.length === 0) {
        container.innerHTML = '<div class="search-empty-state">No matching members found.</div>';
        return;
    }

    container.innerHTML = results.map(member => `
        <div class="search-result-item" data-user-id="${escapeHtml(member.id)}" role="button" tabindex="0">
            <img class="search-result-avatar" src="${escapeHtml(member.avatarUrl)}" alt="${escapeHtml(member.username)}" width="32" height="32">
            <div class="search-result-info">
                <span class="search-result-username">${escapeHtml(member.username)}</span>
                <span class="search-result-id">${escapeHtml(member.id)}</span>
            </div>
        </div>
    `).join('');
}

function goToMemberProfile(userId) {
    const guildId = getGuildId(); // من dashboard.js
    const params = new URLSearchParams({ userId });
    if (guildId) params.set('guildId', guildId);
    window.location.href = `user-profile.html?${params.toString()}`;
}

// --- Event Wiring ---

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById(SEARCH_INPUT_ID);
    const container = document.getElementById(RESULTS_CONTAINER_ID);

    if (!input) {
        console.error(`[search.js] Search input #${SEARCH_INPUT_ID} not found.`);
        return;
    }
    if (!container) {
        console.error(`[search.js] Results container #${RESULTS_CONTAINER_ID} not found.`);
        return;
    }

    const debouncedSearch = debounce((value) => performMemberSearch(value.trim()), DEBOUNCE_MS);

    input.addEventListener('input', (e) => debouncedSearch(e.target.value));

    // نقرة أو Enter/Space (دعم الكيبورد) على أي نتيجة
    container.addEventListener('click', (e) => {
        const item = e.target.closest('.search-result-item');
        if (item) goToMemberProfile(item.dataset.userId);
    });

    container.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.search-result-item');
        if (item) {
            e.preventDefault();
            goToMemberProfile(item.dataset.userId);
        }
    });
});