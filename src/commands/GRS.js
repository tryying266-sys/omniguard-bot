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
    // [FIX] blacklist هي المصدر الوحيد للمنع. whitelisted_channels لم يعد
    // يُستخدم بهذا الفحص إطلاقاً - أي قناة غير موجودة بالـ blacklist مسموحة.
    const blacklist = guildSettings.blacklisted_channels || [];
    return !blacklist.includes(channelId);
}

/**
 * CHECK: هل العضو معفى من أمر معيّن (أو من كل الأوامر)؟
 * يفحص مصدرين مع بعض:
 *
 * 1) إعفاء دائم على مستوى الرتبة (roles_exempt_commands بـ setting_guild) -
 *    يغطي كل الأوامر بلا استثناء. نفس السلوك القديم بالضبط، بدون تغيير.
 *
 * 2) [NEW v5.3] إعفاء مؤقت (أو دائم) على مستوى العضو الفرد من جدول
 *    user_command_exemption - يُدار من كرت Command Exceptions بالداشبورد.
 *    يتحقق من كون commandName ضمن القائمة المخزّنة، ومن عدم انتهاء مدة
 *    الصلاحية (expires_at) - لو منتهية فعلياً (حتى لو السكجولر لسه ما
 *    نظّفها من القاعدة) يُعتبر الإعفاء غير ساري.
 *
 * ⚠️ أصبحت async بسبب فحص (2) - أي نقطة استدعاء حالية أو مستقبلية لازم
 * تستخدم await من الآن فصاعداً (commandhandler.js و apiRouter.js يحتاجون
 * تعديل مطابق - لم يُطبّق بعد، مذكور بنهاية الرد).
 *
 * @param {Object} guildSettings - صف setting_guild (لفحص الرتبة)
 * @param {import('discord.js').GuildMember} member
 * @param {string} [commandName] - اسم الأمر المطلوب فحصه (kick/ban/mute/warn/roleadd...).
 *        لو ما انمرر، يتم تجاهل فحص (2) بالكامل ويكتفى بفحص الرتبة فقط
 *        (Backward Compatible مع أي استدعاء قديم ما مرّر اسم أمر).
 */
async function isMemberCommandExempt(guildSettings, member, commandName = null) {
    if (!guildSettings || !member) return false;

    // 1) فحص الرتبة (سلوك قديم، بدون أي تغيير)
    const exemptRoles = guildSettings.roles_exempt_commands || [];
    if (exemptRoles.length > 0 && member.roles.cache.some(role => exemptRoles.includes(role.id))) {
        return true;
    }

    // 2) فحص إعفاء العضو الفرد (v5.3) - يحتاج اسم أمر محدد عشان يفحصه
    if (!commandName) return false;

    try {
        const supabase = require('../supabase/db');
        const { data, error } = await supabase
            .from('user_command_exemption')
            .select('commands, expires_at')
            .eq('id_guild', member.guild.id)
            .eq('id_user', member.id)
            .maybeSingle();

        if (error || !data) return false;

        const isExpired = data.expires_at && new Date(data.expires_at).getTime() <= Date.now();
        if (isExpired) return false;

        return (data.commands || []).includes(commandName);
    } catch (err) {
        // لا نرمي (throw) - نفس فلسفة بقية الملف - خطأ هنا ما يوقف تنفيذ الأمر
        console.error('[GRS Error] isMemberCommandExempt (per-user check) failed:', err.message);
        return false;
    }
}

module.exports = {
    setupNicknameGuard,
    enforceNickname, // مُصدّرة منفردة عشان تُستدعى لاحقاً من apiRouter.js فور ما
                      // صاحب السيرفر يحدّث nickname_server من الداشبورد مباشرة
                      // (اتجاه DB -> Discord فوري، بدون انتظار حدث ديسكورد)
    isChannelAllowed,
    isMemberCommandExempt
};