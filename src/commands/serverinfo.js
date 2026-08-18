// ============================================================================
// serverinfo.js - Server Information Display (v1.0 - Smart Binding)
// ============================================================================
// معلوماتي بس - بدون أي تسجيل بقاعدة البيانات (لا log_command_bot ولا غيره)،
// بناءً على طلبك مباشرة. نفس نمط userinfo.js/lock.js من ناحية الشكل
// (executeX منفصلة عن run() الـ Prefix، Auto-Loading Entry Point بنفس
// الاتفاقية).
//
// الصلاحية المطلوبة: ManageGuild - نفس الصلاحية المستخدمة بالضبط بالداشبورد
// (apiRouter.js) لقراءة إعدادات السيرفر العامة (catch-all GET/:tableName,
// auto-mod-rules, custom-embed-draft) - قرار متسق: عرض معلومات إدارية عامة
// عن السيرفر يستاهل نفس مستوى الصلاحية اللي نعتمده لقراءة إعداداته.
// ============================================================================

const { PermissionsBitField, EmbedBuilder, ChannelType } = require('discord.js');

const EMBED_COLOR = 0x3498db; // أزرق - مختلف عن أزرق userinfo (Blurple) عمداً، عشان يميّز "معلومات سيرفر" عن "معلومات عضو" بصرياً بسرعة

const VERIFICATION_LEVEL_LABELS = {
    0: 'None',
    1: 'Low',
    2: 'Medium',
    3: 'High',
    4: 'Very High'
};

const BOOST_TIER_LABELS = {
    0: 'None',
    1: 'Level 1',
    2: 'Level 2',
    3: 'Level 3'
};

/**
 * CORE LOGIC: buildServerInfoEmbed
 * message-independent (guild فقط) - قابل لإعادة الاستخدام لاحقاً من Slash
 * Command أو أي واجهة ثانية بدون تعديل.
 */
function buildServerInfoEmbed(guild) {
    const channels = guild.channels.cache;
    const textCount = channels.filter(c => c.type === ChannelType.GuildText).size;
    const voiceCount = channels.filter(c => c.type === ChannelType.GuildVoice).size;
    const categoryCount = channels.filter(c => c.type === ChannelType.GuildCategory).size;

    // [ملاحظة] الأعداد هذي تعتمد على guild.members.cache - دقيقة بفضل
    // GuildMembers Intent المفعّل بـ client.js (يعبّي الكاش وقت الاتصال)،
    // بس ممكن تكون تقريبية جداً بالسيرفرات الضخمة جداً لو الكاش ما اكتمل
    // بعد. guild.memberCount نفسه (الإجمالي) دقيق دايماً - يجي من Gateway
    // مباشرة بدون اعتماد على الكاش.
    const botCount = guild.members.cache.filter(m => m.user.bot).size;
    const humanCount = guild.memberCount - botCount;

    const createdTs = Math.floor(guild.createdTimestamp / 1000);

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setAuthor({ name: guild.name, iconURL: guild.iconURL() || undefined })
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .addFields(
            { name: 'Server ID', value: guild.id, inline: true },
            { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
            { name: 'Created', value: `<t:${createdTs}:F> (<t:${createdTs}:R>)` },
            { name: 'Members', value: `${guild.memberCount} total (${humanCount} humans, ${botCount} bots)` },
            { name: 'Channels', value: `${textCount} text, ${voiceCount} voice, ${categoryCount} categories` },
            { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
            { name: 'Verification Level', value: VERIFICATION_LEVEL_LABELS[guild.verificationLevel] ?? 'Unknown', inline: true },
            { name: 'Boost Status', value: `${BOOST_TIER_LABELS[guild.premiumTier] ?? 'Unknown'} (${guild.premiumSubscriptionCount || 0} boosts)`, inline: true }
        )
        .setFooter({ text: `Requested` })
        .setTimestamp();

    return embed;
}

/**
 * PREFIX HANDLER (Auto-Loading Entry Point)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command !== 'serverinfo') return;

    // Permission Check (Discord Native)
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return message.reply("❌ You lack 'Manage Server' permission.");
    }

    const embed = buildServerInfoEmbed(message.guild);
    return message.channel.send({ embeds: [embed] });
}

module.exports = {
    name: 'serverinfo',
    description: 'Displays information about the current server',
    permissions: [PermissionsBitField.Flags.ManageGuild],
    buildServerInfoEmbed,
    run
};