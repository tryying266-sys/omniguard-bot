// ============================================================================
// GRS.js - Guild Runtime Sync
// ============================================================================
// هذا الملف مسؤول عن مزامنة إعدادات السيرفر الحيّة (Live Settings) بين
// قاعدة البيانات (مصدر الحقيقة الوحيد - Single Source of Truth) وديسكورد
// نفسه، بالإضافة لاحقاً لفحوصات الصلاحيات على تنفيذ الأوامر.
//
// ⚠️ هذا ليس ملف أمر شات (Chat Command) - لا يُصدّر run()/name() بنمط
// ban.js/kick.js. لذلك يجب استثناؤه بالاسم من commandhandler.js
// (نفس أسلوب استثناء AutoMod.js/AntiAlt.js حالياً) - هذا التعديل لم يُنفّذ
// بعد بناءً على تعليمات صاحب المشروع (سيُطلب لاحقاً).
//
// الحالة الحالية: يغطي فقط ميزة #1 (فرض النيكنيم). الميزات الثلاث الباقية
// (رتب معفاة من الأوامر، قنوات مسموحة/ممنوعة، رتب دخول الداشبورد) ستُضاف
// لاحقاً بنفس الملف بعد ربط نقاط الاستدعاء الصحيحة بـ commandhandler.js
// و AutoMod.js.
//
// طريقة الاستخدام (يُستدعى مرة وحدة فقط، لاحقاً من client.js):
//     const { setupNicknameGuard } = require('./commands/AutoMod/GRS');
//     setupNicknameGuard(client, dbUtils);
// ============================================================================

const { PermissionFlagsBits } = require('discord.js');

// حماية من تنفيذ عمليتي تصحيح متزامنتين لنفس السيرفر (Race Condition Guard).
// مثال: لو وصل حدثين guildMemberUpdate بنفس اللحظة قبل ما تنتهي أول عملية setNickname.
const processingGuilds = new Set();

/**
 * ENFORCE NICKNAME (اتجاهين):
 * تقارن النيكنيم الحالي للبوت بديسكورد مع القيمة المخزّنة بـ
 * setting_guild.nickname_server، وتصحح أي اختلاف بينهم بغض النظر عن مصدر
 * الاختلاف (تعديل يدوي بديسكورد، أو تعديل جديد من الداشبورد لسه ما انعكس
 * على ديسكورد).
 *
 * @param {import('discord.js').Guild} guild
 * @param {Object} dbUtils - Universal Database Wrapper (من dbUtils.js)
 */
async function enforceNickname(guild, dbUtils) {
    if (!guild || !guild.available) return;
    if (processingGuilds.has(guild.id)) return; // فيه عملية تصحيح شغالة أصلاً لهذا السيرفر، تجاهل
    processingGuilds.add(guild.id);

    try {
        const settings = await dbUtils.getGuildSettings(guild.id);
        if (!settings) {
            // السيرفر غير مهيّأ بعد بقاعدة البيانات (init_guild_settings لم يُنفَّذ له)
            return;
        }

        const desiredNickname = settings.nickname_server; // القيمة الرسمية من الداشبورد
        const botMember = guild.members.me;
        if (!botMember) return;

        const currentNickname = botMember.nickname || botMember.user.username;

        // متطابقين أصلاً -> ما فيه شي نسويه
        if (currentNickname === desiredNickname) return;

        // فحص الصلاحية قبل المحاولة (تفادي رمي استثناء غير ضروري ولوق مزعج بالكونسول)
        const canChangeNickname =
            botMember.permissions.has(PermissionFlagsBits.ChangeNickname) ||
            botMember.permissions.has(PermissionFlagsBits.ManageNicknames);

        if (!canChangeNickname) {
            console.warn(`[GRS] Missing CHANGE_NICKNAME permission in guild ${guild.id} ("${guild.name}") - cannot enforce nickname.`);
            return;
        }

        await botMember.setNickname(desiredNickname, 'GRS: Enforcing nickname configured on the dashboard');
        console.log(`[GRS] Nickname synced in guild ${guild.id}: "${currentNickname}" -> "${desiredNickname}"`);

    } catch (error) {
        // لا نرمي (throw) أبداً - نفس فلسفة بقية النظام (dbUtils/databaseQueries)
        // خطأ هنا لا يجوز يوقف البوت أو يكسر أي حدث ثاني.
        console.error(`[GRS Error] enforceNickname failed for guild ${guild.id}:`, error.message);
    } finally {
        processingGuilds.delete(guild.id);
    }
}

/**
 * SETUP: يسجّل كل الـ Listeners اللازمة لمراقبة النيكنيم.
 * تُستدعى مرة وحدة فقط عند إقلاع البوت (من client.js لاحقاً).
 *
 * @param {import('discord.js').Client} client
 * @param {Object} dbUtils
 */
function setupNicknameGuard(client, dbUtils) {
    // عند اكتمال إقلاع البوت: تأكد أن النيكنيم مطابق بكل سيرفر موجود فيه
    // البوت حالياً (يغطي حالة: البوت كان أوفلاين وقت ما تغيّر النيكنيم يدوياً).
    client.once('ready', async () => {
        console.log('[GRS] Running initial nickname sync across all guilds...');
        for (const guild of client.guilds.cache.values()) {
            await enforceNickname(guild, dbUtils);
        }
    });

    // عند دخول البوت لسيرفر جديد لأول مرة
    client.on('guildCreate', async (guild) => {
        await enforceNickname(guild, dbUtils);
    });

    // المراقبة الحية: نحدث النيكنيم فور أي تعديل عضوية بالسيرفر.
    // فحص رخيص أولاً (id) قبل أي استعلام قاعدة بيانات، عشان ما نستهلك
    // موارد على تحديثات عضوية غير متعلقة بالبوت إطلاقاً (وهي الغالبية الساحقة).
    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        if (newMember.id !== client.user.id) return; // مو عضوية البوت -> تجاهل فوراً
        if (oldMember.nickname === newMember.nickname) return; // ما فيه تغيير فعلي بالنيكنيم تحديداً
        await enforceNickname(newMember.guild, dbUtils);
    });
}
/**
 * CHECK: هل القناة مسموح فيها تنفيذ الأوامر اليدوية؟
 * الأولوية: بدون whitelist ولا blacklist -> الكل مسموح | فيه blacklist فقط ->
 * الكل مسموح إلا هي | فيه whitelist -> بس الموجود فيها مسموح (حتى لو فاضي من blacklist).
 */
function isChannelAllowed(guildSettings, channelId) {
    if (!guildSettings) return true;
    const whitelist = guildSettings.whitelisted_channels || [];
    const blacklist = guildSettings.blacklisted_channels || [];

    if (whitelist.length > 0) return whitelist.includes(channelId);
    return !blacklist.includes(channelId);
}

/**
 * CHECK: هل العضو (الهدف) معفى تماماً من أوامر البوت - يدوياً وتلقائياً؟
 * عمود roles_exempt_commands بجدول setting_guild.
 */
function isMemberCommandExempt(guildSettings, member) {
    if (!guildSettings || !member) return false;
    const exemptRoles = guildSettings.roles_exempt_commands || [];
    if (exemptRoles.length === 0) return false;
    return member.roles.cache.some(role => exemptRoles.includes(role.id));
}

module.exports = {
    setupNicknameGuard,
    enforceNickname, // مُصدّرة منفردة عشان تُستدعى لاحقاً من apiRouter.js فور ما
                      // صاحب السيرفر يحدّث nickname_server من الداشبورد مباشرة
                      // (اتجاه DB -> Discord فوري، بدون انتظار حدث ديسكورد)
    isChannelAllowed,
    isMemberCommandExempt
};