// ============================================================================
// lock.js - Universal Channel Lock/Unlock System (v1.0 - Smart Binding)
// ============================================================================
// Supports: Prefix (via commandhandler.js Auto-Loading), same conventions as
// kick.js / mute.js so it plugs in without any changes to commandhandler.js
// or slashCommandsHandler.js.
//
// [NOTE] Unlike kick/mute/warn/ban, lock/unlock target a CHANNEL, not a
// member - and 'lock'/'unlock' are NOT valid values in the log_moderation /
// log_index_message action_type CHECK constraints (schema v5.5 only allows
// 'ban','kick','mute','warn','unmute','unban','unwarn','demote' there).
// Calling dbUtils.addInfraction()/addLogIndex() with action='lock' would
// throw a database constraint violation. This file intentionally only logs
// to log_command_bot (free-text name_command column, no constraint) via
// dbUtils.logCommand() - same general "command was used" audit trail,
// without touching the member-punishment log tables at all.
// ============================================================================

const { PermissionsBitField, EmbedBuilder } = require('discord.js');

const EMBED_COLOR_LOCK = 0xe74c3c;   // أحمر - نفس منطق الألوان بـ commandNotifications.js (عقوبة/تقييد)
const EMBED_COLOR_UNLOCK = 0x2ecc71; // أخضر - نفس منطق unmute/unban هناك

/**
 * يحدد القناة المستهدفة من الأرغيومنت (منشن #channel أو ID خام)، أو يرجع
 * القناة الحالية لو ما فيه أرغيومنت يطابق قناة فعلاً.
 */
function resolveTargetChannel(guild, arg) {
    if (!arg) return null;
    const idMatch = arg.match(/^<#(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!idMatch) return null;
    return guild.channels.cache.get(idMatch[1]) || null;
}

/**
 * 1. CORE LOGIC: executeLock
 * Can be called by Prefix, Slash, or AutoMod later - same pattern as
 * executeKick/executeMute (guild/target/moderator/reason/dbUtils signature).
 */
async function executeLock(guild, channelId, moderator, reason, dbUtils) {
    try {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) return { success: false, error: "Channel not found in this server." };
        if (!channel.isTextBased || !channel.isTextBased()) {
            return { success: false, error: "This channel type cannot be locked." };
        }

        // Bot Permission Check
        const botMember = guild.members.me;
        if (!channel.permissionsFor(botMember)?.has(PermissionsBitField.Flags.ManageChannels)) {
            return { success: false, error: "I don't have 'Manage Channels' permission in this channel." };
        }

        // Already-locked check: @everyone's SendMessages already explicitly denied
        const existingOverwrite = channel.permissionOverwrites.cache.get(guild.id);
        if (existingOverwrite?.deny.has(PermissionsBitField.Flags.SendMessages)) {
            return { success: false, error: "This channel is already locked." };
        }

        await channel.permissionOverwrites.edit(
            guild.id,
            { SendMessages: false },
            { reason: `${reason} | Locked by: ${moderator.tag}` }
        );

        // [NOTE] عمداً ما نستخدم dbUtils.addInfraction/addLogIndex هنا -
        // راجع التعليق بأعلى الملف. تسجيل استخدام الأمر بس (آمن، بدون قيود).
        return { success: true, channelName: channel.name };
    } catch (err) {
        console.error('[Lock Engine Error]:', err);
        return { success: false, error: "Internal error during channel lock." };
    }
}

/**
 * 2. CORE LOGIC: executeUnlock
 */
async function executeUnlock(guild, channelId, moderator, reason, dbUtils) {
    try {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) return { success: false, error: "Channel not found in this server." };
        if (!channel.isTextBased || !channel.isTextBased()) {
            return { success: false, error: "This channel type cannot be unlocked." };
        }

        const botMember = guild.members.me;
        if (!channel.permissionsFor(botMember)?.has(PermissionsBitField.Flags.ManageChannels)) {
            return { success: false, error: "I don't have 'Manage Channels' permission in this channel." };
        }

        const existingOverwrite = channel.permissionOverwrites.cache.get(guild.id);
        if (!existingOverwrite?.deny.has(PermissionsBitField.Flags.SendMessages)) {
            return { success: false, error: "This channel is not locked." };
        }

        // null يرجّع الصلاحية لوضعها الموروث الطبيعي (بدل ما نفرض true،
        // اللي ممكن يتعارض مع Overwrites ثانية موجودة لرتب محددة)
        await channel.permissionOverwrites.edit(
            guild.id,
            { SendMessages: null },
            { reason: `${reason} | Unlocked by: ${moderator.tag}` }
        );

        return { success: true, channelName: channel.name };
    } catch (err) {
        console.error('[Unlock Engine Error]:', err);
        return { success: false, error: "Internal error during channel unlock." };
    }
}

/**
 * 3. PREFIX HANDLER (Auto-Loading Entry Point)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase(); // 'lock' أو 'unlock'

    if (command !== 'lock' && command !== 'unlock') return;

    // Permission Check (Discord Native) - نفس نمط kick.js/mute.js بالضبط
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return message.reply("❌ You lack 'Manage Channels' permission.");
    }

    // أول أرغيومنت ممكن يكون منشن قناة/ID - لو مطابق نعتبره القناة
    // المستهدفة، وإلا نستخدم القناة الحالية ونعتبر كل الأرغيومنتس Reason
    const maybeChannel = resolveTargetChannel(message.guild, args[0]);
    const targetChannel = maybeChannel || message.channel;
    const reasonArgs = maybeChannel ? args.slice(1) : args;
    const reason = reasonArgs.join(' ') || 'No reason provided';

    const executor = command === 'lock' ? executeLock : executeUnlock;
    const result = await executor(message.guild, targetChannel.id, message.author, reason, dbUtils);

    if (!result.success) {
        return message.reply(`❌ Error: ${result.error}`);
    }

    // تسجيل استخدام الأمر (log_command_bot - بدون قيود على القيم)
    if (dbUtils?.logCommand) {
        await dbUtils.logCommand({
            guildId: message.guild.id,
            userId: message.author.id,
            username: message.author.tag,
            commandName: command,
            channelId: message.channel.id,
            rawMessage: message.content
        });
    }

    const isLock = command === 'lock';
    const embed = new EmbedBuilder()
        .setColor(isLock ? EMBED_COLOR_LOCK : EMBED_COLOR_UNLOCK)
        .setTitle(isLock ? '🔒 Channel Locked' : '🔓 Channel Unlocked')
        .addFields(
            { name: 'Channel', value: `#${result.channelName}`, inline: true },
            { name: 'Moderator', value: message.author.tag, inline: true },
            { name: 'Reason', value: reason }
        )
        .setTimestamp();

    return message.channel.send({ embeds: [embed] });
}

module.exports = {
    name: 'lock',
    aliases: ['unlock'],
    description: 'Locks or unlocks a channel (prevents/allows @everyone from sending messages)',
    permissions: [PermissionsBitField.Flags.ManageChannels],
    executeLock,
    executeUnlock,
    run
};