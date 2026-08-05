/**
 * OmniGuard - Command Notifications Module (v5.3 NEW)
 * ============================================================================
 * ينفّذ فعلياً خانتي "Notify via DM" و "Notify in Channel" بالداشبورد
 * (auto-mod.html -> notify_command_dm / notify_command_channel، عمودين
 * جديدين بجدول setting_guild - راجع دلتا السكيما v5.3). كانتا موجودتين
 * بالواجهة فقط بدون أي تنفيذ خلفي قبل هذا الملف.
 *
 * الاستخدام: يُستدعى بعد نجاح أي عقوبة فعلية وبعد تسجيلها بـ
 * dbUtils.addInfraction مباشرة، من أي ملف أمر (mute.js, kick.js, ban.js,
 * warn.js, unmute.js, unban.js, unwarn.js) أو من AutoMod.js نفسه:
 *
 *   const { notifyCommandExecution } = require('./commandNotifications');
 *   await notifyCommandExecution({
 *       guild,               // Guild
 *       targetMember,        // GuildMember (العضو المستهدف بالعقوبة)
 *       moderator,           // User أو GuildMember (المشرف المنفّذ، أو client.user لو تلقائي)
 *       channel,             // TextChannel اللي نُفّذ فيها الأمر (اختياري - null يعطّل Notify in Channel بس)
 *       action,              // 'mute' | 'kick' | 'ban' | 'warn' | 'unmute' | 'unban' | 'unwarn' | 'demote'
 *       reason,              // TEXT
 *       duration              // TEXT أو null (يظهر بالرسالة بس لو موجود)
 *   });
 *
 * ملاحظة: بدون عمودي notify_command_dm / notify_command_channel بجدول
 * setting_guild، universalGet ترجعهم undefined وتُعامل تلقائياً كـ false -
 * يعني الدالة تكتفي بالرجوع بدون أي إرسال (fail-safe، ما ترمي خطأ).
 * ============================================================================
 */

const { EmbedBuilder } = require('discord.js');
const dbUtils = require('../supabase/dbUtils');
const { universalGet } = dbUtils;

const ACTION_LABELS = {
    mute: 'Muted',
    kick: 'Kicked',
    ban: 'Banned',
    warn: 'Warned',
    unmute: 'Unmuted',
    unban: 'Unbanned',
    unwarn: 'Warning Removed',
    demote: 'Demoted',
    delete: 'Messages Deleted',
    roleadd: 'Role Added',
    roleremove: 'Role Removed'
};

const ACTION_COLORS = {
    mute: 0xf5a623,
    kick: 0xe67e22,
    ban: 0xe74c3c,
    warn: 0xf1c40f,
    unmute: 0x2ecc71,
    unban: 0x2ecc71,
    unwarn: 0x2ecc71,
    demote: 0xe67e22,
    delete: 0x95a5a6,
    roleadd: 0x3498db,
    roleremove: 0xe74c3c
};

/**
 * مجموع تحذيرات العضو النشطة حالياً - تُحسب بس لما action === 'warn'،
 * عشان الرسالة توريه "مجموع تحذيراته" مثل ما طُلب. لو الاستعلام فشل لأي
 * سبب، نرجع null والحقل يُترك خارج الـ Embed بدل ما نكسر الإشعار كامل.
 */
async function getActiveWarningCount(guildId, userId) {
    try {
        const supabase = require('../supabase/db');
        const { count, error } = await supabase
            .from('warning_active')
            .select('id', { count: 'exact', head: true })
            .eq('id_guild', guildId)
            .eq('id_user', userId);

        if (error || count == null) return null;
        return count;
    } catch {
        return null;
    }
}

/**
 * ينشئ ويرسل إشعار DM و/أو Channel حسب إعدادات السيرفر (setting_guild).
 * ما يرمي أي خطأ للخارج - كل فشل (DM مقفل، صلاحية ناقصة بالقناة، ...) يُبتلع
 * بصمت عشان ما يوقف تنفيذ العقوبة نفسها اللي أصلاً صارت بنجاح.
 */
async function notifyCommandExecution({ guild, targetMember, moderator, channel = null, action, reason, duration = null }) {
    if (!guild || !targetMember || !action) return;

    const settings = await universalGet('setting_guild', guild.id);
    if (!settings) return;

    const wantsDm = !!settings.notify_command_dm;
    const wantsChannel = !!settings.notify_command_channel && !!channel;
    if (!wantsDm && !wantsChannel) return; // لا شي مفعّل - ما نكمل حتى نبني الـ Embed

    const label = ACTION_LABELS[action] || action;
    const color = ACTION_COLORS[action] || 0x5865f2;
    const moderatorTag = moderator?.tag || moderator?.user?.tag || moderator?.username || 'OmniGuard';
    const targetUser = targetMember.user || targetMember;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`You have been ${label} in ${guild.name}`)
        .addFields({ name: 'Moderator', value: String(moderatorTag), inline: true });

    if (duration) embed.addFields({ name: 'Duration', value: String(duration), inline: true });
    if (reason) embed.addFields({ name: 'Reason', value: String(reason) });

    // [مطلوب] لو تحذير: نضيف مجموع تحذيراته الحالية
    if (action === 'warn') {
        const total = await getActiveWarningCount(guild.id, targetUser.id);
        if (total !== null) {
            embed.addFields({ name: 'Total Active Warnings', value: String(total), inline: true });
        }
    }

    embed.setTimestamp();

    if (wantsDm) {
        const dmTarget = typeof targetMember.send === 'function' ? targetMember : targetUser;
        await dmTarget.send({ embeds: [embed] }).catch(() => {
            // DM مقفل من العضو - سلوك متوقع تماماً، نتجاهل بصمت بدون تسجيل خطأ
        });
    }

    if (wantsChannel) {
        const channelEmbed = EmbedBuilder.from(embed).setTitle(`${targetUser.tag || targetUser.username} has been ${label}`);
        await channel.send({ embeds: [channelEmbed] }).catch(() => {});
    }
}

module.exports = { notifyCommandExecution };