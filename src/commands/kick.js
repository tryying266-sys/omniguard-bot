// ============================================================================
// kick.js - Universal Kick System (v4.0 - Smart Binding)
// ============================================================================
// Supports: Prefix, Slash (via Bridge), and AutoMod.
// Database: Integrated with log_moderation and log_command_bot.
// Built to match the exact conventions already used in ban.js / warn.js /
// mute.js, so it plugs into commandhandler.js and slashCommandsHandler.js
// without any changes to either.
// ============================================================================

const { PermissionsBitField } = require('discord.js');

/**
 * 1. CORE LOGIC: executeKick
 * Can be called by Prefix, Slash, or AutoMod.
 */
async function executeKick(guild, targetId, moderator, reason, dbUtils, channel = null) {
    try {
        const targetMember = await guild.members.fetch(targetId).catch(() => null);

        // --- A) VALIDATIONS ---
        if (!targetMember) return { success: false, error: "User not found in this server." };

        const targetTag = targetMember.user.tag;

        if (targetId === moderator.id) return { success: false, error: "You cannot kick yourself." };
        if (targetId === guild.ownerId) return { success: false, error: "You cannot kick the server owner." };

        // Hierarchy Check: Is moderator higher than target?
        if (moderator.id !== guild.ownerId && moderator.roles.highest.position <= targetMember.roles.highest.position) {
            return { success: false, error: "Your role is not high enough to kick this member." };
        }

        // Bot Permission Check: Is bot higher than target?
        if (!targetMember.kickable) {
            return { success: false, error: "I cannot kick this member (Role hierarchy or missing permission)." };
        }

        // --- B) EXECUTION ---
        const kickReason = `${reason} | Kicked by: ${moderator.tag}`;
        await targetMember.kick(kickReason);

        // --- C) DATABASE LOGGING (Smart Binding) ---
        await dbUtils.addInfraction(
            guild.id,
            targetId,
            moderator.id,
            'kick',
            reason,
            null, // Kick has no duration
            targetTag
        );

        // [Admin Protection] تتبع عدد إجراءات الطرد المتتالية من هذا المشرف
        try {
            const AutoMod = require('./AutoMod');
            await AutoMod.trackAdminAction(guild, moderator, 'kick');
        } catch (e) {
            console.error('[Admin Protection] trackAdminAction failed:', e.message);
        }

        // إرسال الإشعارات المركزية (DM و/أو Channel) حسب تفعيل الخيارات بالداشبورد
        const { notifyCommandExecution } = require('./commandNotifications');
        await notifyCommandExecution({
            guild,
            targetMember,
            moderator,
            channel,
            action: 'kick',
            reason,
            duration: null
        });

        return { success: true, targetTag: targetTag };

    } catch (err) {
        console.error('[Kick Engine Error]:', err);
        return { success: false, error: "Internal error during kick execution." };
    }
}

/**
 * 2. PREFIX HANDLER (Auto-Loading Entry Point)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase(); // 'kick'

    // Permission Check (Discord Native)
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply("❌ You lack 'Kick Members' permission.");
    }

    if (command === 'kick') {
        const targetArg = args[0];
        const reason = args.slice(1).join(' ') || "No reason provided";

        if (!targetArg) {
            return message.reply("⚠️ Usage: `kick @user <reason>`");
        }

        const targetId = targetArg.replace(/[<@!>]/g, '');
        // تم إضافة message.channel هنا
        const result = await executeKick(message.guild, targetId, message.author, reason, dbUtils, message.channel);

        if (result.success) {
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag,
                commandName: 'kick',
                channelId: message.channel.id,
                rawMessage: message.content
            });

            await dbUtils.addLogIndex(message.guild.id, message.id, message.channel.id, targetId, 'kick');

            // تم إزالة message.reply الثابتة؛ التحكم بالإشعارات أصبح كاملاً عبر commandNotifications
            return;
        } else {
            return message.reply(`❌ Error: ${result.error}`);
        }
    }
}

module.exports = {
    name: 'kick',
    description: 'Kicks a member from the server',
    permissions: [PermissionsBitField.Flags.KickMembers],
    executeKick,
    run
};