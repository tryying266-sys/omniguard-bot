// ============================================================================
// mute.js - Universal Mute/Unmute System (v4.0 - Smart Binding)
// ============================================================================

const { PermissionsBitField } = require('discord.js');

const MS = {
    s: 1000,
    m: 60 * 1000,
    min: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
};

const MAX_TIMEOUT_MS = 28 * MS.d; // Discord limit

// Parse duration: 1d, 10m, 10min, etc.
function parseDuration(input) {
    if (!input) return null;
    const match = input.trim().match(/^(\d+)\s*(s|min|m|h|d|w)$/i);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (amount <= 0) return null;

    const ms = amount * MS[unit];
    return ms > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : ms;
}

function formatDuration(ms) {
    const table = [
        { label: 'week', unitMs: MS.w },
        { label: 'day', unitMs: MS.d },
        { label: 'hour', unitMs: MS.h },
        { label: 'minute', unitMs: MS.m },
        { label: 'second', unitMs: MS.s }
    ];
    for (const { label, unitMs } of table) {
        if (ms >= unitMs) return `${Math.round(ms / unitMs)} ${label}${Math.round(ms / unitMs) > 1 ? 's' : ''}`;
    }
    return `${ms}ms`;
}

async function resolveTargetMember(message, arg) {
    const idMatch = arg.match(/^<@!?(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!idMatch) return null;
    try { return await message.guild.members.fetch(idMatch[1]); } catch { return null; }
}

// ==========================================
// CORE LOGIC: handleMute
// ==========================================
async function handleMute(message, args, dbUtils) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply('❌ You do not have permission to mute members.');
    }

    const [targetArg, durationArg, ...reasonParts] = args;
    const reason = reasonParts.join(' ').trim() || 'No reason provided';

    if (!targetArg || !durationArg) return message.reply('⚠️ Usage: `mute @member 1d reason`');

    const target = await resolveTargetMember(message, targetArg);
    if (!target) return message.reply('❌ Member not found.');

    // Hierarchy Checks
    if (target.id === message.author.id) return message.reply('❌ You cannot mute yourself.');
    if (!target.moderatable) return message.reply('❌ I cannot mute this member (Role hierarchy).');

    const durationMs = parseDuration(durationArg);
    if (!durationMs) return message.reply('⚠️ Invalid duration format (e.g., 30s, 10m, 1h, 1d).');

    try {
        await target.timeout(durationMs, `${reason} | By: ${message.author.tag}`);
// حفظ العقوبة المؤقتة لرفعها تلقائياً لاحقاً
        const endsAt = new Date(Date.now() + durationMs).toISOString();
        const supabase = require('../supabase/db');
        await supabase.from('temp_actions').insert({
            id_guild: message.guild.id,
            id_user: target.id,
            action_type: 'mute',
            ends_at: endsAt,
            processed: false
        });
        // Smart Binding: Log to SQL
        if (dbUtils?.addInfraction) {
            await dbUtils.addInfraction(message.guild.id, target.id, message.author.id, 'mute', reason, Math.round(durationMs / 60000));
        }
        if (dbUtils?.addLogIndex) {
            await dbUtils.addLogIndex(message.guild.id, message.id, message.channel.id, target.id, 'mute');
        }
        if (dbUtils?.logCommand) {
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag,
                commandName: 'mute',
                channelId: message.channel.id,
                rawMessage: message.content
            });
        }

        // [Admin Protection] تتبع عدد إجراءات الميوت المتتالية من هذا المشرف
        try {
            const AutoMod = require('./AutoMod');
            await AutoMod.trackAdminAction(message.guild, message.author, 'mute');
        } catch (e) {
            console.error('[Admin Protection] trackAdminAction failed:', e.message);
        }

        return message.reply(`✅ **${target.user.tag}** muted for **${formatDuration(durationMs)}**.\n📝 Reason: ${reason}`);
    } catch (err) {
        console.error('[Mute Error]', err);
        return message.reply('❌ Failed to mute member.');
    }
}

// ==========================================
// CORE LOGIC: handleUnmute
// ==========================================
async function handleUnmute(message, args, dbUtils) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply('❌ You do not have permission to unmute members.');
    }

    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';

    if (!targetArg) return message.reply('⚠️ Usage: `unmute @member reason`');

    const target = await resolveTargetMember(message, targetArg);
    if (!target) return message.reply('❌ Member not found.');
    if (!target.communicationDisabledUntil) return message.reply('ℹ️ This member is not muted.');

    try {
        await target.timeout(null, `Unmute | ${reason} | By: ${message.author.tag}`);

        // Smart Binding: Log to SQL
        if (dbUtils?.addInfraction) {
            await dbUtils.addInfraction(message.guild.id, target.id, message.author.id, 'unmute', reason, null);
        }
        if (dbUtils?.addLogIndex) {
            await dbUtils.addLogIndex(message.guild.id, message.id, message.channel.id, target.id, 'unmute');
        }
        if (dbUtils?.logCommand) {
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag,
                commandName: 'unmute',
                channelId: message.channel.id,
                rawMessage: message.content
            });
        }

        return message.reply(`✅ **${target.user.tag}** has been unmuted.\n📝 Reason: ${reason}`);
    } catch (err) {
        console.error('[Unmute Error]', err);
        return message.reply('❌ Failed to unmute member.');
    }
}

async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();

    if (cmd === 'mute') await handleMute(message, args, dbUtils);
    else if (cmd === 'unmute') await handleUnmute(message, args, dbUtils);
}

module.exports = { 
    name: 'mute',
    aliases: ['unmute'], // <-- تضعها هنا داخل الكائن
    run, 
    handleMute, 
    handleUnmute 
};