// ============================================================================
// ban.js - Universal Ban/Unban System (v4.1 - FIXED Syntax & Persistence)
// ============================================================================
// Supports: Prefix, Slash (via Bridge), and AutoMod.
// Database: Integrated with log_moderation, log_command_bot, and temp_actions.
// ============================================================================

const { PermissionsBitField, EmbedBuilder } = require('discord.js');

// Time constants in milliseconds
const MS_MAP = {
    s: 1000,
    m: 60000,
    min: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000
};

/**
 * 1. CORE LOGIC: executeBan
 * Can be called by Prefix, Slash, or AutoMod.
 */
async function executeBan(guild, targetId, moderator, durationStr, reason, dbUtils, channel = null) {
    try {
        const targetMember = await guild.members.fetch(targetId).catch(() => null);
        const botMember = guild.members.me;

        // --- A) VALIDATIONS ---
        if (!targetMember) return { success: false, error: "User not found in this server." };
        
        // حفظ التاق قبل الحظر لضمان توفره في الـ Return والـ Database
        const targetTag = targetMember.user.tag;

        if (targetId === moderator.id) return { success: false, error: "You cannot ban yourself." };
        if (targetId === guild.ownerId) return { success: false, error: "You cannot ban the server owner." };
        
        // Hierarchy Check: Is moderator higher than target?
        if (moderator.id !== guild.ownerId && moderator.roles.highest.position <= targetMember.roles.highest.position) {
            return { success: false, error: "Your role is not high enough to ban this member." };
        }

        // Bot Permission Check: Is bot higher than target?
        if (botMember.roles.highest.position <= targetMember.roles.highest.position) {
            return { success: false, error: "My role is lower than the target member's role." };
        }

        // --- B) DURATION PARSING ---
        const duration = parseDuration(durationStr);
        if (!duration) return { success: false, error: "Invalid duration format (e.g., 1d, 1w, perm)." };

        // --- C) EXECUTION ---
        const banReason = `${reason} | Banned by: ${moderator.tag}`;
        await targetMember.ban({ reason: banReason });

        // --- D) DATABASE LOGGING (Smart Binding) ---
        
        // 1. Log to log_moderation
        const durationMinutes = duration.permanent ? null : Math.round(duration.ms / 60000);
        await dbUtils.addInfraction(
            guild.id, 
            targetId, 
            moderator.id, 
            'ban', 
            reason, 
            durationMinutes,
            targetTag
        );

        // 2. If temporary, save to temp_actions for persistence
        if (!duration.permanent) {
            const endsAt = new Date(Date.now() + duration.ms).toISOString();
            // استخدام supabase مباشرة للإضافة لأنها عملية Insert وليست Update
            const supabase = require('../supabase/db');
            await supabase.from('temp_actions').insert({
                id_guild: guild.id,
                id_user: targetId,
                action_type: 'ban',
                ends_at: endsAt,
                processed: false
            }).catch(err => console.error('[DB Error] Temp-ban insert failed:', err.message));
        }

        // [Admin Protection] تتبع عدد إجراءات الحظر المتتالية من هذا المشرف
        // (حماية ضد اختراق حساب أدمن - راجع AutoMod.js: trackAdminAction)
        try {
            const AutoMod = require('./AutoMod');
            await AutoMod.trackAdminAction(guild, moderator, 'ban');
        } catch (e) {
            console.error('[Admin Protection] trackAdminAction failed:', e.message);
        }

        // إرجاع النتيجة بنجاح باستخدام التاق المحفوظ مسبقاً
        return { success: true, targetTag: targetTag, durationText: duration.text };

    } catch (err) {
        console.error('[Ban Engine Error]:', err);
        return { success: false, error: "Internal error during ban execution." };
    }
}

/**
 * 2. CORE LOGIC: executeUnban
 */
async function executeUnban(guild, targetId, moderator, reason, dbUtils) {
    try {
        await guild.members.unban(targetId, `Unbanned by: ${moderator.tag} | Reason: ${reason}`);

        // Log to database
        await dbUtils.addInfraction(guild.id, targetId, moderator.id, 'unban', reason);

        return { success: true };
    } catch (err) {
        return { success: false, error: "User is not banned or ID is invalid." };
    }
}

/**
 * 3. PREFIX HANDLER (Auto-Loading Entry Point)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase(); // 'ban' or 'unban'

    // Permission Check (Discord Native)
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply("❌ You lack 'Ban Members' permission.");
    }

    if (command === 'ban') {
        const targetArg = args[0];

        if (!targetArg) {
            return message.reply("⚠️ Usage: `ban @user [duration/perm] <reason>`");
        }

        // [FIX] المدة صارت اختيارية. لو الكلمة الثانية "perm"/"permanent" أو تطابق
        // صيغة مدة صحيحة (1d, 2w, 12h...) نستخدمها كما هي. غير كذا (أو مو موجودة
        // أصلاً) نعتبرها جزء من السبب مباشرة، والحظر يصير دائم افتراضياً.
        let durationArg = args[1];
        let reasonArgs = args.slice(2);

        if (!parseDuration(durationArg || '')) {
            reasonArgs = args.slice(1);
            durationArg = 'permanent';
        }

        const reason = reasonArgs.join(' ') || "No reason provided";

        const targetId = targetArg.replace(/[<@!>]/g, '');
        const result = await executeBan(message.guild, targetId, message.author, durationArg, reason, dbUtils);

        if (result.success) {
            // Log Command Usage (Smart Binding)
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag,
                commandName: 'ban',
                channelId: message.channel.id,
                rawMessage: message.content
            });

            // Index the message for future reference
            await dbUtils.addLogIndex(message.guild.id, message.id, message.channel.id, targetId, 'ban');

            return message.reply(`✅ **${result.targetTag}** has been banned (${result.durationText}).\n📝 Reason: ${reason}`);
        } else {
            return message.reply(`❌ Error: ${result.error}`);
        }
    }

    if (command === 'unban') {
        const targetId = args[0];
        const reason = args.slice(1).join(' ') || "No reason provided";

        if (!targetId) return message.reply("⚠️ Usage: `unban <user_id> <reason>`");

        const result = await executeUnban(message.guild, targetId, message.author, reason, dbUtils);
        if (result.success) {
            return message.reply(`✅ User \`${targetId}\` has been unbanned.`);
        } else {
            return message.reply(`❌ Error: ${result.error}`);
        }
    }
}

// --- HELPERS ---

function parseDuration(input) {
    const normalized = input.toLowerCase();
    if (normalized === 'perm' || normalized === 'permanent') return { ms: 0, permanent: true, text: 'permanently' };

    const match = normalized.match(/^(\d+)(s|m|min|h|d|w)$/);
    if (!match) return null;

    const amount = parseInt(match[1]);
    const unit = match[2];
    const ms = amount * MS_MAP[unit];

    return { 
        ms, 
        permanent: false, 
        text: `for ${amount}${unit}` 
    };
}

module.exports = {
  name: 'ban',
  description: 'Bans a member from the server (Supports temp-ban)',
  permissions: [PermissionsBitField.Flags.BanMembers],
  aliases: ['unban'], // <-- تضاف هنا داخل الكائن بنفس طريقة باقي الخصائص
  executeBan,
  executeUnban,
  run
};
