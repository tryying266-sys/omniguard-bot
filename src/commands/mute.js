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
// ==========================================
// CORE LOGIC: executeMute (message-independent)
// ==========================================
async function executeMute(guild, targetId, moderator, durationStr, reason, dbUtils, channel = null) {
    try {
        const target = await guild.members.fetch(targetId).catch(() => null);
        if (!target) return { success: false, error: "Member not found." };

        // Hierarchy Checks (same checks as before, unchanged)
        if (target.id === moderator.id) return { success: false, error: "You cannot mute yourself." };
        if (!target.moderatable) return { success: false, error: "I cannot mute this member (Role hierarchy)." };

        // [NEW] لو المشرف ما حدد مدة (فاضي/null من الداشبورد)، نطبّق أقصى
        // مدة يسمح فيها ديسكورد (28 يوم) بدل ما نرفض الطلب - الميوت أصلاً
        // ما عنده مفهوم "دائم" حقيقي بديسكورد، فهذا أقرب بديل منطقي.
        const durationMs = durationStr ? parseDuration(durationStr) : MAX_TIMEOUT_MS;
        if (!durationMs) return { success: false, error: "Invalid duration format (e.g., 30s, 10m, 1h, 1d)." };

        await target.timeout(durationMs, `${reason} | By: ${moderator.tag}`);

        // حفظ العقوبة المؤقتة لرفعها تلقائياً لاحقاً
        // [FIXED] .insert() بمكتبة Supabase JS يرجع "Thenable" مش Promise
        // حقيقي - .catch() مباشر عليه (قبل await/then) يرمي TypeError:
        // "...catch is not a function". لازم await/try-catch عادي بدلها.
        const endsAt = new Date(Date.now() + durationMs).toISOString();
        const supabase = require('../supabase/db');
        try {
            const { error: tempActionError } = await supabase.from('temp_actions').insert({
                id_guild: guild.id,
                id_user: target.id,
                action_type: 'mute',
                ends_at: endsAt,
                processed: false
            });
            if (tempActionError) console.error('[DB Error] Temp-mute insert failed:', tempActionError.message);
        } catch (tempActionErr) {
            console.error('[DB Error] Temp-mute insert failed (exception):', tempActionErr.message);
        }

        // [FIXED] Smart Binding: Log to SQL - محمي بـ try/catch خاص فيه الآن
        // (نفس فلسفة temp_actions.insert() فوق و trackAdminAction تحت) -
        // العملية الفعلية بديسكورد (target.timeout) خلصت ونجحت بالفعل قبل
        // هالسطر، فما يصح نرجّع "فشل" للداشبورد بس لأن التسجيل بالقاعدة
        // تعثر. نسجل الخطأ بالكونسول للمتابعة، وما نوقف التنفيذ.
        // البديل
        if (dbUtils?.addInfraction) {
            try {
                await dbUtils.addInfraction(guild.id, target.id, moderator.id, 'mute', reason, formatDuration(durationMs));
            } catch (logErr) {
                console.error('[Mute Engine] addInfraction failed (mute itself succeeded on Discord):', logErr.message);
            }
        }

        // [Admin Protection] تتبع عدد إجراءات الميوت المتتالية من هذا المشرف
        try {
            const AutoMod = require('./AutoMod');
            await AutoMod.trackAdminAction(guild, moderator, 'mute');
        } catch (e) {
            console.error('[Admin Protection] trackAdminAction failed:', e.message);
        }

        // [FIXED] إرسال الإشعار - نفس المنطق، محمي بذاته الآن
        try {
            const { notifyCommandExecution } = require('./commandNotifications');
            await notifyCommandExecution({
                guild,
                targetMember: target,
                moderator,
                channel,
                action: 'mute',
                reason,
                duration: formatDuration(durationMs)
            });
        } catch (notifyErr) {
            console.error('[Mute Engine] notifyCommandExecution failed (mute itself succeeded on Discord):', notifyErr.message);
        }

        return { success: true, targetTag: target.user.tag, durationText: formatDuration(durationMs) };
    } catch (err) {
        console.error('[Mute Engine Error]:', err);
        return { success: false, error: "Internal error during mute execution." };
    }
}

// ==========================================
// PREFIX WRAPPER: handleMute
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

    const result = await executeMute(message.guild, target.id, message.author, durationArg, reason, dbUtils, message.channel);

    if (result.success) {
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
        return;
    } else {
        return message.reply(`❌ ${result.error}`);
    }
}

// ==========================================
// CORE LOGIC: handleUnmute
// ==========================================
// ==========================================
// CORE LOGIC: executeUnmute (message-independent)
// ==========================================
async function executeUnmute(guild, targetId, moderator, reason, dbUtils, channel = null) {
    try {
        const target = await guild.members.fetch(targetId).catch(() => null);
        if (!target) return { success: false, error: "Member not found." };
        if (!target.communicationDisabledUntil) return { success: false, error: "This member is not muted." };

        await target.timeout(null, `Unmute | ${reason} | By: ${moderator.tag}`);

        // Smart Binding: Log to SQL
        if (dbUtils?.addInfraction) {
            await dbUtils.addInfraction(guild.id, target.id, moderator.id, 'unmute', reason, null);
        }

        const { notifyCommandExecution } = require('./commandNotifications');
        await notifyCommandExecution({
            guild,
            targetMember: target,
            moderator,
            channel,
            action: 'unmute',
            reason,
            duration: null
        });

        return { success: true };
    } catch (err) {
        console.error('[Unmute Engine Error]:', err);
        return { success: false, error: "Failed to unmute member." };
    }
}

// ==========================================
// PREFIX WRAPPER: handleUnmute
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

    const result = await executeUnmute(message.guild, target.id, message.author, reason, dbUtils, message.channel);

    if (result.success) {
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
        return;
    } else {
        return message.reply(`❌ ${result.error}`);
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
    handleUnmute,
    executeMute,
    executeUnmute
};