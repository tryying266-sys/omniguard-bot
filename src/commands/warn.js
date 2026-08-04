// ============================================================================
// warn.js - Universal Warning & Escalation System (v4.6 - Two-Tier Escalation)
// ============================================================================
// Supports: Prefix, Slash (via Bridge), and AutoMod.
// Features: Auto-Punishment Escalation based on Database Settings.
//
// -----------------------------------------------------------------------------
// سجل التعديلات (v4.5 -> v4.6) - التعديل الوحيد بهذا الملف كان داخل قسم
// "C) ESCALATION LOGIC" بدالة executeWarn، الباقي (executeUnwarn, run,
// الـ helpers, module.exports) لم يُلمس إطلاقاً:
//
// [FIX] التصعيد سابقاً كان يستخدم `count >= limit_trigger_warn` فقط (طبقة
//       وحدة). المشكلة: بعد ما يتجاوز العضو الحد، كل تحذير جديد كان يعيد
//       تفعيل نفس العقوبة من جديد (ميوت/طرد/باند متكرر بدون داعٍ).
// [NEW] أضفت طبقة تصعيد ثانية (Tier 2 / "Severe") تُقرأ من 3 أعمدة جديدة
//       بجدول setting_moderation_security (أضفتها بملف الـ SQL):
//       limit_trigger_severe, severe_trigger_action, severe_trigger_duration
//       مثال يطابق طلبك بالضبط: المشرف يحدد 3 تحذيرات = ميوت (الطبقة
//       الأولى الموجودة أصلاً)، و 6 تحذيرات = طرد (الطبقة الثانية الجديدة).
// [FIX] كل طبقة تُفعَّل مرة واحدة فقط بالضبط لما العدّاد يساوي حدّها
//       (count === threshold) بدل "أكبر من أو يساوي" - هذا يمنع تكرار
//       نفس العقوبة على كل تحذير لاحق، ويضمن عدم القفز لطبقة تالية إلا
//       بعد الوصول لعتبتها بالضبط، تماماً كما طلبت.
// [ملاحظة] لو المشرف ما فعّل الطبقة الثانية (limit_trigger_severe فارغة/
//          NULL بقاعدة البيانات)، يبقى السلوك القديم (طبقة واحدة فقط)
//          يعمل بالضبط كما كان - لا يتأثر أي سيرفر لم يُفعّلها.
// -----------------------------------------------------------------------------

const { PermissionsBitField, EmbedBuilder } = require('discord.js');

/**
 * [v5.3 REWRITE] يستبدل determineEscalationTier() الثابتة القديمة (كانت
 * تقرأ عمودين ثابتين limit_trigger_warn/limit_trigger_severe بس - طبقتين
 * كحد أقصى). الآن تقرأ من auto_mod_rule_config (rule_type='warn') - عدد
 * غير محدود من القواعد، كل وحدة (عتبة → أكشن → مدة) مستقلة.
 *
 * [سلوك محفوظ من القديم] مساواة تامة (threshold === count) مو `>=` - كل
 * قاعدة تتفعّل مرة وحدة بالضبط عند الوصول لعتبتها بالضبط. القيد
 * UNIQUE(id_guild, rule_type, threshold) بالسكيما يضمن عدم وجود أكثر من
 * قاعدة مطابقة لنفس العدد أصلاً.
 *
 * يرجع null لو ما فيه قاعدة تطابق هذا العدد بالضبط.
 * @param {string} guildId
 * @param {number} count - عدد التحذيرات الحالي للعضو
 * @param {Object} dbUtils
 */
async function findMatchingWarnRule(guildId, count, dbUtils) {
    const rules = await dbUtils.getAutoModRules(guildId, 'warn');
    const matched = rules.find(r => r.threshold === count);
    if (!matched) return null;

    return {
        label: `Warn Rule (${matched.threshold} warnings)`,
        action: matched.action, // mute | kick | ban
        duration: matched.duration || '12h'
    };
}

/**
 * 1. CORE LOGIC: executeWarn
 * Adds a warning and checks if escalation (Auto-Punishment) is needed.
 */
async function executeWarn(guild, targetId, moderator, reason, dbUtils) {
    try {
        const targetMember = await guild.members.fetch(targetId).catch(() => null);
        const supabase = require('../supabase/db'); // استدعاء مباشر للعمليات المتقدمة
        
        // --- A) VALIDATIONS ---
        if (!targetMember) return { success: false, error: "User not found in this server." };
        if (targetId === moderator.id) return { success: false, error: "You cannot warn yourself." };
        
        const targetTag = targetMember.user.tag;

        // Hierarchy Check
        if (moderator.id !== guild.ownerId && moderator.roles.highest.position <= targetMember.roles.highest.position) {
            return { success: false, error: "Your role is not high enough to warn this member." };
        }

        // جلب إعدادات الحماية مبكراً - نحتاجها لفحص الإعفاء قبل أي تسجيل،
        // ولاحقاً لمنطق التصعيد ببند C (بدل جلبها مرتين).
        const settings = await dbUtils.universalGet('setting_moderation_security', guild.id);

        // [NEW] roles_exempt_warn: رتب معفاة كلياً من التحذير تحديداً. مختلف
        // عن isMemberCommandExempt بـ commandhandler.js (ذاك يفحص
        // roles_exempt_commands من setting_guild - إعفاء عام من كل الأوامر).
        const exemptRoles = settings?.roles_exempt_warn || [];
        if (exemptRoles.length > 0 && targetMember.roles.cache.some(role => exemptRoles.includes(role.id))) {
            return { success: false, error: "This member's role is exempt from warnings." };
        }

        // --- B) DATABASE LOGGING ---
        
        // 1. إضافة التحذير لجدول warning_active
        await dbUtils.addWarning(guild.id, targetId, reason, moderator.id, null);

        // 2. تسجيل العملية في سجلات الموديريشن العامة
        await dbUtils.addInfraction(
            guild.id, 
            targetId, 
            moderator.id, 
            'warn', 
            reason, 
            null, 
            targetTag
        );

        // --- C) ESCALATION LOGIC (تصعيد العقوبات - طبقتان) ---
        
        // 1. حساب عدد التحذيرات الحالية للعضو من قاعدة البيانات
        const { count, error: countError } = await supabase
            .from('warning_active')
            .select('*', { count: 'exact', head: true })
            .eq('id_guild', guild.id)
            .eq('id_user', targetId);

        let escalationTriggered = false;
        let escalationAction = "";

        // [v5.3 REWRITE] تحديد الطبقة المناسبة من auto_mod_rule_config (لو
        // فيه) - تُفعَّل مرة واحدة بالضبط عند كل عتبة. راجع findMatchingWarnRule
        // بالأعلى لشرح الاستبدال الكامل لنظام Tier1/Tier2 الثابت القديم.
        const tier = await findMatchingWarnRule(guild.id, count, dbUtils);

        if (tier) {
            escalationTriggered = true;
            escalationAction = tier.action;
            const duration = tier.duration;

            // تنفيذ العقوبة بناءً على الإعدادات
            if (escalationAction === 'mute') {
                const ms = parseDurationToMs(duration);
                await targetMember.timeout(ms, `Escalation (${tier.label}): Reached ${count} warnings.`);
                await recordTempAction(guild.id, targetId, 'mute', ms, supabase);
            } 
            else if (escalationAction === 'kick') {
                await targetMember.kick(`Escalation (${tier.label}): Reached ${count} warnings.`);
            } 
            else if (escalationAction === 'ban') {
                await targetMember.ban({ reason: `Escalation (${tier.label}): Reached ${count} warnings.` });
                const ms = parseDurationToMs(duration);
                await recordTempAction(guild.id, targetId, 'ban', ms, supabase);
            }

            // تسجيل العقوبة الكبرى في السجلات
            await dbUtils.addInfraction(guild.id, targetId, moderator.id, escalationAction, `Auto-Escalation (${tier.label}): Reached ${count} warnings limit.`, duration, targetTag);

            // [NEW v5.3] تصعيد متسلسل: لو العقوبة الناتجة عن قاعدة التحذير
            // نفسها 'mute' أو 'kick'، نفحص فوراً لو وصلت لعتبة قاعدة مسجّلة
            // بنفس ذاك النوع بجدول auto_mod_rule_config (مثال: تحذير رقم 5
            // يطبّق ميوت، ولو صار هذا هو الميوت السادس للعضو وعندك قاعدة
            // "بعد 6 ميوتات = طرد"، تتفعّل بنفس اللحظة). lazy-require بنفس
            // فلسفة استدعاء executeWarn من AutoMod.js بالاتجاه المعاكس -
            // يتفادى مشاكل ترتيب تحميل الملفات (warn.js <-> AutoMod.js).
            if (escalationAction === 'mute' || escalationAction === 'kick') {
                try {
                    const AutoMod = require('./AutoMod');
                    await AutoMod.checkRuleEscalation(guild, targetMember, targetMember.user, escalationAction);
                } catch (chainErr) {
                    console.error('[Warn Engine] Chained escalation via AutoMod failed:', chainErr.message);
                }
            }
        }

        // [REMOVED] كان هنا DM "You have been warned" - أُزيل بطلب صريح.
        // التسجيل بقاعدة البيانات (من حذّر، السبب، الوقت، التصعيد لو صار)
        // يبقى كامل بقسم B أعلاه + قسم التصعيد - بس العضو ما يوصله إشعار مباشر بعد الآن.
        return { 
            success: true, 
            targetTag: targetTag, 
            currentWarnings: count, 
            escalated: escalationTriggered, 
            action: escalationAction 
        };

    } catch (err) {
        console.error('[Warn Engine Error]:', err);
        return { success: false, error: "Internal error during warning execution." };
    }
}

/**
 * 2. CORE LOGIC: executeUnwarn
 */
async function executeUnwarn(guild, targetId, moderator, reason, dbUtils) {
    try {
        const supabase = require('../supabase/db');
        
        // جلب آخر تحذير لحذفه
        const { data: lastWarn, error: fetchError } = await supabase
            .from('warning_active')
            .select('id')
            .eq('id_guild', guild.id)
            .eq('id_user', targetId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (!lastWarn) return { success: false, error: "User has no active warnings." };

        // حذف التحذير
        await supabase.from('warning_active').delete().eq('id', lastWarn.id);

        // تسجيل العملية
        await dbUtils.addInfraction(guild.id, targetId, moderator.id, 'unwarn', `Unwarn: ${reason}`, null);

        return { success: true };
    } catch (err) {
        console.error('[Unwarn Engine Error]:', err);
        return { success: false, error: "Failed to remove warning." };
    }
}

/**
 * 3. ENTRY POINT: run
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply("❌ You lack 'Moderate Members' permission.");
    }

    if (command === 'warn') {
        const targetArg = args[0];
        const reason = args.slice(1).join(' ') || "No reason provided";
        if (!targetArg) return message.reply("⚠️ Usage: `warn @user <reason>`");

        const targetId = targetArg.replace(/[<@!>]/g, '');
        const result = await executeWarn(message.guild, targetId, message.author, reason, dbUtils);

        if (result.success) {
            await dbUtils.logCommand({
                guildId: message.guild.id, userId: message.author.id, username: message.author.tag,
                commandName: 'warn', channelId: message.channel.id, rawMessage: message.content
            });
            await dbUtils.addLogIndex(message.guild.id, message.id, message.channel.id, targetId, 'warn');

            let response = `✅ **${result.targetTag}** has been warned. (Total: ${result.currentWarnings})`;
            if (result.escalated) response += `\n🚫 **Escalation:** User reached the limit and was **${result.action}ed**!`;
            return message.reply(response);
        } else {
            return message.reply(`❌ Error: ${result.error}`);
        }
    }

    if (command === 'unwarn') {
        const targetArg = args[0];
        const reason = args.slice(1).join(' ') || "Warning removed by staff";
        if (!targetArg) return message.reply("⚠️ Usage: `unwarn @user <reason>`");

        const targetId = targetArg.replace(/[<@!>]/g, '');
        const result = await executeUnwarn(message.guild, targetId, message.author, reason, dbUtils);

        if (result.success) {
            return message.reply(`✅ Successfully removed the latest warning for <@${targetId}>.`);
        } else {
            return message.reply(`❌ Error: ${result.error}`);
        }
    }
}

// --- HELPERS ---

function parseDurationToMs(duration) {
    const amount = parseInt(duration);
    const unit = duration.replace(/[0-9]/g, '').trim().toLowerCase();
    const map = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
    return amount * (map[unit] || 3600000);
}

async function recordTempAction(guildId, userId, type, ms, supabase) {
    const endsAt = new Date(Date.now() + ms).toISOString();
    await supabase.from('temp_actions').insert({
        id_guild: guildId, id_user: userId, action_type: type, ends_at: endsAt, processed: false
    }).catch(() => {});
}

// warn.js

module.exports = {
    name: 'warn',
    description: 'Manage server warnings with two-tier auto-escalation',
    aliases: ['unwarn'], // <-- أضفها هنا داخل الكائن
    permissions: [PermissionsBitField.Flags.ModerateMembers],
    executeWarn,
    executeUnwarn,
    run
};