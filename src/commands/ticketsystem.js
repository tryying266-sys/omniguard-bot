// ============================================================================
// ticketsystem.js - Ticket System Commands (v1.0)
// ============================================================================
// Supports: Prefix commands only for now (same contract as ban.js: this file
// is auto-loaded by commandhandler.js and exposes run(message, dbUtils)).
// A slash-command bridge (slashCommandsHandler.js) can call the exported
// execute* functions directly later, exactly like ban.js's executeBan /
// executeUnban are designed to be reused outside the prefix flow.
//
// Database: ticket_record, ticket_type_config, ticket_blacklist,
// setting_ticket_system (schema v5.5 delta).
//
// ⚠️ SCOPE OF THIS FILE (by design):
// This file only covers the 9 in-ticket / moderation commands below. It does
// NOT include:
//   - The panel button / select-menu "open ticket" interaction flow
//   - The Auto Close idle scheduler
//   - The Auto Respond fuzzy-matching message listener
// Those are Discord *interaction*/event listeners, not chat commands (they
// don't fit the run(message, dbUtils) contract commandhandler.js expects),
// so - following this codebase's own pattern of separating command files
// from background engines (AutoMod.js, GRS.js, AutoRole.js are excluded from
// the auto-loader for the exact same reason) - they belong in their own
// dedicated file(s). Happy to write those next.
//
// ⚠️ NAMING COLLISION RISK:
// This module registers 10 keys total in commandhandler.js's global
// Collection (name: 'claim' + the 9 aliases below: unclaim, transfer, add,
// remove, bump, ping-user, close, ticket-blacklist, ticket-unblacklist,
// rename). Some of these words (add, remove, close, bump, rename, transfer)
// are generic enough that another existing command file could already
// register them. commandhandler.js already handles this safely (it logs
// "Alias conflict... skipped" and keeps the FIRST registration), but a
// silent skip means that specific ticket command just won't fire. If any of
// these collide with something else in the project, tell me and I'll swap
// them to more specific names (e.g. 'ticket-add') - it's a one-line change.
//
// ⚠️ INTENTIONALLY NO module.exports.permissions:
// commandhandler.js applies that property as one blanket permission check
// BEFORE run() is even called, identically to every alias pointing at this
// module. Since claim/add/bump need "ticket staff" (a per-ticket-type role
// list from the database) while ticket-blacklist needs a real Discord
// permission, a single static permission value can't correctly cover all of
// them. So authorization is done manually inside run(), per branch, instead.
// ============================================================================

const { PermissionsBitField, EmbedBuilder, AttachmentBuilder, OverwriteType } = require('discord.js');
const supabase = require('../supabase/db');
// [NEW] يُستخدم بس لضغط الترانسكربت وقت إرساله لروم اللوق (transcript_channel_id)
// - ديسكورد Desktop يعرض ملفات .html/.txt الصغيرة كمعاينة كود مباشرة
// بالشات بدل تحميلها كملف، بعكس الجوال اللي يطلعها كارت تحميل عادي دايماً.
// الحل: نضغطها .zip بس لوجهة روم اللوق تحديداً (الطاقم غالباً يفتحه من
// اللابتوب) - وجهة الـ DM لصاحب التذكرة تبقى .html خام بدون أي تغيير
// (تجربة الجوال الحالية شغالة صح وما لها داعي تتغيّر).
const AdmZip = require('adm-zip');

// ----------------------------------------------------------------------
// Duration parsing
// ----------------------------------------------------------------------
// [NOTE] Duplicated from ban.js on purpose - I haven't seen a shared utils
// module confirmed to exist in this project. If one exists, this can be
// swapped for a shared require() later without touching any call sites
// below (parseDuration's signature/return shape matches ban.js exactly).
const MS_MAP = {
    s: 1000,
    m: 60000,
    min: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
    mo: 2592000000, // 30 يوم تقريبي
    y: 31536000000  // 365 يوم تقريبي
};

function parseDuration(input) {
    const normalized = String(input || '').toLowerCase();
    if (normalized === 'perm' || normalized === 'permanent') {
        return { ms: 0, permanent: true, text: 'permanently' };
    }

    const match = normalized.match(/^(\d+)(s|m|min|h|d|w|mo|y)$/);
    if (!match) return null;

    const amount = parseInt(match[1]);
    const unit = match[2];
    const ms = amount * MS_MAP[unit];

    return { ms, permanent: false, text: `for ${amount}${unit}` };
}

// ----------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------

/**
 * Fetches the open ticket_record row for a channel, plus its associated
 * ticket_type_config row. Two plain separate queries on purpose (not a
 * Supabase embedded/joined select) - this schema's own history shows a
 * PostgREST schema-cache bug already bit this project once, so explicit
 * separate queries are the safer choice here.
 */
async function getTicketContext(channelId) {
    const { data: ticket, error: ticketErr } = await supabase
        .from('ticket_record')
        .select('*')
        .eq('id_channel', channelId)
        .eq('status', 'open')
        .maybeSingle();

    if (ticketErr || !ticket) return { ticket: null, typeConfig: null };

    let typeConfig = null;
    if (ticket.id_type) {
        const { data: type, error: typeErr } = await supabase
            .from('ticket_type_config')
            .select('*')
            .eq('id', ticket.id_type)
            .maybeSingle();

        if (!typeErr) typeConfig = type;
    }

    return { ticket, typeConfig };
}

/**
 * staff_roles = view + control + claim + run commands, all one concept
 * (per the agreed design - there is no separate "viewer" tier).
 * Administrators always bypass this, same spirit as GRS.js's exemption
 * checks living above per-feature role lists.
 */
function isTicketStaff(member, typeConfig) {
    if (!member) return false;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    if (!typeConfig || !Array.isArray(typeConfig.staff_roles)) return false;
    return typeConfig.staff_roles.some(roleId => member.roles.cache.has(roleId));
}

/**
 * Resolves a mention or raw ID into a live GuildMember. Requires an actual
 * fetch to succeed (used for /transfer - the new owner has to be reachable
 * to actually work the ticket).
 */
async function resolveMember(guild, rawArg) {
    if (!rawArg) return null;
    const id = rawArg.replace(/[<@!>]/g, '');
    return guild.members.fetch(id).catch(() => null);
}

/**
 * Resolves a mention or raw ID into either a live GuildMember OR a Role
 * (used for /add and /remove, which accept both per the agreed design).
 * Role lookup is checked first since role IDs are always cache-resident.
 */
async function resolveMemberOrRole(guild, rawArg) {
    if (!rawArg) return { member: null, role: null };
    const id = rawArg.replace(/[<@&!>]/g, '');

    const role = guild.roles.cache.get(id);
    if (role) return { member: null, role };

    const member = await guild.members.fetch(id).catch(() => null);
    return { member, role: null };
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * [TICKET-6] Technical close = permission lock, not deletion.
 * Locks SendMessages for @everyone, the opener, and every staff role for
 * this ticket's type - except the member who currently holds the claim (if
 * any), who keeps SendMessages so they alone can still reply.
 */
async function lockChannelPermissions(channel, ticket, typeConfig) {
    const staffRoles = (typeConfig && Array.isArray(typeConfig.staff_roles)) ? typeConfig.staff_roles : [];

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
        SendMessages: false
    });

    await channel.permissionOverwrites.edit(
        ticket.id_opener,
        { SendMessages: false },
        { type: OverwriteType.Member }
    ).catch(() => {}); // العضو قد يكون غادر السيرفر - نتجاهل الخطأ

    for (const roleId of staffRoles) {
        await channel.permissionOverwrites.edit(
            roleId,
            { SendMessages: false },
            { type: OverwriteType.Role }
        ).catch(() => {}); // الرتبة قد تكون انحذفت من السيرفر لاحقاً
    }

    if (ticket.id_claimed_by) {
        await channel.permissionOverwrites.edit(
            ticket.id_claimed_by,
            { ViewChannel: true, SendMessages: true },
            { type: OverwriteType.Member }
        ).catch(() => {});
    }
}

/**
 * Pulls the channel's full message history (paginated, 100 at a time, up to
 * `cap` messages) and returns it oldest-first.
 */
async function fetchAllMessages(channel, cap = 500) {
    let allMessages = [];
    let lastId = null;

    while (allMessages.length < cap) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        allMessages = allMessages.concat(Array.from(batch.values()));
        lastId = batch.last().id;

        if (batch.size < 100) break;
    }

    return allMessages.reverse(); // من الأقدم للأحدث
}

/**
 * [TICKET-7] Builds a self-contained HTML transcript styled after Discord's
 * dark theme. No DB storage - it's built and sent on the spot, then discarded.
 */
function buildTranscriptHtml(channel, ticket, messages) {
    const rows = messages.map(msg => {
        const author = escapeHtml(msg.author?.tag || 'Unknown User');
        const avatar = msg.author?.displayAvatarURL ? msg.author.displayAvatarURL({ size: 64 }) : '';
        const time = new Date(msg.createdTimestamp).toUTCString();
        const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');

        const attachments = msg.attachments?.size
            ? Array.from(msg.attachments.values())
                .map(att => `<div class="attachment"><a href="${escapeHtml(att.url)}" target="_blank">📎 ${escapeHtml(att.name || 'attachment')}</a></div>`)
                .join('')
            : '';

        return `
        <div class="message">
            <img class="avatar" src="${avatar}" alt="">
            <div class="message-body">
                <div class="message-header">
                    <span class="author">${author}</span>
                    <span class="timestamp">${time}</span>
                </div>
                <div class="content">${content || '<i>[No text content]</i>'}</div>
                ${attachments}
            </div>
        </div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Ticket Transcript - #${escapeHtml(channel.name)}</title>
<style>
    body { background:#313338; color:#dbdee1; font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; margin:0; padding:24px; }
    .transcript-header { border-bottom: 1px solid #3f4147; padding-bottom: 14px; margin-bottom: 18px; }
    .transcript-header h1 { font-size: 22px; margin: 0 0 8px 0; color:#f2f3f5; }
    .transcript-header p { margin: 2px 0; color: #949ba4; font-size: 13px; }
    .message { display:flex; padding:10px 0; border-bottom: 1px solid #2b2d31; }
    .avatar { width:40px; height:40px; border-radius:50%; margin-right:16px; flex-shrink:0; background:#5865f2; }
    .message-header { display:flex; align-items:baseline; gap:8px; }
    .author { font-weight:600; color:#f2f3f5; }
    .timestamp { font-size:11px; color:#949ba4; }
    .content { margin-top:4px; white-space:pre-wrap; word-break: break-word; line-height:1.4; }
    .attachment { margin-top:6px; font-size:13px; }
    .attachment a { color:#00a8fc; text-decoration:none; }
</style>
</head>
<body>
    <div class="transcript-header">
        <h1>#${escapeHtml(channel.name)}</h1>
        <p>Ticket ID: ${escapeHtml(ticket.id)}</p>
        <p>Opened by: &lt;${escapeHtml(ticket.id_opener)}&gt;</p>
        <p>Closed by: &lt;${escapeHtml(ticket.closed_by || '')}&gt;</p>
        <p>Close reason: ${escapeHtml(ticket.close_reason || 'No reason provided')}</p>
        <p>Generated: ${new Date().toUTCString()}</p>
    </div>
    ${rows || '<p style="color:#949ba4;">No messages were sent in this ticket.</p>'}
</body>
</html>`;
}

/**
 * [TICKET-7] Sends the transcript to the log channel and/or the opener's DM,
 * per the two independent toggles in setting_ticket_system.
 *
 * [TICKET-10 - CHANGED] Used to never throw and never report its own
 * success/failure (a transcript delivery failure was never allowed to block
 * the close itself - that part is still true). Now it ALSO returns a status
 * object so the caller (executeClose) can decide whether it's safe to
 * auto-delete the channel afterwards:
 *   - delivered: true  -> every destination that was actually ENABLED
 *                         succeeded (or nothing was enabled at all - there
 *                         was nothing to fail, so it's still safe to delete).
 *   - delivered: false -> at least one enabled destination failed. The
 *                         channel must NOT be auto-deleted in this case.
 * Still never throws - failures are captured into the returned object
 * instead of bubbling up, exactly like before.
 */
async function sendTranscript(guild, channel, ticket) {
    const { data: settings } = await supabase
        .from('setting_ticket_system')
        .select('transcript_channel_id, transcript_channel_enabled, transcript_dm_enabled')
        .eq('id_guild', guild.id)
        .maybeSingle();

    // ما فيه إعدادات محفوظة بعد بالداشبورد - ما فيه شي كان مفعّل أصلاً،
    // فما فيه شي ممكن "يفشل" - آمن نكمل للحذف.
    if (!settings) return { delivered: true, anyEnabled: false };

    const messages = await fetchAllMessages(channel);
    const html = buildTranscriptHtml(channel, ticket, messages);
    const htmlBuffer = Buffer.from(html, 'utf-8');
    const htmlFileName = `transcript-${channel.name}.html`;

    let anyEnabled = false;
    let allEnabledSucceeded = true;

    if (settings.transcript_channel_enabled && settings.transcript_channel_id) {
        anyEnabled = true;
        const logChannel = await guild.channels.fetch(settings.transcript_channel_id).catch(() => null);
        if (!logChannel) {
            allEnabledSucceeded = false;
            console.error('[Ticket Transcript] Configured log channel not found/inaccessible.');
        } else {
            // [NEW] .zip بدل .html خام - يمنع معاينة الكود التلقائية بديسكورد
            // Desktop ويفرض التحميل كملف عادي بكل الأجهزة.
            const zip = new AdmZip();
            zip.addFile(htmlFileName, htmlBuffer);
            const zipBuffer = zip.toBuffer();
            const zipFileName = `transcript-${channel.name}.zip`;

            await logChannel.send({
                content: `📄 Transcript for **#${channel.name}**`,
                files: [new AttachmentBuilder(zipBuffer, { name: zipFileName })]
            }).catch(err => {
                allEnabledSucceeded = false;
                console.error('[Ticket Transcript] Failed to send to log channel:', err.message);
            });
        }
    }

    if (settings.transcript_dm_enabled && ticket.id_opener) {
        anyEnabled = true;
        const opener = await guild.client.users.fetch(ticket.id_opener).catch(() => null);
        if (!opener) {
            allEnabledSucceeded = false;
            console.error('[Ticket Transcript] Could not resolve the ticket opener user.');
        } else {
            // [UNCHANGED] .html خام - تجربة الجوال الحالية شغالة صح، ما لها داعي تتغيّر
            await opener.send({
                content: `📄 Here is the transcript for your ticket **#${channel.name}**.`,
                files: [new AttachmentBuilder(htmlBuffer, { name: htmlFileName })]
            }).catch(err => {
                allEnabledSucceeded = false;
                console.error('[Ticket Transcript] Failed to DM the ticket opener:', err.message);
            });
        }
    }

    return { delivered: !anyEnabled || allEnabledSucceeded, anyEnabled };
}

// ----------------------------------------------------------------------
// 1. CORE LOGIC: executeClaim / executeUnclaim
// ----------------------------------------------------------------------

async function executeClaim(channel, moderator) {
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!isTicketStaff(moderator, typeConfig)) return { success: false, error: "You are not part of this ticket's staff team." };

    if (ticket.id_claimed_by) {
        if (ticket.id_claimed_by === moderator.id) return { success: false, error: "You have already claimed this ticket." };
        return { success: false, error: `This ticket is already claimed by <@${ticket.id_claimed_by}>.` };
    }

    const { error } = await supabase
        .from('ticket_record')
        .update({ id_claimed_by: moderator.id })
        .eq('id', ticket.id);

    if (error) {
        console.error('[Ticket Claim Error]:', error.message);
        return { success: false, error: "Database error while claiming the ticket." };
    }

    // [FIX] الكود القديم كان يحدّث قاعدة البيانات بس، بدون ما يلمس صلاحيات
    // القناة بديسكورد إطلاقاً. نقفل الكتابة عن باقي الطاقم (staff_roles) -
    // العضو صاحب التكت يضل يكتب طبيعي، والـ Claimer نفسه يُستثنى بصلاحية
    // عضو مباشرة (تتغلب على منع الرتبة تلقائياً بديسكورد).
    const staffRoles = (typeConfig && Array.isArray(typeConfig.staff_roles)) ? typeConfig.staff_roles : [];
    for (const roleId of staffRoles) {
        await channel.permissionOverwrites.edit(
            roleId,
            { SendMessages: false },
            { type: OverwriteType.Role }
        ).catch(() => {});
    }
    await channel.permissionOverwrites.edit(
        moderator.id,
        { ViewChannel: true, SendMessages: true },
        { type: OverwriteType.Member }
    ).catch(() => {});

    return { success: true };
}

async function executeUnclaim(channel, moderator) {
    // [FIX] كانت { ticket } بس - محتاجين typeConfig كمان عشان staff_roles
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!ticket.id_claimed_by) return { success: false, error: "This ticket is not claimed by anyone." };

    const isAdmin = moderator.permissions.has(PermissionsBitField.Flags.Administrator);
    if (ticket.id_claimed_by !== moderator.id && !isAdmin) {
        return { success: false, error: "Only the staff member who claimed this ticket (or an admin) can unclaim it." };
    }

    const previousClaimerId = ticket.id_claimed_by;

    const { error } = await supabase
        .from('ticket_record')
        .update({ id_claimed_by: null })
        .eq('id', ticket.id);

    if (error) {
        console.error('[Ticket Unclaim Error]:', error.message);
        return { success: false, error: "Database error while unclaiming the ticket." };
    }

    // [FIX] نفس سبب executeClaim - نفتح الكتابة لباقي الطاقم من جديد
    // (نمسح المنع الصريح عن الرتب - SendMessages: null يرجّعها للوضع
    // الافتراضي الموروث)، ونشيل صلاحية العضو الخاصة بالـ Claimer السابق
    // (ما عادت لها داعي بعد الفكّ).
    const staffRoles = (typeConfig && Array.isArray(typeConfig.staff_roles)) ? typeConfig.staff_roles : [];
    for (const roleId of staffRoles) {
        await channel.permissionOverwrites.edit(
            roleId,
            { SendMessages: null },
            { type: OverwriteType.Role }
        ).catch(() => {});
    }
    await channel.permissionOverwrites.delete(previousClaimerId).catch(() => {});

    return { success: true };
}

// ----------------------------------------------------------------------
// 2. CORE LOGIC: executeTransfer
// ----------------------------------------------------------------------
// [TICKET-4] Moves ownership of the claim entirely to another staff member.
// The new owner must also qualify as ticket staff - transferring ownership
// to a random member (e.g. the ticket opener themself) is rejected.

async function executeTransfer(channel, moderator, newStaffMember) {
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!isTicketStaff(moderator, typeConfig)) return { success: false, error: "You are not part of this ticket's staff team." };
    if (!isTicketStaff(newStaffMember, typeConfig)) return { success: false, error: "The target member is not part of this ticket's staff team." };
    if (newStaffMember.id === ticket.id_claimed_by) return { success: false, error: "This ticket is already claimed by that member." };

    const previousClaimerId = ticket.id_claimed_by;

    const { error } = await supabase
        .from('ticket_record')
        .update({ id_claimed_by: newStaffMember.id })
        .eq('id', ticket.id);

    if (error) {
        console.error('[Ticket Transfer Error]:', error.message);
        return { success: false, error: "Database error while transferring the ticket." };
    }

    // [FIX] نفس السبب - ننقل صلاحية العضو الخاصة من المالك القديم للجديد.
    // staff_roles تضل مقفولة زي ما هي (التكت أصلاً كان مُطالَب فيه Claim).
    if (previousClaimerId) {
        await channel.permissionOverwrites.delete(previousClaimerId).catch(() => {});
    }
    await channel.permissionOverwrites.edit(
        newStaffMember.id,
        { ViewChannel: true, SendMessages: true },
        { type: OverwriteType.Member }
    ).catch(() => {});

    return { success: true };
}

// ----------------------------------------------------------------------
// 3. CORE LOGIC: executeAddTarget / executeRemoveTarget
// ----------------------------------------------------------------------
// [TICKET-5] No DB table for this - applied directly as Discord Permission
// Overwrites on the channel, which is the single source of truth for them.

async function executeAddTarget(channel, moderator, target) {
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!isTicketStaff(moderator, typeConfig)) return { success: false, error: "You are not part of this ticket's staff team." };

    try {
        await channel.permissionOverwrites.edit(target, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        });
        return { success: true };
    } catch (err) {
        console.error('[Ticket Add Error]:', err.message);
        return { success: false, error: "Failed to update channel permissions." };
    }
}

async function executeRemoveTarget(channel, moderator, target) {
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!isTicketStaff(moderator, typeConfig)) return { success: false, error: "You are not part of this ticket's staff team." };

    if (target.id === ticket.id_opener) {
        return { success: false, error: "You cannot remove the ticket opener from their own ticket." };
    }

    try {
        await channel.permissionOverwrites.delete(target);
        return { success: true };
    } catch (err) {
        console.error('[Ticket Remove Error]:', err.message);
        return { success: false, error: "Failed to update channel permissions." };
    }
}

// ----------------------------------------------------------------------
// 4. CORE LOGIC: executeBump
// ----------------------------------------------------------------------

async function executeBump(channel, moderator) {
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!isTicketStaff(moderator, typeConfig)) return { success: false, error: "You are not part of this ticket's staff team." };

    return { success: true, openerId: ticket.id_opener };
}

// ----------------------------------------------------------------------
// 5. CORE LOGIC: executeClose
// ----------------------------------------------------------------------

// [TICKET-10] المدة الثابتة (غير قابلة للتعديل من الداشبورد بقرار صريح)
// بين نجاح إرسال الترانسكربت وحذف القناة فعلياً.
const AUTO_DELETE_DELAY_MS = 10000;

/**
 * [TICKET-10] لو الترانسكربت فشل توصيله (أي وجهة مفعّلة فشلت)، نلغي
 * الحذف التلقائي بالكامل ونرسل تنبيه واضح - داخل قناة التذكرة نفسها،
 * وكمان لروم الترانسكربت المُعرَّف (transcript_channel_id) لو موجود
 * وقابل للوصول، بما إنه أصلاً الروم المخصص لسجلات الطاقم لهذا النظام.
 */
async function notifyTranscriptFailure(guild, channel) {
    const failureMsg = {
        embeds: [
            new EmbedBuilder()
                .setColor('#FFAA00')
                .setTitle('⚠️ Transcript Delivery Failed')
                .setDescription('This channel will **NOT** be auto-deleted. Please save the conversation manually before deleting it yourself.')
        ]
    };

    await channel.send(failureMsg).catch(() => {});

    try {
        const { data: settings } = await supabase
            .from('setting_ticket_system')
            .select('transcript_channel_id, transcript_channel_enabled')
            .eq('id_guild', guild.id)
            .maybeSingle();

        if (settings?.transcript_channel_enabled && settings.transcript_channel_id) {
            const logChannel = await guild.channels.fetch(settings.transcript_channel_id).catch(() => null);
            if (logChannel) {
                await logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('#FFAA00')
                            .setTitle('⚠️ Transcript Delivery Failed')
                            .setDescription(`Could not deliver the transcript for **#${channel.name}** (\`${channel.id}\`). That channel was NOT auto-deleted - it still exists and needs manual review/deletion.`)
                    ]
                }).catch(() => {});
            }
        }
    } catch (err) {
        console.error('[Ticket Close] Failed to send transcript-failure notice to log channel:', err.message);
    }
}

async function executeClose(channel, moderator, reason) {
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!isTicketStaff(moderator, typeConfig)) return { success: false, error: "You are not part of this ticket's staff team." };

    try {
        await lockChannelPermissions(channel, ticket, typeConfig);
    } catch (lockErr) {
        console.error('[Ticket Close] Failed to fully lock channel permissions:', lockErr.message);
    }

    const closedAt = new Date().toISOString();
    const { error } = await supabase
        .from('ticket_record')
        .update({
            status: 'closed',
            closed_at: closedAt,
            closed_by: moderator.id,
            close_reason: reason || null
        })
        .eq('id', ticket.id);

    if (error) {
        console.error('[Ticket Close Error]:', error.message);
        return { success: false, error: "Database error while closing the ticket." };
    }

    // [TICKET-10] الحين لازم نعرف نتيجة الترانسكربت فعلياً (مو بس نحاول
    // ونتجاهل) عشان نقرر هل نحذف القناة تلقائياً بعدها أو لا.
    let transcriptStatus = { delivered: true, anyEnabled: false };
    try {
        transcriptStatus = await sendTranscript(channel.guild, channel, {
            ...ticket,
            close_reason: reason || null,
            closed_by: moderator.id
        });
    } catch (transcriptErr) {
        console.error('[Ticket Transcript Error]:', transcriptErr.message);
        transcriptStatus = { delivered: false, anyEnabled: true };
    }

    if (transcriptStatus.delivered) {
        // [TICKET-10] العدّاد يبدأ بعد التأكد من نجاح الترانسكربت فقط -
        // ما يبدأ بالتوازي معه (يمنع Race Condition لو الإرسال أخذ وقت
        // أطول من 10 ثواني). لا يُنتظر (await) عمداً - executeClose ترجع
        // فوراً حتى يقدر المستدعي (أمر /close أو السكجولر) يكمل عمله
        // (مثل إرسال رسالة "Ticket Closed") قبل ما القناة تنحذف.
        setTimeout(() => {
            channel.delete(`Ticket closed by ${moderator.user?.tag || moderator.tag || moderator.id}: ${reason || 'No reason provided'}`)
                .catch(err => console.error('[Ticket Close] Failed to auto-delete channel:', err.message));
        }, AUTO_DELETE_DELAY_MS);
    } else {
        // [TICKET-10] فشل توصيل الترانسكربت -> لا حذف تلقائي إطلاقاً،
        // القناة تبقى مقفولة بس (رجوع لسلوك TICKET-6 الأصلي بهذي الحالة).
        await notifyTranscriptFailure(channel.guild, channel);
    }

    return { success: true };
}

// ----------------------------------------------------------------------
// 6. CORE LOGIC: executeBlacklist / executeUnblacklist
// ----------------------------------------------------------------------
// [TICKET-3] Global, guild-wide, user-level blacklist - fully independent
// from ticket_type_config.restricted_roles (per-type role restriction).

async function executeBlacklist(guild, targetId, moderator, durationStr, reason) {
    const duration = parseDuration(durationStr || 'permanent');
    if (!duration) return { success: false, error: "Invalid duration format (e.g., 1d, 1w, perm)." };

    const expiresAt = duration.permanent ? null : new Date(Date.now() + duration.ms).toISOString();

    const { error } = await supabase
        .from('ticket_blacklist')
        .upsert({
            id_guild: guild.id,
            id_user: targetId,
            reason: reason || null,
            banned_by: moderator.id,
            expires_at: expiresAt,
            processed: false,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id_guild,id_user' });

    if (error) {
        console.error('[Ticket Blacklist Error]:', error.message);
        return { success: false, error: "Database error while applying the ticket blacklist." };
    }

    return { success: true, durationText: duration.permanent ? 'permanently' : duration.text };
}

async function executeUnblacklist(guild, targetId) {
    const { error } = await supabase
        .from('ticket_blacklist')
        .delete()
        .eq('id_guild', guild.id)
        .eq('id_user', targetId);

    if (error) {
        console.error('[Ticket Unblacklist Error]:', error.message);
        return { success: false, error: "Database error while removing the ticket blacklist." };
    }

    return { success: true };
}

// ----------------------------------------------------------------------
// 7. CORE LOGIC: executeRename
// ----------------------------------------------------------------------
// Pure Discord-side action (channel.setName) - ticket_record has no display
// name column to keep in sync, so nothing to update in the database here.

async function executeRename(channel, moderator, newName) {
    const { ticket, typeConfig } = await getTicketContext(channel.id);
    if (!ticket) return { success: false, error: "This channel is not an active ticket." };
    if (!isTicketStaff(moderator, typeConfig)) return { success: false, error: "You are not part of this ticket's staff team." };

    if (!newName || newName.trim().length === 0) {
        return { success: false, error: "Please provide a new channel name." };
    }

    try {
        await channel.setName(newName.trim().slice(0, 100), `Renamed by ${moderator.user.tag}`);
        return { success: true };
    } catch (err) {
        console.error('[Ticket Rename Error]:', err.message);
        return { success: false, error: "Failed to rename the channel (rate limit or invalid characters)." };
    }
}

// ----------------------------------------------------------------------
// 8. PREFIX HANDLER (Auto-Loading Entry Point)
// ----------------------------------------------------------------------

async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    const channel = message.channel;
    const moderator = message.member;
    const guild = message.guild;

    switch (command) {
        case 'claim': {
            const result = await executeClaim(channel, moderator);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'claim', channelId: channel.id, rawMessage: message.content
            });

            return message.channel.send({
                embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`🙋 Ticket claimed by **${moderator.user.tag}**.`)]
            });
        }

        case 'unclaim': {
            const result = await executeUnclaim(channel, moderator);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'unclaim', channelId: channel.id, rawMessage: message.content
            });

            return message.channel.send({
                embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`🙅 Ticket unclaimed by **${moderator.user.tag}**.`)]
            });
        }

        case 'transfer': {
            const targetMember = await resolveMember(guild, args[0]);
            if (!targetMember) return message.reply("⚠️ Usage: `transfer @staff_member`");

            const result = await executeTransfer(channel, moderator, targetMember);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'transfer', channelId: channel.id, rawMessage: message.content
            });

            return message.channel.send({
                embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(`🔄 Ticket transferred from **${moderator.user.tag}** to **${targetMember.user.tag}**.`)]
            });
        }

        case 'add': {
            const { member: targetMember, role: targetRole } = await resolveMemberOrRole(guild, args[0]);
            const target = targetMember || targetRole;
            if (!target) return message.reply("⚠️ Usage: `add @user` or `add @role`");

            const result = await executeAddTarget(channel, moderator, target);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'ticket-add', channelId: channel.id, rawMessage: message.content
            });

            const label = targetMember ? targetMember.user.tag : `@${targetRole.name}`;
            return message.channel.send({
                embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`➕ **${label}** was added to this ticket by **${moderator.user.tag}**.`)]
            });
        }

        case 'remove': {
            const { member: targetMember, role: targetRole } = await resolveMemberOrRole(guild, args[0]);
            const target = targetMember || targetRole;
            if (!target) return message.reply("⚠️ Usage: `remove @user` or `remove @role`");

            const result = await executeRemoveTarget(channel, moderator, target);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'ticket-remove', channelId: channel.id, rawMessage: message.content
            });

            const label = targetMember ? targetMember.user.tag : `@${targetRole.name}`;
            return message.channel.send({
                embeds: [new EmbedBuilder().setColor('#ED4245').setDescription(`➖ **${label}** was removed from this ticket by **${moderator.user.tag}**.`)]
            });
        }

        case 'bump':
        case 'ping-user': {
            const result = await executeBump(channel, moderator);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'bump', channelId: channel.id, rawMessage: message.content
            });

            return message.channel.send(`🔔 <@${result.openerId}>, are you still there? We're waiting for your reply.`);
        }

        case 'close': {
            const reason = args.join(' ') || 'No reason provided';
            const result = await executeClose(channel, moderator, reason);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'close', channelId: channel.id, rawMessage: message.content
            });

            return message.channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#ED4245')
                        .setTitle('🔒 Ticket Closed')
                        .setDescription(`Closed by **${moderator.user.tag}**\n**Reason:** ${reason}`)
                ]
            });
        }

        case 'ticket-blacklist': {
            if (!moderator.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                return message.reply("❌ You lack the required permission (Moderate Members) to use this command.");
            }

            const targetId = args[0]?.replace(/[<@!>]/g, '');
            if (!targetId) return message.reply("⚠️ Usage: `ticket-blacklist @user [duration] <reason>`");

            let durationArg = args[1];
            let reasonArgs = args.slice(2);
            if (!parseDuration(durationArg || '')) {
                reasonArgs = args.slice(1);
                durationArg = 'permanent';
            }
            const reason = reasonArgs.join(' ') || 'No reason provided';

            const result = await executeBlacklist(guild, targetId, moderator, durationArg, reason);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'ticket-blacklist', channelId: channel.id, rawMessage: message.content
            });

            return message.channel.send({
                embeds: [new EmbedBuilder().setColor('#ED4245').setDescription(`🚫 <@${targetId}> is now blacklisted from opening tickets **${result.durationText}**.\n**Reason:** ${reason}`)]
            });
        }

        case 'ticket-unblacklist': {
            if (!moderator.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                return message.reply("❌ You lack the required permission (Moderate Members) to use this command.");
            }

            const targetId = args[0]?.replace(/[<@!>]/g, '');
            if (!targetId) return message.reply("⚠️ Usage: `ticket-unblacklist @user`");

            const result = await executeUnblacklist(guild, targetId);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'ticket-unblacklist', channelId: channel.id, rawMessage: message.content
            });

            return message.channel.send({
                embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`✅ <@${targetId}> can now open tickets again.`)]
            });
        }

        case 'rename': {
            const newName = args.join(' ');
            const result = await executeRename(channel, moderator, newName);
            if (!result.success) return message.reply(`❌ ${result.error}`);

            await dbUtils.logCommand({
                guildId: guild.id, userId: moderator.id, username: moderator.user.tag,
                commandName: 'rename', channelId: channel.id, rawMessage: message.content
            });

            return; // Discord نفسه يعرض تغيير اسم القناة تلقائياً - ما نحتاج رسالة إضافية
        }

        default:
            return false;
    }
}

module.exports = {
    name: 'claim',
    description: "Ticket System - claim/transfer ownership, add/remove viewers, bump, close, and manage the ticket blacklist.",
    aliases: [
        'unclaim', 'transfer', 'add', 'remove',
        'bump', 'ping-user', 'close',
        'ticket-blacklist', 'ticket-unblacklist', 'rename'
    ],
    run,
    // Reusable core logic - callable from a slash-command bridge later,
    // same pattern as ban.js's exported executeBan / executeUnban.
    executeClaim,
    executeUnclaim,
    executeTransfer,
    executeAddTarget,
    executeRemoveTarget,
    executeBump,
    executeClose,
    executeBlacklist,
    executeUnblacklist,
    executeRename,
    // Helpers other future ticket files (scheduler / auto-respond) will need
    isTicketStaff,
    getTicketContext
};