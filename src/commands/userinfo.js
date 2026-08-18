// ============================================================================
// userinfo.js - Member Information Display (v1.0 - Smart Binding)
// ============================================================================
// معلوماتي بس - ما فيه عقوبة ولا تسجيل بأي جدول log (لا log_moderation ولا
// log_command_bot) عمداً، لأنه أمر استعلام مو إجراء إشرافي فعلي. لو تحب
// تسجيل استخدامه بـ log_command_bot لاحقاً، سهل تضيفها (نفس نمط lock.js).
//
// الصلاحية المطلوبة: ModerateMembers - نفس الصلاحية المستخدمة بالضبط
// بمسار /member/:userId/profile بالداشبورد (apiRouter.js) لعرض بروفايل
// عضو - قرار متسق بين الداشبورد والبوت.
//
// ملاحظة: ديسكورد ما يوفر "آخر ظهور" فعلي عبر الـ API (لا يوجد Presence
// History) - الحقول بالأسفل هي القياسية اللي البوتات المحترفة تعرضها
// فعلاً: تاريخ إنشاء الحساب، تاريخ الانضمام، الرتب، حالة البوستينق، شارة
// البوت لو ينطبق.
// ============================================================================

const { PermissionsBitField, EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0x5865f2; // Discord Blurple - نفس اللون الافتراضي بـ commandNotifications.js لأوامر غير عقابية

async function resolveTargetMember(message, arg) {
    if (!arg) return message.member; // ما فيه هدف محدد -> يعرض معلومات المرسل نفسه

    const idMatch = arg.match(/^<@!?(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!idMatch) return null;
    try {
        return await message.guild.members.fetch(idMatch[1]);
    } catch {
        return null;
    }
}

/**
 * CORE LOGIC: buildUserInfoEmbed
 * message-independent (guild + member فقط) - قابل لإعادة الاستخدام لاحقاً
 * من Slash Command أو أي واجهة ثانية بدون تعديل.
 */
function buildUserInfoEmbed(guild, member) {
    const user = member.user;

    const roles = member.roles.cache
        .filter(r => r.id !== guild.id) // استثناء @everyone
        .sort((a, b) => b.position - a.position)
        .map(r => `<@&${r.id}>`);

    const rolesText = roles.length > 0
        ? (roles.length > 15 ? roles.slice(0, 15).join(' ') + ` … (+${roles.length - 15} more)` : roles.join(' '))
        : 'No roles';

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
            { name: 'User ID', value: user.id, inline: true },
            { name: 'Nickname', value: member.nickname || 'None', inline: true },
            { name: 'Bot Account', value: user.bot ? 'Yes' : 'No', inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)` },
            {
                name: 'Joined Server',
                value: member.joinedTimestamp
                    ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F> (<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`
                    : 'Unknown'
            }
        );

    if (member.premiumSinceTimestamp) {
        embed.addFields({
            name: 'Boosting Since',
            value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:F>`
        });
    }

    embed.addFields({ name: `Roles [${roles.length}]`, value: rolesText });
    embed.setFooter({ text: `Requested` }).setTimestamp();

    return embed;
}

/**
 * PREFIX HANDLER (Auto-Loading Entry Point)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command !== 'userinfo') return;

    // Permission Check (Discord Native) - نفس الصلاحية المستخدمة بالداشبورد
    // لعرض بروفايل عضو (راجع requireDiscordPermission على /member/:userId/profile)
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply("❌ You lack 'Moderate Members' permission.");
    }

    const targetArg = args[0];
    const target = await resolveTargetMember(message, targetArg);

    if (!target) {
        return message.reply('❌ Member not found.');
    }

    const embed = buildUserInfoEmbed(message.guild, target);
    return message.channel.send({ embeds: [embed] });
}

module.exports = {
    name: 'userinfo',
    description: 'Displays information about a server member',
    permissions: [PermissionsBitField.Flags.ModerateMembers],
    buildUserInfoEmbed,
    run
};