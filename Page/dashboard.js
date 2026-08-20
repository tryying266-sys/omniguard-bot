/**
 * ======================================================
 * OmniGuard - Smart Dashboard Core (v5.0)
 * ======================================================
 * نظام الربط التلقائي بين واجهة المستخدم وقاعدة البيانات
 *
 * [تنبيه مهم قبل كل شي] الملف اللي كان موجود فعلياً قبل هالنسخة كان لسه
 * v4.0 حرفياً (رغم إن TODO.MD كان يوثّق "v5.0" جاهزة بميزتين: دعم
 * data-target-table وحد أقصى للتاقات) - هذا كان توثيق لخطة مستقبلية
 * اتكتبت قبل أوانها، مو وصف للملف الفعلي. هذا الملف هو أول تطبيق حقيقي
 * لهالميزتين.
 *
 * [v5.0 CHANGES - ما الجديد بهالنسخة، وليش كل وحدة منها]
 *
 * [FIX-1] دعم data-target-table (تعدد الجداول بنفس الصفحة) - كان ناقص
 *         بالكامل بـ v4.0. النتيجة الفعلية: general-settings.html (اللي
 *         موثّقة "جاهزة 100%") كانت معطوبة تماماً - حقل
 *         dashboard_access_roles (data-target-table="setting_management_role")
 *         كان ينحشر مع باقي حقول setting_guild بنفس طلب PUT وحد، وبما إن
 *         العمود مو موجود بجدول setting_guild، الحفظ كان بيفشل بالكامل
 *         (كل الصفحة، مو بس هالحقل - prefix_bot و nickname_server وكل
 *         شي معها). نفس الشي بالتحميل: كانت بيانات dashboard_access_roles
 *         المحفوظة فعلياً ما تنجيب أبداً لأن loadPageSettings() القديمة
 *         تجيب جدول واحد بس (endpointMap[page]).
 *         الحل: buildPayload() القديمة (الاسم والشكل ما تغيّروا إطلاقاً -
 *         راجع FIX-2 ليش) صارت تتجاهل عمداً أي عنصر عليه data-target-table
 *         لجدول مختلف عن جدول الصفحة الافتراضي، ودالة جديدة
 *         collectTargetTablePayloads() تجمعهم لحالهم بمعزل تام. loadPageSettings/
 *         savePageSettings يتعاملوا الحين مع أكثر من جدول بالتوازي
 *         (Promise.all/allSettled) ويدمجوا/يبلّغوا عن النتيجة.
 *
 * [FIX-2] buildPayload() أبقيناها **بنفس الاسم والشكل تماماً**
 *         ({guildId, updates} مسطحة لجدول الصفحة الافتراضي بس) - قرار
 *         متعمّد ومهم: role-management.html عندها سكربت محلي يلف
 *         window.buildPayload مباشرة عشان يشيل autoRemoveRolesBox/
 *         removalDelayTime من الـ payload قبل الإرسال (لأنهم يخصون جدول
 *         role_delay_config متعدد الصفوف، مو setting_management_role).
 *         لو غيّرنا اسم الدالة أو شكل رجوعها، هالصفحة كانت بتنكسر رغم
 *         إنها شغالة صح حالياً. الدالة الجديدة buildPayloadsByTable()
 *         تستدعي buildPayload() العادية (فتستفيد تلقائياً من أي override
 *         محلي عليها زي هذا) لجدول الصفحة الافتراضي بس، وتدمج معها نتيجة
 *         collectTargetTablePayloads() (اللي ما تمر على أي override -
 *         مقصود، لأن أي حقل معلّم data-target-table أصلاً "استثناء واعي"
 *         موثّق بالصفحة نفسها عبر الخاصية، ما يحتاج طبقة تدخل ثانية).
 *
 * [FIX-3] حقن CSS احتياطي لحالات زر الحفظ الأربعة + تعطيل الزر فوراً وقت
 *         تحميل السكربت نفسه (قبل حتى بداية أي طلب شبكة):
 *         - اكتُشف فعلياً إن auto-mod.html ما عندها ولا سطر CSS لـ
 *           .save-btn.state-* (بس .save-btn الأساسي) - الحفظ يشتغل، لكن
 *           بدون أي مؤشر بصري إطلاقاً (رمادي/أحمر/أخضر كلهم نفس الشكل).
 *         - اكتُشف فعلياً إن anti-alt.html: <button class="save-btn"> بدون
 *           state-default ولا disabled بالـ HTML الخام (بعكس باقي
 *           الصفحات). بما إن مستمع الضغط ينضاف فوراً بـ DOMContentLoaded
 *           (loadPageSettings() تُستدعى بدون await)، فيه احتمال - حتى لو
 *           ضعيف عملياً - إن يُضغط "Save" قبل ما يخلص تحميل الإعدادات
 *           المحفوظة، فترسل قيم افتراضية فاضية فوق بيانات حقيقية.
 *         الحل: injectFallbackStyles() تحقن <style> بأول <head> (عشان أي
 *         تنسيق مخصص بالصفحة نفسها - المعرّف بعدها بترتيب المستند - يبقى
 *         الأقوى ويطغى عليها طبيعياً بدون أي تعارض)، و markClean() تُستدعى
 *         فوراً وقت تحميل السكربت (مو بس بعد اكتمال التحميل)، فيصير الزر
 *         رمادي/معطّل من أول لحظة بغض النظر عن حالة الـ HTML الخام أو سرعة
 *         الشبكة.
 *
 * [FIX-4] data-max-tags اختياري (بدل رقم موحّد مفروض من الملف نفسه):
 *         general-settings.html عندها حد محلي 50 (بتلف addDiscordTag)،
 *         و auto-mod.html عندها حد محلي 100 لصندوق الكلمات الممنوعة (بمستمع
 *         مباشر على input.tag-input-ghost). لو حطينا رقم افتراضي صلب جوه
 *         الملف (كان مقترح 25 بـ TODO.MD)، كان بيتعارض بصمت مع الاثنين
 *         (لو الرقم الداخلي أقل من حد الصفحة، تاقات إضافية كانت بترفض
 *         بصمت رغم إن واجهة الصفحة تقول إنها مسموحة). الحل: الافتراضي
 *         الحين "بدون حد" (نفس سلوك v4.0 القديم بالضبط - صفر تغيير
 *         بالسلوك لأي صفحة موجودة)، وأي صفحة (حالية أو مستقبلية) تقدر
 *         تصرّح data-max-tags="25" على أي .selector-box أو .filter-tags-box
 *         فتُطبَّق تلقائياً - بدون كتابة أي جافاسكربت إضافي.
 *
 * [FIX-5] رسالة console.warn لو الصفحة الحالية مو مسجّلة بـ endpointMap
 *         (كانت "مشكلة السحب الصامت" الموثّقة بالتقرير - كانت الصفحة تفتح
 *         وتشتغل الواجهة، بس ما تحمّل ولا تحفظ أي شي بدون أي رسالة خطأ
 *         إطلاقاً). الحين على الأقل تبان رسالة واضحة بالكونسول.
 *
 * ⚠️ [KNOWN GAP - ما لهذا الملف علاقة فيه، يحتاج قرارك] auto-mod.html
 *         (كما هي الآن) فيها حقلين (id="limit_trigger_mute" و
 *         id="mute_trigger_action" - قسم "Mute Accumulation Rules") ما
 *         يطابقوا أي عمود فعلي بجدول setting_moderation_security. أقرب
 *         شي منطقياً هو Tier 2 "Severe" (limit_trigger_severe /
 *         severe_trigger_action / severe_trigger_duration) الموجود
 *         بالسكيما، بس القيم المسموحة مختلفة (severe_trigger_action يقبل
 *         بس mute/kick/ban، بينما الواجهة عندها خيارات none/demote/kick/ban)
 *         وما فيه حقل مدة (severe_trigger_duration) بالواجهة أصلاً. على
 *         عكس role-management.html، هالصفحة **ما عندها أي سكربت عزل محلي**
 *         لهالحقلين. النتيجة: أول ضغطة Save على auto-mod.html ككل ستفشل
 *         (خطأ عمود غير موجود بـ PostgREST) - نفس نمط المشكلة اللي كانت
 *         بـ general-settings.html بالضبط (FIX-1)، بس هالمرة السبب محتوى/
 *         سكيما مو بنية dashboard.js، فما قدرت أحله من هذا الملف بدون
 *         تخمين قرار مو من صلاحيتي. الخيارات المتاحة: (أ) إضافة عمودين
 *         جديدين بالسكيما تطابق أسماء/قيم الواجهة تماماً، (ب) تعديل
 *         id/خيارات الواجهة لتطابق severe_trigger_action الموجود فعلاً،
 *         (ج) عزل الحقلين محلياً بسكربت زي role-management.html لين ما
 *         يُحسم القرار. ما لمست auto-mod.html إطلاقاً - بانتظار قرارك.
 *
 * [KNOWN GAP - من v4.0، لسه معلّق] استدعاء PUT /guild/:guildId/nickname
 *         يفترض وجود route مخصص بـ apiRouter.js يستدعي GRS.enforceNickname()
 *         فوراً - هذا الـ route مو موجود بعد. أبقيناه best-effort (ما يوقف
 *         باقي الحفظ ولا يأثر على حالة الزر)، وصار الحين يشتغل بغض النظر
 *         عن اسم الصفحة (أي جدول اسمه setting_guild ضمن نتائج الحفظ، لو
 *         نجح وفيه nickname_server بالـ payload تبعه) بدل ما يكون مربوط
 *         حرفياً باسم صفحة general-settings.html فقط - أدق لو صفحة ثانية
 *         مستقبلاً صار عندها حقل من setting_guild عبر data-target-table.
 * ======================================================
 */


const API_BASE = `${window.location.origin}/api`;

// --- [0] Supabase Session Bridge ---
// ⚠️ يتطلب <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// قبل dashboard.js بكل صفحة (index.html/Login.html عندهم هذا أصلاً - باقي
// صفحات الداشبورد لسا ناقصينه - راجع الملاحظة بنهاية الرد).
//
// getHeaders() تبقى دالة متزامنة (Sync) بقصد - نخزّن الـ token بمتغير
// بالذاكرة يتحدث تلقائياً بالخلفية، بدل ما نحول getHeaders() لـ async
// ونضطر نعدل كل استدعاء لها بكل الملفات (search.js/userprofile.js).
// --- [0] Supabase Session Bridge ---
const SUPABASE_URL = 'https://lcnjswibemyenakwojkz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxjbmpzd2liZW15ZW5ha3dvamt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODQ0ODEsImV4cCI6MjA5OTQ2MDQ4MX0.AfbKJsd6sOK1FPz2w-rH3XT28m4eneB1uNJEyETJ9ug';

// تعريف المتغيرات عالمياً لتكون متاحة لكل الصفحات بنفس الاسم
let supabaseClient = null; 
let cachedUserToken = null;

async function initSupabaseSessionBridge() {
    if (typeof supabase === 'undefined') {
        console.warn('[OmniGuard Dashboard] Supabase JS SDK not loaded.');
        return;
    }

    // إنشاء العميل باسم supabaseClient ليتوافق مع كل الصفحات
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    // جلب الجلسة والتحقق من الحماية فوراً
    const { data, error } = await supabaseClient.auth.getSession();
    const session = data?.session;
    
    if (session) {
        cachedUserToken = session.access_token;
        initGlobalHeader(session);
        applyFeatureFlagVisibility(); // [NEW] Adminpanel Feature Flags enforcement
    } else {
        // [الحماية المركزية] إذا لم تكن في صفحة تسجيل الدخول ولا توجد جلسة، اخرج فوراً
        if (!window.location.pathname.includes('Login.html')) {
            window.location.href = 'Login.html';
        }
    }

    // مراقبة تغير حالة الدخول (مثلاً عند انتهاء التوكن)
    supabaseClient.auth.onAuthStateChange((event, session) => {
        const newToken = session?.access_token || null;

        // [FIX] Supabase يطلق هذا الحدث تلقائياً فوراً بعد الاشتراك فيه حتى
        // لو الـ session ما تغيّرت شي (نفس التوكن بالضبط) - كان هذا يسبب
        // نداء مزدوج لـ initGlobalHeader() (مرة من getSession() فوق، ومرة
        // من هنا) بفارق ميلي ثانية، فيبني القائمة المنسدلة مرتين وتصير
        // عناصرها DOM/onchange تُستبدل تحت يد المستخدم - أول ضغطة تضيع.
        // نتجاهل النداء لو التوكن نفسه ما تغيّر فعلياً.
        if (newToken === cachedUserToken) return;

        cachedUserToken = newToken;
        if (session) {
            initGlobalHeader(session);
        } else if (event === 'SIGNED_OUT' && !window.location.pathname.includes('Login.html')) {
            window.location.href = 'Login.html';
        }
    });
}

// تشغيل الجسر فوراً
initSupabaseSessionBridge();

// --- [1] أدوات المساعدة الأساسية ---

function getGuildId() {
    const searchParams = new URLSearchParams(window.location.search);
    let gid = searchParams.get('guildId') || searchParams.get('guild_id');
    
    if (gid) {
        localStorage.setItem('selected_guild_id', gid);
        return gid;
    }

    const fromStorage = localStorage.getItem('selected_guild_id');
    if (fromStorage) return fromStorage;

    const meta = document.querySelector('meta[name="dashboard-guild-id"]');
    return meta?.content?.trim() || null;
}



function getPageKey() {
    let path = window.location.pathname.split('/').pop().toLowerCase();
    if (!path || path === '') return 'index.html';
    // إذا كان الرابط نظيف (بدون نقطة)، أضف .html داخلياً للبحث في الخريطة
    if (!path.includes('.')) {
        path += '.html';
    }
    return path;
}

// ============================================================================
// [NEW] Feature Flags Enforcement (Adminpanel.html Feature Flags)
// ============================================================================
// خريطة اسم الصفحة (نفس مخرجات getPageKey - lowercase + .html) <-> flag_key
// المطابق بجدول panel_feature_flags. مبنية من روابط الشريط الجانبي الفعلية
// (general-settings.html) - أي صفحة جديدة تُضاف مستقبلاً لازم تُضاف هنا يدوياً.
//
// [ملاحظة صدق] 'ticket_panel' مربوطة بـ Permissionspanel كأقرب تخمين منطقي
// (ما وضح لي اسم صفحة "Ticket Panel" الفعلي بالمشروع) - و'ticket' نفسها
// (بدون لاحقة) ما لها صفحة واضحة بالشريط الجانبي اللي شفته، فتفضل بدون
// تطبيق فعلي لين توضح لي أي صفحة بالضبط تقصدها.
const FEATURE_FLAG_PAGE_MAP = {
    'search.html': 'search',
    'index.html': 'home',
    'general-settings.html': 'general_settings',
    'welcome-leave.html': 'welcome',
    'role-management.html': 'role_management',
    'auto-mod.html': 'auto_mod',
    'anti-alt.html': 'anti_alt',
    'autorespond.html': 'auto_respond',
    'category.html': 'ticket_category',
    'autolog.html': 'ticket_auto_log',
    'permissionspanel.html': 'ticket_panel',
    'custom-messages.html': 'custom_messages',
    'level.html': 'level_system',
    'commands.html': 'command_customization'
};

async function applyFeatureFlagVisibility() {
    let flags;
    try {
        const response = await fetch(`${window.location.origin}/api/feature-flags/effective`, { headers: getHeaders() });
        if (!response.ok) return; // فشل صامت - ما نكسر باقي الصفحة عشان هذا فقط
        flags = await response.json();
    } catch (err) {
        console.error('[OmniGuard Dashboard] Failed to load feature flags:', err.message);
        return;
    }

    // 1) إخفاء أي رابط بالشريط الجانبي مقفول لهذا المستخدم
    document.querySelectorAll('.menu-item a[href]').forEach(link => {
        const hrefKey = link.getAttribute('href').split('/').pop().toLowerCase() + '.html';
        const flagKey = FEATURE_FLAG_PAGE_MAP[hrefKey];
        if (flagKey && flags[flagKey] === false) {
            const li = link.closest('.menu-item');
            if (li) li.style.display = 'none';
        }
    });

    // 2) منع الوصول المباشر بالرابط للصفحة الحالية لو هي نفسها مقفولة
    const currentFlagKey = FEATURE_FLAG_PAGE_MAP[getPageKey()];
    if (currentFlagKey && flags[currentFlagKey] === false) {
        window.location.href = 'index';
    }
}

function getHeaders() {
    const headers = {
        'Content-Type': 'application/json'
    };

    // [SECURITY REWRITE] المفتاح الثابت انحذف نهائياً - الهوية الحقيقية
    // الوحيدة الحين هي توكن Supabase (الجلسة بعد تسجيل الدخول بديسكورد).
    // بدونه السيرفر يرفض أي طلب حساس (401/403) بغض النظر عن أي هيدر ثاني.
    if (cachedUserToken) {
        headers['X-User-Token'] = cachedUserToken;
    }

    return headers;
}

// خريطة المسارات للـ API بناءً على الصفحة الحالية
// خريطة الربط الذكي: (اسم الصفحة HTML) مقابل (اسم الجدول الافتراضي بالسكيما)
// ملاحظة: هذا هو الجدول الافتراضي بس - أي عنصر عليه data-target-table
// صريح يروح لجدوله المكتوب بدل هذا (راجع FIX-1 بأعلى الملف).
const endpointMap = {
    'general-settings.html': 'setting_guild',
    'anti-alt.html': 'setting_alt_anti',
    'welcome-leave.html': 'setting_leave_welcome',
    'auto-mod.html': 'setting_moderation_security',
    'role-management.html': 'setting_management_role',
    'leveling-system.html': 'setting_leveling',
    'level.html': 'setting_leveling'
};

// --- [2] بيانات هيكل السيرفر (رتب + قنوات) من guild_structure_cache ---
// [من v4.0] بديل fetchDiscordData()/populateDropdowns() القديمة اللي كانت
// تنادي مسارات /channels و /roles غير الموجودة إطلاقاً.

// نخزّن آخر نسخة محمّلة هنا عشان renderTags() تقدر تحوّل ID -> اسم ظاهر
// وقت تعبئة القيم المحفوظة بالفورم.
const guildStructure = { roles: [], channels: [] };

async function fetchGuildStructure() {
    const guildId = getGuildId();
    if (!guildId) return;

    try {
        const response = await fetch(`${API_BASE}/guild/${guildId}/guild_structure_cache`, { headers: getHeaders() });
        const data = await response.json();

        guildStructure.roles = (response.ok && Array.isArray(data?.roles)) ? data.roles : [];
        guildStructure.channels = (response.ok && Array.isArray(data?.channels)) ? data.channels : [];
    } catch (error) {
        console.error('[Guild Structure Error]:', error);
        guildStructure.roles = [];
        guildStructure.channels = [];
    }

    populateDiscordSelectors();
}

function findChannelById(channelId) {
    for (const group of guildStructure.channels) {
        const found = (group.channels || []).find(c => c.id === channelId);
        if (found) return found;
    }
    return null;
}

// أنواع القنوات النصية بس (نفس قيم discord.js ChannelType):
// 0 = GuildText, 5 = GuildAnnouncement. نستثني الصوتية/الأقسام/الفورم عمداً
// من قوائم whitelist/blacklist لأن هذي خاصة بأوامر الشات النصية.
const TEXT_CHANNEL_TYPES = [0, 5];

/**
 * يعبّي كل صناديق .selector-box[data-source] الموجودة بالصفحة
 * (سواء كانت data-source="roles" أو "channels") بقوائمها المنسدلة،
 * بناءً على guildStructure المحمّلة حالياً.
 */
function populateDiscordSelectors() {
    document.querySelectorAll('.selector-box[data-source]').forEach(box => {
        const source = box.dataset.source;
        const dropdownId = box.dataset.dropdown;
        const dropdown = dropdownId ? document.getElementById(dropdownId) : null;
        if (!dropdown) return;

        dropdown.innerHTML = '';

        if (source === 'roles') {
            if (guildStructure.roles.length === 0) {
                dropdown.innerHTML = '<div class="dropdown-empty">No roles synced yet - try again shortly</div>';
                return;
            }
            // الرتب أصلاً جاية مرتبة حسب التسلسل الهرمي من getroles.js
            guildStructure.roles.forEach(role => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.textContent = role.name;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    addDiscordTag(box.id, role.id, role.name);
                    dropdown.classList.remove('show');
                });
                dropdown.appendChild(item);
            });
            return;
        }

        if (source === 'channels') {
            const groupsWithChannels = guildStructure.channels
                .map(group => ({
                    ...group,
                    channels: (group.channels || []).filter(c => TEXT_CHANNEL_TYPES.includes(c.type))
                }))
                .filter(group => group.channels.length > 0);

            if (groupsWithChannels.length === 0) {
                dropdown.innerHTML = '<div class="dropdown-empty">No text channels synced yet - try again shortly</div>';
                return;
            }

            // مجمّعة حسب الأقسام ومرتبة، زي ما getroles.js يخزنها بالضبط
            groupsWithChannels.forEach(group => {
                const header = document.createElement('div');
                header.className = 'dropdown-category-header';
                header.textContent = group.categoryName;
                dropdown.appendChild(header);

                group.channels.forEach(channel => {
                    const item = document.createElement('div');
                    item.className = 'dropdown-item';
                    item.textContent = `# ${channel.name}`;
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        addDiscordTag(box.id, channel.id, `# ${channel.name}`);
                        dropdown.classList.remove('show');
                    });
                    
                    dropdown.appendChild(item);
                });
            });
        }
    });

    // [NEW] قوائم اختيار قناة مفردة (native <select>) - نفس بيانات القنوات
    // المستخدمة فوق لصناديق التاجات، لكن تُبنى كـ <optgroup>/<option>
    // حقيقية بدل Dropdown مخصص - عشان تنتج قيمة نصية مفردة (TEXT عادي) مو
    // مصفوفة، يطابق طبيعة أعمدة زي panel_channel_id. الـ <optgroup> نفسه
    // غير قابل للاختيار بطبيعته بالمتصفح - يضمن إن المشرف يختار قناة بس،
    // مو الكاتيغوري.
    document.querySelectorAll('select[data-source="channels"]').forEach(select => {
        const previousValue = select.value;
        select.innerHTML = '<option value="">Select a channel...</option>';

        const groupsWithChannels = guildStructure.channels
            .map(group => ({
                ...group,
                channels: (group.channels || []).filter(c => TEXT_CHANNEL_TYPES.includes(c.type))
            }))
            .filter(group => group.channels.length > 0);

        groupsWithChannels.forEach(group => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = group.categoryName;
            group.channels.forEach(channel => {
                const option = document.createElement('option');
                option.value = channel.id;
                option.textContent = `# ${channel.name}`;
                optgroup.appendChild(option);
            });
            select.appendChild(optgroup);
        });

        if (previousValue) select.value = previousValue; // يحافظ على القيمة لو انعاد البناء
    });
}

// --- [3] محرك الربط الذكي (Smart Binding Engine) ---

/**
 * [v5.0] يحدد الجدول المستهدف الفعلي لعنصر معيّن: data-target-table لو
 * موجود، وإلا الجدول الافتراضي المُمرَّر (عادة endpointMap[getPageKey()]).
 */
function getElementTargetTable(el, defaultTable) {
    return el.dataset.targetTable || defaultTable;
}

/**
 * وظيفة الجمع التلقائي **لجدول الصفحة الافتراضي بس** (نفس اسم وشكل
 * v4.0 تماماً بدون أي تغيير على الواجهة الخارجية - راجع FIX-2 بأعلى
 * الملف ليش هذا مهم/مقصود). أي عنصر عليه data-target-table لجدول مختلف
 * عن الافتراضي يتم تجاهله هنا عمداً - يُجمع بمعزل تام بواسطة
 * collectTargetTablePayloads() تحت.
 */
function buildPayload() {
    const defaultTable = endpointMap[getPageKey()];
    const updates = {};

    // 1. جمع الحقول العادية (Text, Number, Select, Checkbox)
    document.querySelectorAll('input, select, textarea').forEach(el => {
        if (!el.id || el.id === '') return;
         if (el.id === 'guild-selector') return; // FIX HERE: تجاهل قائمة اختيار السيرفر
        if (el.classList.contains('tag-input-ghost')) return; // مدخلات التاقات لها دالة خاصة
        // [NEW] data-transient="true" - عنصر مؤقت بواجهة الصفحة (مثلاً
        // خانة إدخال محلية لإضافة صف بجدول متعدد الصفوف عبر API مخصص:
        // Role XP Multipliers/Tiered Brackets بصفحة Level.html، Manual
        // Override إلخ) - له id عشان JS محلي يقدر يقرأه، بس مالوش أي
        // عمود مطابق بجدول الإعدادات صف-واحد-لكل-سيرفر، فما يصح يُجمع
        // بالـ Smart Binding العام إطلاقاً. راجع تعليق مشابه بحلقة #2 تحت.
        if (el.dataset.transient === 'true') return;

        if (getElementTargetTable(el, defaultTable) !== defaultTable) return; // يخص جدول ثاني

        
        if (el.type === 'checkbox') {
            updates[el.id] = el.checked;
        } else if (el.type === 'number') {
            updates[el.id] = parseInt(el.value) || 0;
        } else if (el.tagName === 'SELECT' && el.value === '') {
            // [FIX] قائمة منسدلة اختيارية بدون اختيار فعلي - نرسل null بدل
            // نص فاضي "" عشان ما يخالف CHECK constraint على أعمدة زي
            // severe_trigger_action اللي تسمح فقط بقيم محددة أو null.
            updates[el.id] = null;
        } else {
            updates[el.id] = el.value;
        }
    });

    // 2. جمع التاقات (المصفوفات مثل الرتب والقنوات المتعددة)
    document.querySelectorAll('.selector-box, .filter-tags-box').forEach(box => {
        const fieldName = box.id;
        if (!fieldName) return;
        if (box.dataset.transient === 'true') return; // [NEW] راجع تعليق حلقة #1 فوق
        if (getElementTargetTable(box, defaultTable) !== defaultTable) return; // يخص جدول ثاني

        updates[fieldName] = collectTags(`#${fieldName}`);
    });

    return { guildId: getGuildId(), updates };
}

/**
 * [v5.0 NEW] يجمع كل العناصر اللي عليها data-target-table صريح لجدول
 * **مختلف** عن جدول الصفحة الافتراضي، ويرجعها كـ payloads منفصلة لكل
 * جدول. بمعزل تام عن buildPayload() (وأي override محلي عليها) عمداً -
 * راجع FIX-2 بأعلى الملف.
 */
function collectTargetTablePayloads() {
    const defaultTable = endpointMap[getPageKey()];
    const extraPayloads = {}; // { tableName: {guildId, updates} }

    function bucketFor(table) {
        if (!extraPayloads[table]) {
            extraPayloads[table] = { guildId: getGuildId(), updates: {} };
        }
        return extraPayloads[table];
    }

    document.querySelectorAll('[data-target-table]').forEach(el => {
        const table = el.dataset.targetTable;
        if (!table || table === defaultTable || !el.id) return;

        if (el.matches('.selector-box, .filter-tags-box')) {
            bucketFor(table).updates[el.id] = collectTags(`#${el.id}`);
        } else if (el.matches('input, select, textarea')) {
            if (el.classList.contains('tag-input-ghost')) return;
            if (el.type === 'checkbox') {
                bucketFor(table).updates[el.id] = el.checked;
            } else if (el.type === 'number') {
                bucketFor(table).updates[el.id] = parseInt(el.value) || 0;
            } else {
                bucketFor(table).updates[el.id] = el.value;
            }
        }
    });

    return extraPayloads;
}

/**
 * [v5.0 NEW] النتيجة الكاملة الجاهزة للحفظ: جدول الصفحة الافتراضي (عبر
 * buildPayload() - يستفيد تلقائياً من أي override محلي زي
 * role-management.html) + أي جداول إضافية عبر data-target-table.
 * الشكل: { tableName: {guildId, updates}, ... }
 */
function buildPayloadsByTable() {
    const defaultTable = endpointMap[getPageKey()];
    const payloads = {};

    if (defaultTable) {
        payloads[defaultTable] = buildPayload();
    }

    Object.assign(payloads, collectTargetTablePayloads());
    return payloads;
}

/**
 * وظيفة التوزيع التلقائي: تأخذ البيانات من API وتوزعها على الـ HTML.
 * بدون تغيير عن v4.0 - تُستدعى الحين أكثر من مرة (مرة لكل جدول) لو
 * الصفحة فيها data-target-table، بس المنطق الداخلي نفسه بالضبط.
 */
function populateUI(data) {
    if (!data) return;

    for (const [key, value] of Object.entries(data)) {
        const el = document.getElementById(key);
        if (!el) continue;

        if (el.type === 'checkbox') {
            el.checked = Boolean(value);
        } else if (el.classList.contains('selector-box') || el.classList.contains('filter-tags-box')) {
            // نمرر data-source (roles/channels/null) عشان renderTags تعرف
            // تحوّل الـ ID المخزّن لاسم ظاهر أو تسيبه كما هو لو تاق نصي حر.
            renderTags(`#${key}`, Array.isArray(value) ? value : [], el.dataset.source || null);
        } else {
            el.value = value || '';
        }
    }
}

// --- [4] العمليات الأساسية (Load & Save) ---

async function loadPageSettings() {
    const guildId = getGuildId();
    const page = getPageKey();
    const defaultTable = endpointMap[page];

    if (!guildId) {
        console.warn('[OmniGuard Dashboard] ما فيه guildId (لا بـ query string ولا meta tag) - ما راح يتحمّل أي شي.');
        markClean();
        return;
    }

    if (!defaultTable) {
        // [FIX-5] بدل الفشل الصامت الكامل - على الأقل رسالة واضحة بالكونسول.
        console.warn(`[OmniGuard Dashboard] الصفحة "${page}" مو مسجّلة بـ endpointMap - بيتحمّل بس الحقول اللي عندها data-target-table صريح (لو فيه).`);
    }

    try {
        // ما نجيب هيكل السيرفر إلا لو الصفحة فعلاً فيها صناديق رتب/قنوات -
        // تجنّب نداء API زايد على صفحات ما تحتاجه.
        const needsStructure = document.querySelector('.selector-box[data-source]');
        if (needsStructure) {
            await fetchGuildStructure();
        }

        // [FIX-1] كل الجداول المطلوبة بهالصفحة: الافتراضي + أي data-target-table
        // صريح يشاور لجدول مختلف عنه.
        const extraTables = new Set();
        document.querySelectorAll('[data-target-table]').forEach(el => {
            const t = el.dataset.targetTable;
            if (t && t !== defaultTable) extraTables.add(t);
        });
        const tables = [...(defaultTable ? [defaultTable] : []), ...extraTables];

        const results = await Promise.all(tables.map(async (table) => {
            try {
                const response = await fetch(`${API_BASE}/guild/${guildId}/${table}`, { headers: getHeaders() });
                const data = await response.json();
                return { table, ok: response.ok, data };
            } catch (err) {
                return { table, ok: false, data: null, error: err };
            }
        }));

        results.forEach(({ table, ok, data, error }) => {
            if (ok) {
                populateUI(data);
            } else {
                console.error(`[Load Error - ${table}]:`, error || data?.error || 'Failed to load settings');
            }
        });

        // جلب السجلات إذا كنا في صفحة Anti-Alt
        if (page === 'anti-alt.html') fetchAntiAltLogs();

    } catch (e) {
        console.error('[Load Error]:', e);
    } finally {
        // صفحة لسه بس فتحت = ما فيه تعديلات لسه بالتعريف، بغض النظر عن
        // نجاح أو فشل التحميل.
        markClean();
    }
}

async function savePageSettings() {
    const guildId = getGuildId();
    const payloadsByTable = buildPayloadsByTable(); // [FIX-1]
    const tables = Object.keys(payloadsByTable);

    if (tables.length === 0) {
        console.warn('[OmniGuard Dashboard] ما فيه أي حقول قابلة للحفظ بهالصفحة.');
        return;
    }

    try {
        const results = await Promise.all(tables.map(async (table) => {
            const payload = payloadsByTable[table];
            try {
                const response = await fetch(`${API_BASE}/guild/${guildId}/${table}`, {
                    method: 'PUT',
                    headers: getHeaders(),
                    body: JSON.stringify(payload)
                });

                if (response.ok) return { table, ok: true, payload };

                const err = await response.json().catch(() => ({}));
                return { table, ok: false, payload, error: err.error || 'Failed to save' };
            } catch (networkErr) {
                return { table, ok: false, payload, error: networkErr.message };
            }
        }));

        const failed = results.filter(r => !r.ok);

        if (failed.length === 0) {
            markSaved();

            // ميزة خاصة: إذا تم تغيير الاسم المستعار (أي جدول اسمه setting_guild
            // ضمن نتائج الحفظ الناجحة - بدل ما يكون مربوط باسم صفحة
            // general-settings.html حرفياً، أدق لو صفحة ثانية مستقبلاً صار
            // عندها nickname_server عبر data-target-table).
            // [KNOWN GAP] هذا الـ route مو موجود بعد بـ apiRouter.js - راجع
            // التعليق بأعلى الملف. best-effort: ما يوقف الحفظ ولا يأثر على
            // حالة الزر لو فشل.
            const guildResult = results.find(r => r.table === 'setting_guild');
            if (guildResult && guildResult.payload.updates.nickname_server) {
                fetch(`${API_BASE}/guild/${guildId}/nickname`, {
                    method: 'PUT',
                    headers: getHeaders(),
                    body: JSON.stringify({ nickname: guildResult.payload.updates.nickname_server })
                }).catch(() => {});
            }
        } else {
            markError();
            failed.forEach(f => console.error(`[Save Error - ${f.table}]:`, f.error));
        }
    } catch (error) {
        markError();
        console.error('[Network Error]:', error.message);
    }
}

// --- [5] إدارة التاقات (Tags Management) ---
// [من v4.0] موحّدة لثلاث حالات استخدام: تاقات نصية حرة (بدون data-source)،
// رتب (data-source="roles")، قنوات (data-source="channels"). كل تاق يخزّن
// قيمته الحقيقية بـ data-id بغض النظر عن مصدره.

function createTagElement(id, displayName) {
    const tag = document.createElement('div');
    tag.className = 'tag-item';
    tag.dataset.id = id;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = displayName;

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', removeTagItem);

    tag.appendChild(nameSpan);
    tag.appendChild(removeBtn);
    return tag;
}

function removeTagItem(event) {
    event.stopPropagation(); // يمنع فتح/إغلاق الـ dropdown بالخطأ
    event.currentTarget.closest('.tag-item')?.remove();
    markDirty();
}

/**
 * [v5.0 NEW] الحد الأقصى المسموح لصندوق معيّن - عبر data-max-tags
 * الاختياري بس (راجع FIX-4 بأعلى الملف ليش مافيه رقم افتراضي موحّد).
 * بدون تصريح = بدون حد (نفس سلوك v4.0 الأصلي بالضبط).
 */
function getMaxTags(box) {
    const raw = box?.dataset?.maxTags;
    const n = raw ? parseInt(raw, 10) : NaN;
    return (Number.isFinite(n) && n > 0) ? n : Infinity;
}

/**
 * [v5.0 NEW] تنبيه بصري موحّد لما صندوق يوصل حده الأقصى (data-max-tags).
 * يعتمد على كلاس .limit-warning - له تنسيق احتياطي مُحقن (راجع FIX-3)
 * لو الصفحة ما عرّفته بنفسها.
 */
function showTagLimitWarning(box, max) {
    if (!box?.parentElement) return;
    if (box.parentElement.querySelector('.limit-warning')) return; // يمنع تكديس أكثر من تنبيه
    const warning = document.createElement('div');
    warning.className = 'limit-warning';
    warning.textContent = `Maximum ${max} items reached`;
    box.insertAdjacentElement('afterend', warning);
    setTimeout(() => warning.remove(), 2000);
}

/**
 * إضافة تاق مختار من قائمة ديسكورد (رتبة أو قناة) - يمنع التكرار تلقائياً.
 */
function addDiscordTag(boxId, id, displayName) {
    const box = document.getElementById(boxId);
    if (!box) return;

    const alreadyAdded = Array.from(box.querySelectorAll('.tag-item')).some(t => t.dataset.id === id);
    if (alreadyAdded) return;

    const max = getMaxTags(box);
    if (box.querySelectorAll('.tag-item').length >= max) {
        showTagLimitWarning(box, max);
        return;
    }

    box.appendChild(createTagElement(id, displayName));
    markDirty();
}

function collectTags(containerSelector) {
    const container = document.querySelector(containerSelector);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.tag-item'))
        .map(tag => tag.dataset.id)
        .filter(Boolean);
}

/**
 * @param {string} containerSelector - مثال: '#whitelisted_channels'
 * @param {string[]} items - القيم المخزّنة بقاعدة البيانات (Discord IDs أو نص حر)
 * @param {?string} lookupType - 'roles' | 'channels' | null (نص حر - بدون تحويل)
 */
function renderTags(containerSelector, items, lookupType = null) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    const input = container.querySelector('input');
    container.querySelectorAll('.tag-item').forEach(t => t.remove());

    items.forEach(rawValue => {
        let displayName = rawValue;

        if (lookupType === 'roles') {
            const role = guildStructure.roles.find(r => r.id === rawValue);
            displayName = role ? role.name : 'Unknown Role';
        } else if (lookupType === 'channels') {
            const channel = findChannelById(rawValue);
            displayName = channel ? `# ${channel.name}` : 'Unknown Channel';
        }

        const tag = createTagElement(rawValue, displayName);
        if (input) container.insertBefore(tag, input);
        else container.appendChild(tag);
    });
}

// --- [6] سجلات Anti-Alt (وظيفة خاصة) ---

async function fetchAntiAltLogs() {
    const guildId = getGuildId();
    const logGrid = document.querySelector('.log-grid');
    if (!logGrid) return; // الصفحة ما فيها قسم سجلات (مثال: انسحب من التصميم)

    try {
        const response = await fetch(`${API_BASE}/guild/${guildId}/alt-anti/logs`, { headers: getHeaders() });
        const logs = await response.json();
        logGrid.innerHTML = '';

        if (!logs || logs.length === 0) {
            logGrid.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color:var(--text-secondary);">No suspicious activities found.</p>';
            return;
        }

        logs.forEach(log => {
            const card = document.createElement('div');
            card.className = 'flagged-user-card';
            card.innerHTML = `
                <img src="${log.url_avatar || 'https://cdn.discordapp.com/embed/avatars/0.png'}" class="user-avatar">
                <div class="user-details">
                    <span class="username">${log.username}</span>
                    <span class="action-badge">${log.action_taken}</span>
                    <small>Detected: ${new Date(log.at_detected).toLocaleDateString()}</small>
                </div>
            `;
            logGrid.appendChild(card);
        });
    } catch (e) { console.error('Logs fetch error:', e); }
}

// --- [NEW] Global Header Logic (Profile & Guilds) ---

/**
 * [NEW] يسجل المستخدم تلقائياً بـ dashboard_staff بناءً على صلاحيته
 * الفعلية بديسكورد لهذا السيرفر - best-effort، ما يوقف تحميل الصفحة لو
 * فشل (مثلاً السيرفر ما فيه guildId بعد، أو المستخدم ما له صلاحية أصلاً -
 * الرفض هذا متوقع ومقصود، مو خطأ يستاهل إزعاج المستخدم).
 */
async function ensureStaffRegistration() {
    const guildId = getGuildId();
    if (!guildId) return;

    try {
        const res = await fetch(`${API_BASE}/guild/${guildId}/staff/self-register`, {
            method: 'POST',
            headers: getHeaders()
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            console.warn('[OmniGuard Dashboard] Staff self-registration:', body.error || `HTTP ${res.status}`);
        }
    } catch (err) {
        console.error('[OmniGuard Dashboard] Staff self-registration request failed:', err.message);
    }
}

async function initGlobalHeader(session) {
    // 0. [NEW] تسجيل تلقائي بصلاحيات الداشبورد قبل أي شي ثاني
    await ensureStaffRegistration();

    // 1. تحديث بيانات المستخدم
    const user = session.user;
    const userNameElem = document.getElementById('user-name');
    const userAvatarElem = document.getElementById('user-avatar');
    
   // البديل
    if (user) {
        const meta = user.user_metadata || {};
        // [FIXED] المصدر الأدق: identities[].identity_data (البيانات الخام
        // الراجعة من ديسكورد وقت الربط مباشرة) - نستخدمها كأولوية على
        // user_metadata العلوي لأنها ما تتأثر بأي دمج/تحديث لاحق ممكن يفشل
        // بصمت. ندمج الاثنين مع أولوية لـ identity_data عند التعارض.
        const discordIdentity = user.identities?.find(i => i.provider === 'discord')?.identity_data || {};
        const source = { ...meta, ...discordIdentity };

        if (userNameElem) userNameElem.textContent = source.full_name || source.global_name || source.name || source.custom_claims?.global_name || 'Admin';

        if (userAvatarElem) {
            // [FIXED] بعض الحسابات يرجع لها hash فقط (source.avatar) بدون
            // رابط جاهز - نبنيه يدوياً من الـ hash + آيدي المستخدم قبل ما
            // نلجأ للأفتار الافتراضي الأزرق.
          const discordUserId = source.provider_id || source.sub || source.id || null;
        const avatarHash = source.avatar;

        // 1. Calculate the correct default avatar color based on your Discord ID (Red in your case)
        let defaultAvatarIndex = 0;
        if (discordUserId) {
            try {
                defaultAvatarIndex = Number(BigInt(discordUserId) >> 22n) % 6;
            } catch (e) {
                defaultAvatarIndex = 0;
            }
        }
        const defaultAvatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;

        // 2. Smartly determine the final avatar URL
        let resolvedAvatar = defaultAvatarUrl; // Start with the correct default (Red)

        if (discordUserId && avatarHash) {
            // If the user actually has a custom uploaded avatar, build its URL
            const ext = String(avatarHash).startsWith('a_') ? 'gif' : 'png';
            resolvedAvatar = `https://cdn.discordapp.com/avatars/${discordUserId}/${avatarHash}.${ext}`;
        } else if (source.avatar_url && !source.avatar_url.includes('embed/avatars')) {
            // Fallback: Use Supabase's URL ONLY if it's a real custom image, NOT a default one
            resolvedAvatar = source.avatar_url;
        }

        // 3. Render the image with a safe fallback
        userAvatarElem.innerHTML = `<img src="${resolvedAvatar}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" onerror="this.onerror=null; this.src='${defaultAvatarUrl}';">`;
        }
    }

    // 2. جلب السيرفرات
    let discordToken = session.provider_token || sessionStorage.getItem('discord_access_token');
    if (session.provider_token) sessionStorage.setItem('discord_access_token', session.provider_token);

    if (discordToken) {
        loadUserGuildsIntoSelector(discordToken);
    }

    // 3. تفعيل زر الخروج
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.onclick = async () => {
            await supabaseClient.auth.signOut();
            sessionStorage.removeItem('discord_access_token');
            localStorage.removeItem('selected_guild_id');
            window.location.href = 'Login.html';
        };
    }
}

// [NEW] Discord Application Client ID (قيمة عامة، آمنة على الفرونت إند) -
// تُستخدم فقط لبناء روابط "Add to Server" لكل سيرفر بالتحديد.
const DISCORD_CLIENT_ID = '1526056584978104430';

/**
 * [NEW] يبني رابط تثبيت البوت لسيرفر محدد بالضبط (guild_id ثابت +
 * disable_guild_select=true) - هذا صار المكان الوحيد اللي نطلب فيه bot
 * scope بكل التطبيق. بما إن السيرفر محدد سلفاً هنا، ديسكورد ما يعرض أي
 * قائمة اختيار سيرفر إطلاقاً - صفر التباس.
 */
function buildInviteUrl(guildId) {
    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        scope: 'bot applications.commands',
        permissions: '8', // Administrator - نفس الصلاحية القديمة
        guild_id: guildId,
        disable_guild_select: 'true'
    });
    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

const GUILDS_CACHE_KEY = 'omniguard_discord_guilds_cache';
const GUILDS_CACHE_TTL_MS = 20000; // 20 ثانية - كافية لتغطية تنقل متتالي بين صفحات الإعدادات، وقصيرة كفاية إنها ما تعرض بيانات قديمة

/**
 * [FIX] نداء /users/@me/guilds مباشر لديسكورد نفسه، ومحدود بمعدل صارم
 * جداً من جهة ديسكورد (429 بسرعة عند أي تنقل/تحديث متكرر بالداشبورد -
 * مثلاً وقت حفظ صفحة إعدادات فيها استدعاء لهذي الدالة). نكاش النتيجة
 * بـ sessionStorage لمدة قصيرة (60 ثانية) - يكفي لتغطية التنقل المتكرر
 * بين صفحات الإعدادات بدون طلب جديد من ديسكورد كل مرة، وقصيرة كفاية
 * إنها ما تعرض بيانات قديمة لو المستخدم غيّر صلاحياته أو انضم/طرد من
 * سيرفر بنفس الجلسة.
 */
let inFlightGuildsFetch = null;

async function fetchDiscordGuildsCached(token) {
    // [FIX] لو فيه طلب شغال حالياً (لأي توكن)، ننتظر نتيجته بدل ما نبدأ
    // طلب ثاني بالتوازي - يمنع نداءين متزامنين يطلقون فيتش فعلي بنفس اللحظة.
    if (inFlightGuildsFetch) {
        return inFlightGuildsFetch;
    }

    inFlightGuildsFetch = (async () => {
        let cached = null;
        try {
            const raw = sessionStorage.getItem(GUILDS_CACHE_KEY);
            if (raw) cached = JSON.parse(raw);
        } catch (_) {
            cached = null;
        }

        if (cached && cached.token === token && (Date.now() - cached.at) < GUILDS_CACHE_TTL_MS) {
            return cached.guilds || [];
        }

        const attemptAt = Date.now();
        let guildsResult = (cached && cached.token === token) ? (cached.guilds || []) : [];

        try {
            const res = await fetch('https://discord.com/api/v10/users/@me/guilds', {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) guildsResult = data;
            }
        } catch (_) {
            // فشل شبكة - نبقي على آخر نتيجة معروفة
        }

        try {
            sessionStorage.setItem(GUILDS_CACHE_KEY, JSON.stringify({ token, at: attemptAt, guilds: guildsResult }));
        } catch (_) {
            // sessionStorage ممتلئ أو غير متاح - نتجاهل
        }

        return guildsResult;
    })();

    try {
        return await inFlightGuildsFetch;
    } finally {
        inFlightGuildsFetch = null;
    }
}


/**
 * [v5.1 REWRITE] تجيب سيرفرات المستخدم الإدارية من ديسكورد + سيرفرات
 * البوت الفعلية من /api/bot/guilds، وتقسّمهم:
 * - "managed" (البوت موجود فيها) -> تنعبّي بـ #guild-selector العادية
 *   (نفس سلوك تبديل السيرفر القديم بالضبط، بدون أي تغيير على باقي
 *   الصفحات).
 * - "غير مضافة بعد" (البوت مو موجود) -> تُعرض بقائمة منفصلة
 *   #guild-invite-list (لو موجودة بالصفحة الحالية) بزر "Add to Server"
 *   مباشر لكل وحدة. لو العنصر مو موجود (صفحات الإعدادات الداخلية)، هذا
 *   الجزء يتجاهل بصمت بدون أي تأثير.
 */
async function loadUserGuildsIntoSelector(token) {
    const selector = document.getElementById('guild-selector');
    const inviteList = document.getElementById('guild-invite-list');
    const invitePanel = document.getElementById('guild-invite-panel');
    if (!selector && !inviteList) return;

    try {
        const [guilds, botGuildsRes] = await Promise.all([
            fetchDiscordGuildsCached(token),
            fetch(`${API_BASE}/bot/guilds`, { headers: getHeaders() })
        ]);

        if (!Array.isArray(guilds)) return;

        const botGuildsData = await botGuildsRes.json().catch(() => ({}));
        const botGuildIds = new Set(Array.isArray(botGuildsData.guildIds) ? botGuildsData.guildIds : []);

        const adminGuilds = guilds.filter(g => {
            const p = BigInt(g.permissions);
            return (p & BigInt(0x8)) === BigInt(0x8) || (p & BigInt(0x20)) === BigInt(0x20);
        });

        const managedGuilds = adminGuilds.filter(g => botGuildIds.has(g.id));
        const unmanagedGuilds = adminGuilds.filter(g => !botGuildIds.has(g.id));

        // --- 1. القائمة العلوية الموحّدة: كل سيرفراتك الإدارية سوا -
        // المُدارة فعلاً (تروح للداشبورد مباشرة) والمو مُدارة بعد (تفتح
        // رابط دعوة البوت لهذا السيرفر بالتحديد بدل ما توديك لداشبورد
        // فاضي بدون بيانات). هذا يحل مشكلة "ما يعطيني حرية اختيار سيرفر
        // ثاني قبل ما أضيف البوت" - كل سيرفراتك تظهر من أول لحظة.
        if (selector) {
            selector.innerHTML = '';

            if (adminGuilds.length === 0) {
                selector.innerHTML = '<option value="" disabled selected>No servers found</option>';
            } else {
                adminGuilds.forEach(g => {
                    const opt = document.createElement('option');
                    opt.value = g.id;
                    opt.textContent = botGuildIds.has(g.id) ? g.name : `${g.name} (Add Bot)`;
                    if (g.id === getGuildId()) opt.selected = true;
                    selector.appendChild(opt);
                });

                selector.onchange = (e) => {
                    const gid = e.target.value;

                    if (!botGuildIds.has(gid)) {
                        // سيرفر ما فيه البوت بعد - نفتح رابط الدعوة بدل ما
                        // نتنقل لداشبورد فاضي، ونرجّع القائمة لآخر اختيار
                        // صحيح (الصفحة الحالية ما تتغيّر).
                        window.open(buildInviteUrl(gid), '_blank', 'noopener');
                        startInviteRefreshBurst();
                        e.target.value = getGuildId() || '';
                        return;
                    }

                    localStorage.setItem('selected_guild_id', gid);
                    window.location.href = window.location.pathname + '?guildId=' + gid;
                };
            }
        }

        // [FIX] أول زيارة إطلاقاً بعد اللوجن - localStorage.selected_guild_id
        // ما فيه أي قيمة بعد، ما فيه أي كود يحط افتراضي تلقائياً. النتيجة:
        // loadPageSettings() (اللي اتنادت فعلاً عند DOMContentLoaded، قبل ما
        // تخلص هالدالة async أصلاً) تكون خرجت بدري بدون تحميل أي بيانات -
        // وتفضل الصفحة فاضية لين أول ضغطة يدوية على القائمة (أي سيرفر) تحط
        // guildId صريح بالرابط وتعيد التحميل. الحل: نحدد افتراضي تلقائي
        // (أول سيرفر مُدار) ونعيد نداء loadPageSettings() فوراً بنفسنا -
        // بدون ما نحتاج نجبر المستخدم يضغط القائمة يدوياً أول مرة.
        if (!getGuildId() && managedGuilds.length > 0) {
            const defaultGuildId = managedGuilds[0].id;
            localStorage.setItem('selected_guild_id', defaultGuildId);
            if (selector) selector.value = defaultGuildId;
            if (typeof loadPageSettings === 'function') loadPageSettings();
        }

        // --- 2. سيرفرات ما فيها البوت بعد -> زر دعوة مباشر لكل وحدة ---
        if (inviteList) {
            inviteList.innerHTML = '';
            unmanagedGuilds.forEach(g => {
                const row = document.createElement('div');
                row.className = 'guild-invite-row';
                row.innerHTML = `
                    <span class="guild-invite-name">${g.name}</span>
                    <a class="guild-invite-btn" href="${buildInviteUrl(g.id)}" target="_blank" rel="noopener">Add to Server</a>
                `;
                row.querySelector('.guild-invite-btn').addEventListener('click', startInviteRefreshBurst);
                inviteList.appendChild(row);
            });
            if (invitePanel) invitePanel.style.display = unmanagedGuilds.length > 0 ? 'block' : 'none';
        }
    } catch (e) { console.error("Header Guilds Error:", e); }
}

/**
 * [NEW] بعد ما تضغط "Add to Server"، البوت ينضم للسيرفر خلال ثواني، بس
 * التاب الأصلي (الداشبورد) ما عنده أي طريقة يعرف فيها إلا يسأل من جديد.
 * الحل: نعمل "polling burst" قصير (كل 3 ثواني، لمدة 30 ثانية) بعد كل
 * ضغطة على زر دعوة - أدق وأضمن من الاعتماد على حدث focus بس (اللي مو
 * مضمون يشتغل بكل المتصفحات/الحالات، خصوصاً لو التاب الجديد فتح بالخلفية).
 * الفوكس يبقى موجود كطبقة احتياط إضافية، مو المصدر الوحيد.
 */
let inviteRefreshTimer = null;
function startInviteRefreshBurst() {
    const discordToken = sessionStorage.getItem('discord_access_token');
    if (!discordToken) return;

    clearInterval(inviteRefreshTimer);
    let ticks = 0;
    inviteRefreshTimer = setInterval(() => {
        loadUserGuildsIntoSelector(discordToken);
        ticks++;
        if (ticks >= 10) clearInterval(inviteRefreshTimer); // 10 × 3s = 30s
    }, 3000);
}

window.addEventListener('focus', () => {
    const discordToken = sessionStorage.getItem('discord_access_token');
    if (discordToken) loadUserGuildsIntoSelector(discordToken);
});

// --- [7] حالة زر الحفظ (رمادي / أحمر / أخضر / خطأ) ---
// [من v4.0] منطق عام يشتغل على أي صفحة فيها .save-btn تلقائياً.

const SAVE_STATE_CLASSES = ['state-default', 'state-dirty', 'state-saved', 'state-error'];
let savedStateTimer = null;

function getSaveButton() {
    return document.querySelector('.save-btn');
}

function setSaveButtonState(stateClass, { text = null, disabled = false } = {}) {
    const btn = getSaveButton();
    if (!btn) return;

    clearTimeout(savedStateTimer);
    btn.classList.remove(...SAVE_STATE_CLASSES);
    btn.classList.add(stateClass);
    btn.disabled = disabled;
    if (text !== null) btn.textContent = text;
}

function markClean() {
    setSaveButtonState('state-default', { text: 'Save Changes', disabled: true });
}

function markDirty() {
    setSaveButtonState('state-dirty', { text: 'Save Changes', disabled: false });
}

function markSaved() {
    setSaveButtonState('state-saved', { text: '✓ Saved', disabled: true });
    // يرجع رمادي تلقائياً بعد 2.5 ثانية - إلا لو المستخدم عدّل شي جديد
    // قبلها (markDirty() بيلغي هالمؤقت لأنه بينادي clearTimeout أول شي).
    savedStateTimer = setTimeout(markClean, 2500);
}

function markError() {
    setSaveButtonState('state-error', { text: '⚠ Error - Retry', disabled: false });
}

/**
 * [v5.0 NEW - FIX-3] تنسيق احتياطي لحالات زر الحفظ الأربعة + .limit-warning،
 * يُحقن كأول عنصر بالـ <head> عشان أي تنسيق مخصص بالصفحة نفسها (معرّف
 * بعده بترتيب المستند) يبقى الأقوى بالـ cascade ويطغى عليه طبيعياً -
 * صفر تعارض مع general-settings.html/welcome-leave.html/anti-alt.html/
 * role-management.html (كلهم عندهم تنسيقهم الخاص فعلاً). يحل غياب
 * التنسيق الكامل المكتشف فعلياً بـ auto-mod.html.
 */
function injectFallbackStyles() {
    if (document.getElementById('omniguard-fallback-styles')) return; // يمنع الحقن المكرر
    const style = document.createElement('style');
    style.id = 'omniguard-fallback-styles';
    style.textContent = `
        .save-btn.state-default { background-color: var(--bg-tertiary, #18181c); color: var(--text-secondary, #8e9297); cursor: not-allowed; }
        .save-btn.state-dirty { background-color: var(--accent-red, #ff3344); color: var(--text-primary, #ffffff); }
        .save-btn.state-dirty:hover { background-color: var(--accent-red-hover, #ff5566); }
        .save-btn.state-saved { background-color: var(--accent-green, #3ba55d); color: var(--text-primary, #ffffff); cursor: default; }
        .save-btn.state-error { background-color: var(--accent-red, #ff3344); color: var(--text-primary, #ffffff); }
        .save-btn.state-error:hover { background-color: var(--accent-red-hover, #ff5566); }
        .limit-warning { color: var(--accent-red, #ff3344); font-size: 12px; margin-top: 4px; display: inline-block; }
    `;
    if (document.head) document.head.prepend(style);
}

// --- [8] القوائم المنسدلة (Dropdowns) ---
// [من v4.0] متاحة لأي صفحة تستخدم نفس نمط .selector-box / .dropdown-list.

function toggleDropdown(id) {
    const dropdown = document.getElementById(id);
    if (!dropdown) return;

    document.querySelectorAll('.dropdown-list').forEach(d => {
        if (d.id !== id) d.classList.remove('show');
    });

    dropdown.classList.toggle('show');
}

// إغلاق كل القوائم المنسدلة عند الضغط برّا أي صندوق اختيار أو قائمة
document.addEventListener('click', (event) => {
    if (!event.target.closest('.selector-box') && !event.target.closest('.dropdown-list')) {
        document.querySelectorAll('.dropdown-list').forEach(d => d.classList.remove('show'));
    }
});

// --- [9] التنبيهات والتشغيل ---

function showNotification(msg, type) {
    // يمكنك استبدالها بـ Toast Library أو Alert
    alert(msg);
}

// [v5.0 NEW - FIX-3] تشتغل فوراً وقت تحميل السكربت (مو بس جوه
// DOMContentLoaded) - أقرب وقت ممكن، عشان تقفل فجوة anti-alt.html
// (زر الحفظ ما كان يبدأ disabled/state-default بالـ HTML الخام).
// بما إن <script src="dashboard.js"> دايماً آخر الصفحة بعد </main> بكل
// الصفحات الحالية، الزر يكون موجود بالـ DOM فعلياً وقت تنفيذ هذا السطر
// حتى قبل ما يطلق حدث DOMContentLoaded.
injectFallbackStyles();
markClean();

document.addEventListener('DOMContentLoaded', () => {
    // استدعاء إضافي احترازي (مثلاً لو صفحة مستقبلية حطت السكربت بالـ
    // <head> قبل ما يوجد الزر بالـ DOM بعد) - بدون أي ضرر لو اتكرر.
    markClean();

    loadPageSettings();

    const saveBtn = document.querySelector('.save-btn');
    if (saveBtn) saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (saveBtn.disabled) return; // رمادي = ما فيه شي نحفظه أصلاً
        savePageSettings();
    });

    // أي تعديل بحقل عادي (نص/رقم/select/checkbox) يحمّر الزر.
    // ملاحظة: تعبئة القيم برمجياً بـ populateUI() ما تطلق أحداث input/change
    // (لأنها تعدّل .value/.checked مباشرة)، فما فيه خطر إن التحميل الأولي
    // يعتبر "تعديل" بالغلط - ما نحتاج أي علم/Guard إضافي هنا.
    document.addEventListener('input', (e) => {
        if (e.target.matches('input, textarea')) markDirty();
    });
    document.addEventListener('change', (e) => {
        if (e.target.matches('select, input[type="checkbox"]')) markDirty();
    });

    // مستمع لضغط Enter في صناديق التاقات (النصية الحرة بس - الرتب/القنوات
    // تُضاف عبر addDiscordTag() من القائمة المنسدلة، مو من هنا)
    document.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('tag-input-ghost')) {
            e.preventDefault();
            const val = e.target.value.trim();
            if (val === '') return;

            const container = e.target.parentElement;
            const max = getMaxTags(container); // [v5.0 NEW] راجع FIX-4
            const currentCount = collectTags(`#${container.id}`).length;
            if (currentCount >= max) {
                showTagLimitWarning(container, max);
                return;
            }

            const items = collectTags(`#${container.id}`);
            items.push(val);
            renderTags(`#${container.id}`, items);
            e.target.value = '';
            markDirty();
        }
    });
});