// ============================================================================
// Aliases.js - Per-Guild Command Alias Cache & Resolver (Dashboard Page:
// commands.html)
// ============================================================================
// هذا الملف مسؤول عن الأسماء البديلة (aliases) اللي يضيفها كل مشرف لكل
// أمر شات، خاصة بكل سيرفر لحاله (Per-Guild Isolation - راجع تنويه المطور:
// "لو سيرفر أ اختار كلمة X لأمر معيّن، ما فيه أي تأثير على سيرفر ب").
//
// ⚠️ هذا ليس ملف أمر شات (Chat Command) - لا يُصدّر run()/name() بنمط
// ban.js/kick.js. يجب استثناؤه بالاسم من commandhandler.js (نفس أسلوب
// استثناء GRS.js/AutoMod.js حالياً) - راجع EXCLUDED_FILES هناك.
//
// [التصميم] لماذا الكاش هنا يعتمد على commands Collection الحيّة من
// commandhandler.js بدل قائمة أسماء مكتوبة يدوياً:
//     المطور نبّه إن اسم الملف قد لا يطابق اسم الأمر الفعلي بالشات (مثال:
//     checkpermissions قد لا يكون اسم الملف). المصدر الوحيد المضمون 100%
//     لـ "ما هي كل الأسماء المحجوزة فعلياً؟" هو نفس الـ Collection اللي
//     commandhandler.js يبنيها وقت الإقلاع من الملفات الحقيقية + أي
//     aliases ثابتة مُصدَّرة منها (module.exports.aliases). فبدل ما نخمّن
//     قائمة يدوية هنا ممكن تنسى تتحدث لو انضاف/انحذف أمر مستقبلاً،
//     isReservedName() تسأل commandhandler.js مباشرة (Lazy require -
//     راجع الشرح تحت).
//
// [Circular Dependency] commandhandler.js يستدعي هذا الملف (Lazy، جوا
// handleMessage() بس، مو بأعلى الملف) عشان يحوّل alias مكتوب لاسم الأمر
// الرسمي. وهذا الملف بدوره يحتاج يقرأ commands Collection من
// commandhandler.js. لتفادي أي مشكلة ترتيب تحميل (Circular Require)،
// الاستدعاءين الاثنين Lazy (جوا الدوال، مو بأعلى الملفين) - نفس نمط
// require('../index') المستخدم بكل apiRouter.js تقريباً.
//
// طريقة الاستخدام (تُستدعى مرة وحدة فقط وقت الإقلاع، من index.js/client.js -
// نفس نمط GRS.setupNicknameGuard بالضبط):
//     const { initAliasCache } = require('./commands/Aliases');
//     initAliasCache(client);
// ============================================================================

// [متفق عليه مع المطور] الحد الأقصى لعدد aliases لكل أمر بكل سيرفر - يمنع
// إغراق قاعدة البيانات والرام بأي إساءة استخدام.
const MAX_ALIASES_PER_COMMAND = 10;

// أقصى طول مسموح للـ alias الواحد (كلمة وحدة بدون مسافات - راجع
// validateAliasFormat تحت).
const MAX_ALIAS_LENGTH = 32;

// نفس الرجيكس المستخدمة بواجهة commands.html بالضبط (تمنع رموز البريفكس
// زي !@#$...) - مكررة هنا عمداً: الباك إند ما يجوز يثق بأي فلترة صارت
// بالفرونت إند، فلازم يفحصها لحاله من الصفر.
const PREFIX_SYMBOL_REGEX = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/;

// الكاش الفعلي بالرام: Map<guildId, Map<aliasLower, canonicalCommandName>>
const guildAliasCache = new Map();

/**
 * يرجّع الـ Collection الحيّة للأوامر المسجّلة فعلياً بـ commandhandler.js
 * (أسماء الأوامر الرئيسية + أي alias ثابت بالكود مُصدَّر من ملفات الأوامر
 * نفسها). Lazy require - راجع شرح Circular Dependency بأعلى الملف.
 */
function getRegisteredCommands() {
    const { commands } = require('./commandhandler');
    return commands;
}

/**
 * هل هذا الاسم محجوز فعلياً (أمر رئيسي أو alias ثابت بالكود)؟ يُستخدم
 * لغرضين بالضبط:
 *   1) بـ apiRouter.js: التأكد إن :commandName بالمسار أمر حقيقي موجود.
 *   2) بـ apiRouter.js أيضاً: منع المشرف من إضافة alias يطابق اسم محجوز
 *      (طلب المطور صراحة: رفض كامل، مو استبدال/override).
 */
function isReservedName(word) {
    if (!word) return false;
    return getRegisteredCommands().has(String(word).toLowerCase());
}

/**
 * توحيد شكل الـ alias قبل أي تخزين/مقارنة - lowercase دائماً (نفس
 * commandName بـ commandhandler.js اللي يُقارن بعد .toLowerCase() هو
 * كمان)، عشان المطابقة وقت التنفيذ الفعلي بالشات تكون متسقة دائماً.
 */
function normalizeAlias(rawAlias) {
    return String(rawAlias || '').trim().toLowerCase();
}

/**
 * فحص شكل الـ alias المُدخل - مستقل تماماً عن أي فحص بالفرونت إند:
 *   - بدون مسافات إطلاقاً (تاق واحد = كلمة واحدة، طلب صريح من المطور)
 *   - بدون رموز بريفكس
 *   - طول بين 1 و MAX_ALIAS_LENGTH حرف
 * يرجّع نص خطأ (string) لو فيه مشكلة، أو null لو سليم شكلياً. ⚠️ هذا
 * فحص الشكل فقط - فحص "محجوز أو لأ" (isReservedName) وفحص التكرار داخل
 * السيرفر منفصلين، ويصيرون بمكان الاستدعاء (apiRouter.js).
 */
function validateAliasFormat(rawAlias) {
    const alias = String(rawAlias || '').trim();
    if (!alias) return 'Alias cannot be empty.';
    if (/\s/.test(alias)) return 'Alias cannot contain spaces.';
    if (PREFIX_SYMBOL_REGEX.test(alias)) return 'Alias cannot contain prefix or special characters.';
    if (alias.length > MAX_ALIAS_LENGTH) return `Alias cannot be longer than ${MAX_ALIAS_LENGTH} characters.`;
    return null;
}

/**
 * يبني كاش سيرفر وحد من الصفر من صفوف قاعدة بيانات جاهزة (بديل كامل -
 * يمسح أي كاش قديم لهذا السيرفر بالذات ويحط الجديد). Helper مشتركة بين
 * initAliasCache (كل السيرفرات وقت الإقلاع) و refreshGuildAliasCache
 * (سيرفر وحد بعد كل حفظ فوري).
 */
function setGuildAliasCache(guildId, rows) {
    const map = new Map();
    for (const row of rows) {
        map.set(normalizeAlias(row.alias), row.command_name);
    }
    guildAliasCache.set(guildId, map);
}

/**
 * تحميل كل الـ aliases لكل السيرفرات دفعة وحدة وقت إقلاع البوت - تُستدعى
 * مرة وحدة بس من index.js/client.js (راجع شرح الاستخدام بأعلى الملف).
 * @param {import('discord.js').Client} client
 */
function initAliasCache(client) {
    client.once('ready', async () => {
        try {
            console.log('[Aliases] Loading per-guild command aliases into memory...');
            const queries = require('../supabase/databaseQueries');
            const allRows = await queries.getAllCommandAliases();

            guildAliasCache.clear();
            for (const row of allRows) {
                if (!guildAliasCache.has(row.id_guild)) {
                    guildAliasCache.set(row.id_guild, new Map());
                }
                guildAliasCache.get(row.id_guild).set(normalizeAlias(row.alias), row.command_name);
            }
            console.log(`[Aliases] Loaded aliases for ${guildAliasCache.size} guild(s).`);
        } catch (err) {
            console.error('[Aliases Error] Failed to load alias cache on boot:', err.message);
        }
    });
}

/**
 * إعادة تحميل كاش سيرفر وحد بس من القاعدة - تُستدعى فوراً بعد أي PUT
 * ناجح على /guild/:guildId/command-aliases/:commandName بـ apiRouter.js.
 * نفس فلسفة GRS.enforceNickname الفورية بالضبط: الكاش ما ينتظر إعادة
 * تشغيل البوت عشان يعكس تعديل المشرف بالداشبورد.
 * @param {string} guildId
 */
async function refreshGuildAliasCache(guildId) {
    try {
        const queries = require('../supabase/databaseQueries');
        const rows = await queries.getCommandAliases(guildId);
        setGuildAliasCache(guildId, rows);
    } catch (err) {
        console.error(`[Aliases Error] refreshGuildAliasCache failed for guild ${guildId}:`, err.message);
    }
}

/**
 * الاستعلام الفعلي وقت كل رسالة شات (commandhandler.js): هل هالكلمة
 * alias مسجّلة لهذا السيرفر بالذات؟ يرجّع اسم الأمر الرسمي (canonical)
 * أو null. قراءة Map بحتة - صفر استعلام قاعدة بيانات، آمن يُستدعى على
 * كل رسالة بدون أي تأثير على الأداء.
 * @param {string} guildId
 * @param {string} typedWord - أول كلمة بالرسالة (بعد إزالة البريفكس)
 */
function resolveAlias(guildId, typedWord) {
    const guildMap = guildAliasCache.get(guildId);
    if (!guildMap) return null;
    return guildMap.get(normalizeAlias(typedWord)) || null;
}

module.exports = {
    MAX_ALIASES_PER_COMMAND,
    MAX_ALIAS_LENGTH,
    initAliasCache,
    refreshGuildAliasCache,
    resolveAlias,
    isReservedName,
    validateAliasFormat,
    normalizeAlias
};