// ============================================================================
// commands/Level.js — Leveling System Engine (v1.0)
// ============================================================================
// [NEW] المحرك الفعلي لنظام الليفلينج - يستمع لكل رسالة، يحسب XP (مع
// الكولداون والمضاعفات والقيود)، ويكتشف الترقية ويرسل إشعار. نفس نمط
// ticketAutomation.js / commands/autoRespond.js بالحرف: يصدّر
// (client) => {...} ويسجّل client.on('messageCreate', ...) داخلها.
//
// القرارات المتفق عليها/المفترضة (راجع المحادثة):
// - Cache بالذاكرة لإعدادات كل سيرفر (TTL 45 ثانية - نفس autoRespond.js
//   بالضبط، بدل استعلام SQL مع كل رسالة).
// - Cooldown لكل مستخدم بالذاكرة فقط (Map بسيط).
// - مدى XP لكل رسالة (Min/Max) قابل للتعديل بالكامل من الداشبورد
//   (setting_leveling.xp_min / xp_max) - مو مثبّت بالكود.
// - Role XP Multipliers: لو العضو عنده أكثر من رتبة لها مضاعف، يُطبَّق
//   أعلى مضاعف بس (مو ضرب كل المضاعفات ببعض - يمنع تضخّم غير منطقي).
// - Tiered Ranks: الفئات قابلة للتعديل بالكامل من الداشبورد (جدول
//   tiered_xp_brackets) - fallback احتياطي ثابت بالكود بس لو السيرفر ما
//   ضاف أي فئة لسا (راجع levelingFormulas.js).
// - Whitelist (لو فيها عناصر) تتجاوز الـ Blacklist بالكامل - نفس منطق
//   auto_respond_rules بالضبط.
// - كل حسابات المستوى (level/xp من total_xp) تمر عبر levelingFormulas.js
//   المشترك مع apiRouter.js - يمنع أي تعارض حسابي بين البوت والداشبورد.
// ============================================================================

const path = require('path');
const dbUtils = require(path.join(__dirname, '..', 'supabase', 'dbUtils'));
const { xpForNextLevel, normalizeGrowthSystem } = require(path.join(__dirname, '..', 'supabase', 'levelingFormulas'));

const SETTINGS_CACHE_TTL_MS = 45 * 1000;
const MULTIPLIERS_CACHE_TTL_MS = 45 * 1000;
const TIERED_BRACKETS_CACHE_TTL_MS = 45 * 1000;

// guildId -> { settings, expiresAt }
const settingsCache = new Map();
// guildId -> { multipliers: Array<{id_role, multiplier}>, expiresAt }
const multipliersCache = new Map();
// guildId -> { brackets: Array<{max_level, xp_per_level}>, expiresAt } - تُجلب
// بس لما xp_growth_system === 'tiered' (نفس آلية cache الإعدادات/المضاعفات)
const tieredBracketsCache = new Map();

// `${guildId}:${userId}` -> timestamp (ms) آخر مرة اتحسبت له XP
const cooldownMap = new Map();

const DEFAULT_LEVEL_UP_MESSAGE = 'GG {user}, you just reached **Level {level}**! 🎉';

async function getGuildLevelingSettings(guildId) {
    const cached = settingsCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.settings;

    let settings;
    try {
        settings = await dbUtils.universalGet('setting_leveling', guildId);
    } catch (err) {
        console.error(`[Level] Failed to fetch setting_leveling for guild ${guildId}:`, err.message);
        return cached ? cached.settings : null;
    }

    settingsCache.set(guildId, { settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
    return settings;
}

async function getGuildRoleMultipliers(guildId) {
    const cached = multipliersCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.multipliers;

    let multipliers;
    try {
        multipliers = await dbUtils.getRoleXpMultipliers(guildId);
    } catch (err) {
        console.error(`[Level] Failed to fetch role_xp_multipliers for guild ${guildId}:`, err.message);
        return cached ? cached.multipliers : [];
    }

    multipliersCache.set(guildId, { multipliers, expiresAt: Date.now() + MULTIPLIERS_CACHE_TTL_MS });
    return multipliers;
}

/**
 * فئات Tiered الفعلية للسيرفر - تُجلب/تُكاش بس لما النظام المختار فعلياً
 * tiered (توفير استعلامات لباقي السيرفرات اللي تستخدم أنظمة ثانية).
 */
async function getGuildTieredBrackets(guildId) {
    const cached = tieredBracketsCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.brackets;

    let brackets;
    try {
        brackets = await dbUtils.getTieredBrackets(guildId);
    } catch (err) {
        console.error(`[Level] Failed to fetch tiered_xp_brackets for guild ${guildId}:`, err.message);
        return cached ? cached.brackets : [];
    }

    tieredBracketsCache.set(guildId, { brackets, expiresAt: Date.now() + TIERED_BRACKETS_CACHE_TTL_MS });
    return brackets;
}

/**
 * Whitelist (لو فيها عناصر) تتجاوز الـ Blacklist بالكامل - نفس منطق
 * commands/autoRespond.js isAllowedByLists() بالحرف.
 */
function isChannelAllowed(whitelist, blacklist, channelId) {
    const wl = whitelist || [];
    const bl = blacklist || [];
    if (wl.length > 0) return wl.includes(channelId);
    return !bl.includes(channelId);
}

function isOnCooldown(guildId, userId, cooldownSeconds) {
    if (!cooldownSeconds || cooldownSeconds <= 0) return false;
    const lastAt = cooldownMap.get(`${guildId}:${userId}`);
    if (!lastAt) return false;
    return (Date.now() - lastAt) < (cooldownSeconds * 1000);
}

function markCooldown(guildId, userId) {
    cooldownMap.set(`${guildId}:${userId}`, Date.now());
}

function randomBaseXp(xpMin, xpMax) {
    const min = Number.isInteger(xpMin) && xpMin >= 1 ? xpMin : 15;
    const max = Number.isInteger(xpMax) && xpMax >= min ? xpMax : Math.max(min, 25);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * أعلى مضاعف رتبة عند العضو (مو ضرب الكل ببعض - راجع الشرح بأعلى الملف).
 * يرجع 1 (بدون تأثير) لو ما عنده أي رتبة لها مضاعف.
 */
function getHighestRoleMultiplier(memberRoleIds, guildMultipliers) {
    let highest = 1;
    for (const entry of guildMultipliers) {
        if (memberRoleIds.includes(entry.id_role) && Number(entry.multiplier) > highest) {
            highest = Number(entry.multiplier);
        }
    }
    return highest;
}

/**
 * يبني ويرسل Embed الترقية حسب notify_destination المختار (نفس القناة /
 * خاص / متوقف)، مع منشن اختياري.
 */
async function sendLevelUpNotification({ message, member, settings, newLevel, newXp, totalXp, growthSystem, tieredBrackets }) {
    const destination = settings.notify_destination || 'current';
    if (destination === 'off') return;

    const template = (settings.level_up_message && settings.level_up_message.trim())
        ? settings.level_up_message
        : DEFAULT_LEVEL_UP_MESSAGE;

    const description = template
        .replace(/{user}/g, `<@${member.id}>`)
        .replace(/{level}/g, String(newLevel))
        .replace(/{xp}/g, String(totalXp))
        .replace(/{next_level_xp}/g, String(xpForNextLevel(newLevel, growthSystem, tieredBrackets)));

    const embed = {
        color: 0xff3344, // نفس accent-red الأساسي بالداشبورد - يخلي الهوية البصرية موحدة
        description,
        author: {
            name: member.user.username,
            icon_url: member.displayAvatarURL({ size: 64 })
        },
        footer: { text: `Level ${newLevel} • ${totalXp} Total XP` }
    };

    const mention = settings.mention_on_levelup ? `<@${member.id}>` : undefined;
    const payload = { embeds: [embed], content: mention, allowedMentions: { users: mention ? [member.id] : [] } };

    try {
        if (destination === 'dm') {
            await member.send(payload);
        } else {
            await message.channel.send(payload);
        }
    } catch (err) {
        console.error(`[Level] Failed to send level-up notification (guild ${member.guild.id}, user ${member.id}):`, err.message);
    }
}

module.exports = (client) => {
    client.on('messageCreate', async (message) => {
        if (message.author.bot || !message.guild || !message.member) return;

        try {
            const settings = await getGuildLevelingSettings(message.guild.id);
            if (!settings || settings.enabled === false) return; // enabled قد يكون undefined لسيرفرات ما هيّأت الجدول لسا - نتعامل معه كـ"مفعّل" افتراضياً إلا لو false صراحة

            if (!isChannelAllowed(settings.channel_whitelist, settings.channel_blacklist, message.channel.id)) return;
            if (isOnCooldown(message.guild.id, message.author.id, settings.text_cooldown_seconds)) return;

            const growthSystem = normalizeGrowthSystem(settings.xp_growth_system);
            const globalMultiplier = Number(settings.global_multiplier) > 0 ? Number(settings.global_multiplier) : 1;
            const tieredBrackets = (growthSystem === 'tiered') ? await getGuildTieredBrackets(message.guild.id) : null;

            const memberRoleIds = Array.from(message.member.roles.cache.keys());
            const guildMultipliers = await getGuildRoleMultipliers(message.guild.id);
            const roleMultiplier = getHighestRoleMultiplier(memberRoleIds, guildMultipliers);

            const awardedXp = Math.max(1, Math.round(randomBaseXp(settings.xp_min, settings.xp_max) * globalMultiplier * roleMultiplier));

            const before = await dbUtils.getUserLevel(message.guild.id, message.author.id);
            const levelBefore = before?.level ?? 0;

            const updated = await dbUtils.applyUserXpChange(message.guild.id, message.author.id, 'add', awardedXp, growthSystem, tieredBrackets);
            markCooldown(message.guild.id, message.author.id);

            if (updated.level > levelBefore) {
                await sendLevelUpNotification({
                    message,
                    member: message.member,
                    settings,
                    newLevel: updated.level,
                    newXp: updated.xp,
                    totalXp: updated.total_xp,
                    growthSystem,
                    tieredBrackets
                });
            }
        } catch (err) {
            console.error('[Level] Unexpected error while processing message:', err.message);
        }
    });

    console.log('[OmniGuard] Leveling System Engine: INITIALIZED');
};