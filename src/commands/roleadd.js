const { PermissionsBitField } = require('discord.js');

async function handleRoleAdd(message, args, dbUtils = null) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply('❌ You do not have permission to manage roles.');
    }

    if (args.length < 2) {
        return message.reply('⚠️ Usage: `roleadd <roleName> <@member>`');
    }

    const targetArg = args[args.length - 1];
    const roleName = args.slice(0, -1).join(' ');

    if (!roleName || !targetArg) {
        return message.reply('⚠️ Usage: `roleadd <roleName> <@member>`');
    }

    const target = message.mentions.members?.first() || await message.guild.members.fetch(targetArg).catch(() => null);
    if (!target) {
        return message.reply('❌ I could not find that member.');
    }

    const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
        return message.reply('❌ I could not find that role on this server.');
    }

    try {
        await target.roles.add(role);

        if (dbUtils?.logCommand) {
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag,
                commandName: 'roleadd',
                channelId: message.channel.id,
                rawMessage: message.content
            });
        }

        return message.reply(`✅ Added role **${role.name}** to **${target.user.tag}**.`);
    } catch (error) {
        console.error('[Role Add Error]', error);
        return message.reply('❌ Something went wrong while adding the role.');
    }
}

/**
 * [NEW] Manual /demote command.
 * لا يعيد تنفيذ منطق التخفيض من الصفر - يستدعي نفس autoMod.demoteMember()
 * المستخدمة تلقائياً عند تجاوز حد السبام (AutoMod.js)، فيقرأ نفس الوضع
 * (single_rank / fixed_role) ونفس demote_target_role من setting_management_role.
 * هذا يضمن سلوك موحّد بين "الديموت اليدوي" و"الديموت التلقائي" دائماً.
 */
async function handleDemote(message, args, dbUtils = null) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply('❌ You do not have permission to manage roles.');
    }

    const [targetArg, ...reasonParts] = args;
    const reason = reasonParts.join(' ').trim() || 'No reason provided';

    if (!targetArg) {
        return message.reply('⚠️ Usage: `demote <@member> <reason>`');
    }

    const target = message.mentions.members?.first() || await message.guild.members.fetch(targetArg).catch(() => null);
    if (!target) {
        return message.reply('❌ I could not find that member.');
    }

    // نفس فحوصات التسلسل الهرمي المستخدمة بـ kick.js/ban.js - demote عقوبة
    // حقيقية (لهذا أضيفت أصلاً لقائمة action_type بقاعدة البيانات)، فتستحق
    // نفس الحماية، بعكس roleadd العادي.
    if (target.id === message.author.id) {
        return message.reply('❌ You cannot demote yourself.');
    }
    if (target.id === message.guild.ownerId) {
        return message.reply('❌ You cannot demote the server owner.');
    }
    if (message.author.id !== message.guild.ownerId && message.member.roles.highest.position <= target.roles.highest.position) {
        return message.reply('❌ Your role is not high enough to demote this member.');
    }

    try {
        // lazy require - نفس أسلوب AutoMod.js نفسها عند استدعائها لـ warn.js،
        // يتجنب أي احتمال لمشاكل ترتيب تحميل الملفات بمجلد commands/.
        const autoMod = require('./AutoMod');
        const demoted = await autoMod.demoteMember(target, reason);

        if (!demoted) {
            // demoteMember() تسجّل السبب الدقيق بالـ console بنفسها (تسلسل
            // هرمي، لا رتب قابلة للتخفيض، demote_target_role محذوفة/غير
            // معدة...) - هنا فقط رسالة عامة للمستخدم.
            return message.reply('❌ Could not demote this member. Check the bot\'s role hierarchy or the demote configuration in the dashboard.');
        }

        if (dbUtils?.addInfraction) {
            await dbUtils.addInfraction(message.guild.id, target.id, message.author.id, 'demote', reason, null, target.user.tag);
        }
        if (dbUtils?.addLogIndex) {
            await dbUtils.addLogIndex(message.guild.id, message.id, message.channel.id, target.id, 'demote');
        }
        if (dbUtils?.logCommand) {
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag,
                commandName: 'demote',
                channelId: message.channel.id,
                rawMessage: message.content
            });
        }

        return message.reply(`✅ **${target.user.tag}** has been demoted.\n📝 Reason: ${reason}`);
    } catch (error) {
        console.error('[Demote Command Error]', error);
        return message.reply('❌ Something went wrong while demoting this member.');
    }
}

async function run(message, dbUtils = null) {
    if (message.author.bot || !message.guild) return false;

    const content = message.content.trim();
    if (!content) return false;

    const args = content.split(/\s+/);
    const cmd = args.shift().toLowerCase();

    if (cmd === 'roleadd') {
        await handleRoleAdd(message, args, dbUtils);
        return true;
    }

    if (cmd === 'demote') {
        await handleDemote(message, args, dbUtils);
        return true;
    }

    return false;
}

module.exports = {
    run,
    handleRoleAdd,
    handleDemote,
    aliases: ['demote'] // <-- بدونها !demote ما راح يوصل لـ run() إطلاقاً (نفس فخ unban/unmute/unwarn/clear قبل ما يُصلح بـ commandhandler.js v3.2)
};