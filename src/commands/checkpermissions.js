// ============================================================================
// checkpermissions.js - Member Permission Inspector (v1.0 - Smart Binding)
// ============================================================================
// معلوماتي بس - بدون أي تسجيل بقاعدة البيانات، نفس نمط userinfo.js/
// serverinfo.js بالضبط (executeX/buildX منفصلة عن run() الـ Prefix،
// Auto-Loading Entry Point بنفس الاتفاقية).
//
// الصلاحية المطلوبة: ManageRoles - أقرب صلاحية ديسكورد فعلية لأداة "فحص
// صلاحيات عضو" (أداة تشخيص لضبط الرتب)، ومختلفة عمداً عن ManageGuild
// (serverinfo.js) وModerateMembers (userinfo.js) - تمييز واضح بين أدوات
// المعلومات الثلاثة حسب أقرب صلاحية فعلية لكل وحدة.
//
// الاستخدام: checkpermissions [@user] [#channel]
//   - بدون أرغيومنتس: يفحص صلاحيات المرسل نفسه على مستوى السيرفر
//   - بمنشن عضو بس: يفحص صلاحياته على مستوى السيرفر (Guild-wide)
//   - بمنشن عضو + قناة: يفحص صلاحياته الفعلية داخل تلك القناة تحديداً
//     (بعد احتساب كل الـ Permission Overwrites - أدق من الصلاحيات العامة)
// ============================================================================

const { PermissionsBitField, EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0x9b59b6; // بنفسجي - مختلف عن ألوان userinfo/serverinfo/lock عمداً، يميّز "أداة تشخيص صلاحيات"

// [ملاحظة] هذي أسماء عرض مختصرة ومقروءة لأهم الصلاحيات - قائمة PermissionsBitField.Flags
// الكاملة بديسكورد.js فيها ~40 صلاحية، أغلبها تقنية جداً أو نادرة الاستخدام
// الفعلي (زي UseSoundboard أو CreateGuildExpressions). عرضها كلها كان
// بيطوّل الإيمبد لدرجة غير عملية بدون أي فايدة حقيقية للمشرف. هذي القائمة
// تغطي كل الصلاحيات اللي فعلاً تهم مشرف يشخّص مشكلة صلاحيات.
const CHECKED_PERMISSIONS = [
    ['Administrator', 'Administrator'],
    ['ManageGuild', 'Manage Server'],
    ['ManageRoles', 'Manage Roles'],
    ['ManageChannels', 'Manage Channels'],
    ['ManageMessages', 'Manage Messages'],
    ['ManageNicknames', 'Manage Nicknames'],
    ['ManageWebhooks', 'Manage Webhooks'],
    ['ManageEmojisAndStickers', 'Manage Emojis/Stickers'],
    ['KickMembers', 'Kick Members'],
    ['BanMembers', 'Ban Members'],
    ['ModerateMembers', 'Timeout Members'],
    ['ViewAuditLog', 'View Audit Log'],
    ['MentionEveryone', 'Mention @everyone'],
    ['ViewChannel', 'View Channel'],
    ['SendMessages', 'Send Messages'],
    ['EmbedLinks', 'Embed Links'],
    ['AttachFiles', 'Attach Files'],
    ['ReadMessageHistory', 'Read Message History'],
    ['AddReactions', 'Add Reactions'],
    ['UseExternalEmojis', 'Use External Emojis'],
    ['Connect', 'Connect (Voice)'],
    ['Speak', 'Speak (Voice)'],
    ['MuteMembers', 'Mute Members (Voice)'],
    ['DeafenMembers', 'Deafen Members (Voice)'],
    ['MoveMembers', 'Move Members (Voice)']
];

function resolveTargetMember(message, arg) {
    if (!arg) return message.member;
    const idMatch = arg.match(/^<@!?(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!idMatch) return null;
    return message.guild.members.cache.get(idMatch[1]) || null;
}

function resolveTargetChannel(guild, arg) {
    if (!arg) return null;
    const idMatch = arg.match(/^<#(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!idMatch) return null;
    return guild.channels.cache.get(idMatch[1]) || null;
}

/**
 * CORE LOGIC: buildPermissionsEmbed
 * message-independent (member + channel اختياري) - قابل لإعادة الاستخدام
 * لاحقاً من Slash Command بدون تعديل.
 */
function buildPermissionsEmbed(member, channel = null) {
    const permissionsObj = channel
        ? channel.permissionsFor(member)
        : member.permissions;

    const lines = CHECKED_PERMISSIONS.map(([flagKey, label]) => {
        const granted = permissionsObj.has(PermissionsBitField.Flags[flagKey]);
        return `${granted ? '✅' : '❌'} ${label}`;
    });

    // تقسيم لعمودين عشان يصير الإيمبد مرتب وما يطول عمودياً بلا داعي
    const half = Math.ceil(lines.length / 2);
    const colOne = lines.slice(0, half).join('\n');
    const colTwo = lines.slice(half).join('\n');

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
        .setTitle(channel ? `Permissions in #${channel.name}` : 'Server-Wide Permissions')
        .addFields(
            { name: '\u200b', value: colOne, inline: true },
            { name: '\u200b', value: colTwo, inline: true }
        )
        .setFooter({ text: member.permissions.has(PermissionsBitField.Flags.Administrator) ? 'This member has Administrator - all permissions are effectively granted' : `Requested` })
        .setTimestamp();

    return embed;
}

/**
 * PREFIX HANDLER (Auto-Loading Entry Point)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command !== 'checkpermissions') return;

    // Permission Check (Discord Native)
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply("❌ You lack 'Manage Roles' permission.");
    }

    // الأرغيومنتس ممكن تجي بأي ترتيب (منشن عضو، منشن قناة) - نحلها بترتيب
    // ظهورها بدل ما نفرض ترتيب ثابت
    let targetMember = message.member;
    let targetChannel = null;
    let memberArgConsumed = false;

    for (const arg of args) {
        const maybeChannel = resolveTargetChannel(message.guild, arg);
        if (maybeChannel) {
            targetChannel = maybeChannel;
            continue;
        }
        if (!memberArgConsumed) {
            const maybeMember = resolveTargetMember(message, arg);
            if (maybeMember) {
                targetMember = maybeMember;
                memberArgConsumed = true;
            }
        }
    }

    if (!targetMember) {
        return message.reply('❌ Member not found.');
    }

    const embed = buildPermissionsEmbed(targetMember, targetChannel);
    return message.channel.send({ embeds: [embed] });
}

module.exports = {
    name: 'checkpermissions',
    description: "Displays a member's permissions (server-wide or in a specific channel)",
    permissions: [PermissionsBitField.Flags.ManageRoles],
    buildPermissionsEmbed,
    run
};