// ============================================================================
// commands/autoRespond.js — Auto Respond Engine (v1.0)
// ============================================================================
// [NEW] المحرك الفعلي اللي يستمع لكل رسالة بالسيرفر، يطابقها مع قواعد
// auto_respond_rules (المُدارة من الداشبورد AutoRespond.html)، ويرد لو
// فيه تطابق. نفس نمط ticketAutomation.js بالحرف: دالة واحدة تصدّر
// (client) => {...} وتسجّل client.on('messageCreate', ...) داخلها،
// لازم تُستدعى بـ index.js قبل client.login() (نفس سبب باقي الموديولات
// المشابهة - راجع التعليقات جنب استدعاءاتها بـ index.js).
//
// ⚠️ هذا ملف مستقل تماماً عن auto_mod (كشف الكلمات السيئة) وعن
// ticketAutomation (رد داخل التذاكر بس) - listener منفصل بالكامل.
//
// القرارات المتفق عليها مع المستخدم (راجع المحادثة):
// - Cache بالذاكرة للقواعد لكل سيرفر (TTL ~45 ثانية) بدل استعلام SQL
//   مع كل رسالة.
// - Fuzzy Match عبر مكتبة fast-levenshtein (لازم: npm install fast-levenshtein).
// - Cooldown لكل مستخدم بالذاكرة فقط (Map بسيط - يصفّر لو البوت أعاد
//   التشغيل، مقبول لكولداون قصير).
// - Whitelist (لو فيها عناصر) تتجاوز الـ Blacklist بالكامل لنفس النوع
//   (قنوات/رتب) - "بس هالعناصر مسموحة". لو Whitelist فاضية، كل شي
//   مسموح إلا الموجود بالـ Blacklist. (نفس المنطق المكتوب بتعليق
//   schema_delta_auto_respond.sql بالضبط).
// - لو أكثر من قاعدة تطابق نفس الرسالة، بس أول قاعدة مطابقة (بترتيب
//   الإنشاء) هي اللي ترد - يمنع رد مزدوج/سبام لنفس الرسالة.
// ============================================================================

const path = require('path');
const levenshtein = require('fast-levenshtein');
const dbUtils = require(path.join(__dirname, '..', 'supabase', 'dbUtils'));

const RULES_CACHE_TTL_MS = 45 * 1000;          // 45 ثانية - بين النطاق المتفق عليه (30-60)
const FUZZY_MAX_DISTANCE_RATIO = 0.25;         // نسبة المسافة المسموحة من طول trigger_keyword

// guildId -> { rules: Array, expiresAt: number }
const rulesCache = new Map();

// `${ruleId}:${userId}` -> timestamp (ms) آخر رد فعلي أُرسل
const cooldownMap = new Map();

/**
 * يرجّع قواعد سيرفر معيّن - من الكاش لو لسه صالح، أو يستعلم Supabase
 * ويحدّث الكاش. لو الاستعلام فشل (مشكلة شبكة/قاعدة)، يرجّع آخر نسخة
 * محفوظة بالكاش (لو موجودة) بدل ما يفشل بصمت ويوقف الميزة كاملة.
 */
async function getGuildRules(guildId) {
    const cached = rulesCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.rules;
    }

    let rules;
    try {
        rules = await dbUtils.getAutoRespondRules(guildId);
    } catch (err) {
        console.error(`[AutoRespond] Failed to fetch rules for guild ${guildId}:`, err.message);
        return cached ? cached.rules : [];
    }

    rulesCache.set(guildId, { rules, expiresAt: Date.now() + RULES_CACHE_TTL_MS });
    return rules;
}

/**
 * Fuzzy Match: يفحص الرسالة كاملة (لعبارات متعددة الكلمات) وكل كلمة
 * فيها لحالها (لكشف كلمة مفردة مكتوبة غلط داخل جملة أطول) عبر Levenshtein
 * Distance. الحد المسموح = 25% من طول الكلمة المفتاحية (بحد أدنى حرف
 * واحد)، يعني كل ما الكلمة أطول كل ما سمحنا بأخطاء أكثر.
 */
function isFuzzyMatch(content, keyword) {
    const normalizedKeyword = keyword.toLowerCase();
    const maxDistance = Math.max(1, Math.round(normalizedKeyword.length * FUZZY_MAX_DISTANCE_RATIO));

    if (levenshtein.get(content.toLowerCase(), normalizedKeyword) <= maxDistance) {
        return true;
    }

    const words = content.toLowerCase().split(/\s+/).filter(Boolean);
    return words.some(word => levenshtein.get(word, normalizedKeyword) <= maxDistance);
}

/**
 * يفحص تطابق قاعدة واحدة مع محتوى رسالة، حسب match_type المختار.
 */
function matchesRule(rule, rawContent) {
    const content = (rawContent || '').trim();
    const keyword = (rule.trigger_keyword || '').trim();
    if (!content || !keyword) return false;

    const lowerContent = content.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();

    switch (rule.match_type) {
        case 'exact':
            return lowerContent === lowerKeyword;

        case 'contains':
            return lowerContent.includes(lowerKeyword);

        case 'starts':
            return lowerContent.startsWith(lowerKeyword);

        case 'ends':
            return lowerContent.endsWith(lowerKeyword);

        case 'regex':
            try {
                return new RegExp(keyword, 'i').test(content);
            } catch (err) {
                // نمط Regex غير صالح (المفروض ما يوصل هنا أصلاً - الداشبورد
                // يتحقق منه قبل الحفظ، بس دفاعياً لو دخل نمط كسور بأي طريقة)
                console.error(`[AutoRespond] Invalid regex pattern in rule ${rule.id}:`, err.message);
                return false;
            }

        case 'fuzzy':
            return isFuzzyMatch(lowerContent, lowerKeyword);

        default:
            return false;
    }
}

/**
 * منطق الوايت/بلاك لست الصحيح (تم تصحيحه):
 * - أي عنصر موجود بالـ Whitelist صراحةً => مسموح (حتى لو نفس العنصر
 *   موجود بالـ Blacklist بالغلط - الـ Whitelist لها الأولوية).
 * - أي عنصر موجود بالـ Blacklist (وما كان بالـ Whitelist) => ممنوع.
 * - أي عنصر مو موجود بأي من القائمتين => مسموح افتراضياً.
 * (سابقاً كان لو الـ Whitelist فيها أي عنصر، يصير بس عناصر الـ
 * Whitelist مسموحة وكل شي ثاني يُمنع - هذا كان غلط، تم تصحيحه هنا).
 */
function isAllowedByLists(whitelist, blacklist, candidateIds) {
    const wl = whitelist || [];
    const bl = blacklist || [];

    if (wl.length > 0 && candidateIds.some(id => wl.includes(id))) {
        return true;
    }
    if (bl.length > 0 && candidateIds.some(id => bl.includes(id))) {
        return false;
    }
    return true;
}

function isOnCooldown(rule, userId) {
    if (!rule.cooldown_seconds || rule.cooldown_seconds <= 0) return false;

    const lastSentAt = cooldownMap.get(`${rule.id}:${userId}`);
    if (!lastSentAt) return false;

    return (Date.now() - lastSentAt) < (rule.cooldown_seconds * 1000);
}

function markCooldown(rule, userId) {
    if (!rule.cooldown_seconds || rule.cooldown_seconds <= 0) return;
    cooldownMap.set(`${rule.id}:${userId}`, Date.now());
}

module.exports = (client) => {
    client.on('messageCreate', async (message) => {
        // بوتات/Webhooks تُتجاهل، وكذا الرسائل الخاصة (DM - ما فيها guild)
        if (message.author.bot || !message.guild) return;

        try {
            const rules = await getGuildRules(message.guild.id);
            if (!rules || rules.length === 0) return;

            const memberRoleIds = message.member
                ? Array.from(message.member.roles.cache.keys())
                : [];

            for (const rule of rules) {
                if (!rule.enabled) continue;

                if (!isAllowedByLists(rule.channel_whitelist, rule.channel_blacklist, [message.channel.id])) continue;
                if (!isAllowedByLists(rule.role_whitelist, rule.role_blacklist, memberRoleIds)) continue;
                if (!matchesRule(rule, message.content)) continue;
                if (isOnCooldown(rule, message.author.id)) continue;

                if (rule.response_message) {
                    await message.reply({
                        content: rule.response_message,
                        allowedMentions: { repliedUser: false }
                    }).catch(err => {
                        console.error(`[AutoRespond] Failed to send reply for rule ${rule.id}:`, err.message);
                    });
                }

                markCooldown(rule, message.author.id);
                break; // بس أول قاعدة مطابقة - يمنع رد مزدوج لنفس الرسالة
            }
        } catch (err) {
            console.error('[AutoRespond] Unexpected error while processing message:', err.message);
        }
    });

    console.log('[OmniGuard] Auto Respond Engine: INITIALIZED');
};