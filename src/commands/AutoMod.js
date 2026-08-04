/**
 * OmniGuard - AutoMod Module (v5.0)
 * Logic: Smart Binding & Universal Engine Integration
 * Features: Spam, Bad Words (Smart), Link/Invite/Mention Block, Admin Protection,
 *           Role Persistence, Real-Duration Mute, Real Role Demotion.
 *
 * ============================================================================
 * سجل التعديلات (v4.x -> v5.0) - كل تعديل موضح هنا وأيضاً بمكانه بالكود:
 * ============================================================================
 * [BUG حرج] كان الاستيراد `const { logModeration } = require('../supabase/databaseQueries')`
 *           خاطئ - الدالة الفعلية بذاك الملف اسمها `logModerationAction` وتوقيعها
 *           كائن (object) وليس معاملات مرتبة. النتيجة: `logModeration` كانت
 *           `undefined` وأي استدعاء لها يرمي خطأ يُبتلع بالـ catch بصمت.
 *           عملياً: كل عملية تسجيل بجدول log_moderation كانت تفشل دائماً،
 *           وحالة 'warn' بالذات كانت تفشل بالكامل (لا رسالة، لا تسجيل) لأن
 *           الاستدعاء الفاشل كان أول سطر بالـ case. تم الإصلاح باستخدام
 *           dbUtils.addInfraction (نفس الدالة المستخدمة بباقي ملفات الأوامر).
 * [FIX #4] الميوت التلقائي (spam/badwords/content-filter) كان يستخدم رتبة
 *           يدوية (designated_mute_role) بدون أي آلية لإزالتها - ميوت دائم
 *           فعلياً. الآن يستخدم member.timeout() الحقيقي بنفس المدة
 *           المخزنة بقاعدة البيانات (spam_action_duration)، تماماً مثل
 *           أمر mute.js اليدوي - ينتهي تلقائياً من طرف Discord نفسه.
 * [NEW]     تخفيض الرتبة (demote) لم يكن منفذاً إطلاقاً رغم وجوده بالسكيما.
 *           تم تنفيذه بالكامل بدالة demoteMember() بوضعين يختارهما المشرف:
 *           - single_rank: ينزل رتبة واحدة فقط بالتسلسل الهرمي للسيرفر.
 *           - fixed_role: ينزله لرتبة ثابتة مالها صلاحيات (يحددها المشرف).
 *           يُقرأ الوضع من عمودين جديدين بجدول setting_management_role:
 *           demote_mode و demote_target_role (أضفتهما بملف الـ SQL).
 * [FIX #9] عدادات السبام وحماية الأدمن (spamTracker / adminActionTracker)
 *           كانت مفتاحها userId فقط - أي عضو مشترك بأكثر من سيرفر يشغّل
 *           هذا البوت كان عداده يتشارك بالخطأ بين السيرفرات. أصبح المفتاح
 *           الآن `guildId:userId` بالاثنين.
 * [FIX]     trackAdminAction() تتطلب عمود admin_max_actions (أضفته بالـ SQL)
 *           - لو ظل فارغاً (NULL) بقاعدة البيانات، تبقى الميزة معطلة تلقائياً
 *           لأي سيرفر ما فعّلها (سلوك آمن افتراضي).
 * [تحسين]   handleMessage() تستخدم message.member الجاهزة أولاً بدل
 *           fetch() على كل رسالة (كانت تستهلك API calls بدون داعٍ).
 * [تكامل]   حالة 'warn' أصبحت تمر عبر executeWarn() من warn.js نفسه (بدون
 *           أي تعديل على warn.js) بدل تسجيل مباشر ناقص - هذا يعني أن أي
 *           إنذار تلقائي من AutoMod يُحسب ضمن نظام التصعيد بالتحذيرات نفسه.
 * ============================================================================
 */

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const dbUtils = require('../supabase/dbUtils');
const { universalGet } = dbUtils;
const { isMemberCommandExempt } = require('./GRS');

// عدادات السبام وحماية الأدمن - الآن مفتاحها `guildId:userId` (عزل كامل بين السيرفرات) [FIX #9]
const spamTracker = new Map();
const adminActionTracker = new Map();

// [v5.3 NEW] عداد سبام الأوامر - منفصل تماماً عن spamTracker (اللي يفحص كل
// رسالة عادية). مفتاحه بنفس نمط guildId:userId، بس مصدره مختلف: يُستدعى من
// commandhandler.js فقط (راجع checkCommandSpam بالأسفل)، مو من handleMessage.
const commandSpamTracker = new Map();


// ---------------------------------------------------------------------------
// أداة تحويل المدة النصية (30m, 2h, 1d ...) إلى مللي ثانية - نفس وحدات mute.js
// ---------------------------------------------------------------------------
const DURATION_UNITS_MS = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
};
const MAX_TIMEOUT_MS = 28 * DURATION_UNITS_MS.d; // الحد الأقصى الذي يفرضه Discord على timeout()

function parseDurationToMs(input) {
    if (!input) return null;
    const match = String(input).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (!amount || amount <= 0) return null;

    const ms = amount * DURATION_UNITS_MS[unit];
    return ms > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : ms;
}

module.exports = {
    name: 'autoMod',
    description: 'Handles all automated security and moderation logic',

    /**
     * Main Message Monitor
     * Triggered on every message to check for Spam, Bad Words, Links, etc.
     */
    async handleMessage(message) {
        if (!message.guild || message.author.bot) return;

        const guildId = message.guild.id;
        const userId = message.author.id;

        // 1. Fetch Settings using Universal Engine
        const settings = await universalGet('setting_moderation_security', guildId);
        if (!settings) return;

        // 2. Check Whitelist (Exempt Roles)
        // [تحسين] نستخدم message.member الجاهزة أولاً (متوفرة بأغلب الحالات عبر الكاش)
        // بدل استدعاء fetch() الشبكي على كل رسالة - يقلل الضغط على Discord API.
        const member = message.member || await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        // [GRS] رتب معفاة تماماً من كل أوامر البوت (يدوياً وتلقائياً) - عمود
        // roles_exempt_commands بجدول setting_guild. منفصل عمداً عن
        // roles_exempt_warn (إعفاء خاص بهذا الملف تحديداً، لم يُلمس).
        const guildSettings = await universalGet('setting_guild', guildId);
        const isExempt = settings.roles_exempt_warn?.some(roleId => member.roles.cache.has(roleId));
        if (isExempt || isMemberCommandExempt(guildSettings, member) || member.permissions.has(PermissionFlagsBits.Administrator)) return;

        // 3. Smart Content Filtering (Links, Invites, Mentions)
        if (await this.checkContentFilters(message, settings)) return;

        // 4. Smart Bad Words Filter
        if (await this.checkBadWords(message, settings)) return;

        // 5. Spam Detection
        await this.checkSpam(message, settings);
    },

    /**
     * Smart Bad Words Logic
     * Normalizes text to prevent bypasses (e.g., "w.o.r.d", "w o r d")
     * -- لم تُعدَّل: المنطق هنا صحيح أصلاً --
     */
    async checkBadWords(message, settings) {
        if (!settings.words_bad_custom || settings.words_bad_custom.length === 0) return false;

        // Normalization: Remove dots, spaces, and special characters to catch bypasses
        const normalizedContent = message.content.toLowerCase()
            .replace(/[^\w\s\u0600-\u06FF]/gi, '') // Removes symbols but keeps Arabic/English letters
            .replace(/\s+/g, ''); // Removes all spaces

        const hasBadWord = settings.words_bad_custom.some(word => {
            const cleanWord = word.toLowerCase().replace(/\s+/g, '');
            return normalizedContent.includes(cleanWord);
        });

        if (hasBadWord) {
            await message.delete().catch(() => {});
            await this.applyPunishment(message, 'Bad Words Usage', settings.spam_default_action, settings.spam_action_duration);
            return true;
        }
        return false;
    },

    /**
     * Content Filters (Invites, Links, Mentions)
     * -- لم تُعدَّل: المنطق هنا صحيح أصلاً --
     */
    async checkContentFilters(message, settings) {
        const inviteRegex = /(discord\.gg\/|discord\.com\/invite\/)/gi;
        const linkRegex = /https?:\/\/[^\s]+/gi;

        let triggered = false;
        let reason = '';

        if (settings.invites_block && inviteRegex.test(message.content)) {
            triggered = true;
            reason = 'Posting Discord Invites';
        } else if (settings.links_block && linkRegex.test(message.content)) {
            triggered = true;
            reason = 'Posting Unauthorized Links';
        } else if (settings.block_mentions && message.mentions.users.size > 5) {
            triggered = true;
            reason = 'Mass Mentioning';
        }

        if (triggered) {
            await message.delete().catch(() => {});
            // If action is 'none' (Zero Penalty), we just delete and stop
            // ملاحظة: أضفت 'none' كقيمة مسموحة بالـ CHECK constraint على spam_default_action بملف الـ SQL
            if (settings.spam_default_action !== 'none') {
                await this.applyPunishment(message, reason, settings.spam_default_action, settings.spam_action_duration);
            }
            return true;
        }
        return false;
    },

    /**
     * Spam Detection Logic
     * [FIX #9] المفتاح الآن `guildId:userId` بدل userId فقط
     */
    async checkSpam(message, settings) {
        const key = `${message.guild.id}:${message.author.id}`;
        const now = Date.now();
        const limit = settings.spam_max_commands || 5;

        // Convert cooldown string (e.g., '10s') to milliseconds
        const cooldownMs = parseInt(settings.cooldown_spam) * 1000 || 10000;

        if (!spamTracker.has(key)) {
            spamTracker.set(key, { count: 1, lastMsg: now });
            return;
        }

        const userData = spamTracker.get(key);
        if (now - userData.lastMsg < cooldownMs) {
            userData.count++;
            if (userData.count >= limit) {
                await this.applyPunishment(message, 'Spamming', settings.spam_default_action, settings.spam_action_duration);
                spamTracker.delete(key); // Reset after punishment
            }
        } else {
            spamTracker.set(key, { count: 1, lastMsg: now });
        }
    },

    /**
     * [v5.3 NEW] Command Spam Detection
     * ------------------------------------------------------------------
     * منفصل تماماً عن checkSpam() فوق (اللي يفحص كل رسالة عادية). هذا يُستدعى
     * فقط من commandhandler.js، حصراً لما رسالة تُطابق أمر فعلي بالبوت - يقرأ
     * أعمدة cmd_* الجديدة (v5.3) بدل spam_* و cooldown_spam العامة، عشان
     * تصعيد سبام الأوامر يبقى مستقل الإعداد عن سبام الدردشة العادي.
     *
     * يرجع true لو تم تطبيق عقوبة (أو لو الأكشن 'none') - commandhandler.js
     * يوقف تنفيذ الأمر بهالحالة. يرجع false لو ما فيه سبام (الأمر يكمل تنفيذه).
     */
    async checkCommandSpam(message, dbUtils) {
        if (!message.guild) return false;

        const settings = await universalGet('setting_moderation_security', message.guild.id);
        if (!settings) return false;

        const key = `${message.guild.id}:${message.author.id}`;
        const now = Date.now();
        const limit = settings.cmd_spam_max_commands || 5;
        const cooldownMs = parseInt(settings.cmd_cooldown_spam) * 1000 || 10000;

        if (!commandSpamTracker.has(key)) {
            commandSpamTracker.set(key, { count: 1, lastMsg: now });
            return false;
        }

        const userData = commandSpamTracker.get(key);
        if (now - userData.lastMsg >= cooldownMs) {
            commandSpamTracker.set(key, { count: 1, lastMsg: now });
            return false;
        }

        userData.count++;
        if (userData.count < limit) return false;

        commandSpamTracker.delete(key); // إعادة تصفير بعد العقوبة - نفس فلسفة checkSpam
        if (settings.cmd_spam_default_action === 'none' || !settings.cmd_spam_default_action) return true;

        await this.applyPunishment(message, 'Command Spamming', settings.cmd_spam_default_action, settings.cmd_spam_action_duration);
        return true;
    },

    /**
     * Admin Protection Logic (Anti-Raid)
     * Tracks consecutive administrative actions
     * [FIX #9] المفتاح الآن `guildId:moderatorId` بدل moderatorId فقط
     * [متطلب] يحتاج عمود admin_max_actions بجدول setting_moderation_security (أضفته بالـ SQL)
     */
    async trackAdminAction(guild, moderator, actionType) {
        const settings = await universalGet('setting_moderation_security', guild.id);
        if (!settings || !settings.admin_max_actions) return; // معطّلة افتراضياً حتى يحددها المشرف

        const key = `${guild.id}:${moderator.id}`;
        const now = Date.now();
        const limit = settings.admin_max_actions;

        if (!adminActionTracker.has(key)) {
            adminActionTracker.set(key, { count: 1, lastAction: now });
            return;
        }

        const data = adminActionTracker.get(key);
        if (now - data.lastAction < 60000) { // 1 minute window
            data.count++;
            if (data.count > limit) {
                // Punish the moderator (e.g., remove roles)
                const member = await guild.members.fetch(moderator.id).catch(() => null);
                if (member) await member.roles.set([]).catch(() => {}); // Strip all roles

                // Log the incident
                console.log(`[SECURITY] Admin Raid detected by ${moderator.tag} in guild ${guild.id}`);
                adminActionTracker.delete(key);
            }
        } else {
            adminActionTracker.set(key, { count: 1, lastAction: now });
        }
    },

    /**
     * [NEW] تنفيذ تخفيض الرتبة الفعلي

    

    /**
     * [NEW] تنفيذ تخفيض الرتبة الفعلي
    

    

    /**
     * [NEW] تنفيذ تخفيض الرتبة الفعلي
     * يقرأ وضع التخفيض من setting_management_role:
     *   - demote_mode = 'single_rank'  -> ينزل رتبة واحدة فقط بالتسلسل الهرمي
     *   - demote_mode = 'fixed_role'   -> ينزله مباشرة لرتبة "بدون صلاحيات" محددة (demote_target_role)
     * يرجع true لو نجح التخفيض، false لو تعذر (بدون رمي خطأ - يُسجَّل بالـ console فقط)
     */
    async demoteMember(member, reason) {
        const guild = member.guild;
        const roleSettings = await universalGet('setting_management_role', guild.id);
        const mode = roleSettings?.demote_mode || 'fixed_role';

        const botMember = guild.members.me;
        if (!botMember) return false;

        // الرتب الحالية للعضو (باستثناء @everyone والرتب المُدارة تلقائياً مثل رتبة البوست/التكاملات)
        const currentRoles = member.roles.cache.filter(r => r.id !== guild.id && !r.managed);
        if (currentRoles.size === 0) {
            console.log(`[AutoMod] Demote skipped for ${member.user.tag}: no demotable roles.`);
            return false;
        }

        const highestRole = currentRoles.sort((a, b) => b.position - a.position).first();

        // شرط Discord: رتبة البوت لازم تكون أعلى من أعلى رتبة للعضو المستهدف
        if (botMember.roles.highest.position <= highestRole.position) {
            console.error(`[AutoMod] Demote failed for ${member.user.tag}: bot's role is not higher than the target's highest role.`);
            return false;
        }

        try {
            if (mode === 'single_rank') {
                // ننزل رتبة واحدة فقط: نبحث عن أول رتبة أدنى من أعلى رتبة حالية للعضو
                const allRoles = Array.from(
                    guild.roles.cache.filter(r => r.id !== guild.id && !r.managed).values()
                ).sort((a, b) => b.position - a.position);

                const idx = allRoles.findIndex(r => r.id === highestRole.id);
                const nextRole = idx !== -1 ? allRoles[idx + 1] : null;

                if (!nextRole) {
                    console.log(`[AutoMod] Demote skipped for ${member.user.tag}: already at the lowest rank available.`);
                    return false;
                }

                await member.roles.remove(highestRole, reason);
                await member.roles.add(nextRole, reason);
            } else {
                // fixed_role: نستبدل كل رتبه الحالية برتبة "بدون صلاحيات" محددة من المشرف
                const targetRoleId = roleSettings?.demote_target_role;
                if (!targetRoleId) {
                    console.error('[AutoMod] Demote failed: "demote_target_role" is not configured in setting_management_role.');
                    return false;
                }
                if (!guild.roles.cache.has(targetRoleId)) {
                    console.error('[AutoMod] Demote failed: configured demote_target_role no longer exists on this server.');
                    return false;
                }

                await member.roles.remove(currentRoles, reason).catch(() => {});
                await member.roles.add(targetRoleId, reason);
            }
            return true;
        } catch (error) {
            console.error(`[AutoMod] Demote error for ${member.user.tag}: ${error.message}`);
            return false;
        }
    },
/**
     * [v5.3 REWRITE] Dynamic Rule-Based Escalation Check
     * ------------------------------------------------------------------
     * يستبدل checkSevereEscalation() الثابتة القديمة (كانت تقرأ عمود واحد
     * limit_trigger_severe فقط). يقرأ الآن من auto_mod_rule_config - جدول
     * مفتوح يسمح بعدد غير محدود من القواعد لكل triggerType.
     *
     * @param {Guild} guild
     * @param {GuildMember} member
     * @param {User} author
     * @param {'mute'|'kick'} triggerType - نوع العقوبة اللي لسه صارت للتو
     *        (نعد كم مرة صارت هذي بالضبط لهذا العضو، ونقارنها بعتبات القواعد
     *        المسجّلة لنفس النوع).
     *
     * [FIX سلوك محفوظ من النسخة القديمة] `threshold === count` (مساواة تامة)
     * مو `>=` - نفس فلسفة checkSevereEscalation الأصلية بالضبط: كل قاعدة
     * تتفعّل مرة واحدة بالضبط عند الوصول لعتبتها، وما تتكرر على كل عقوبة
     * لاحقة من نفس النوع. القيد UNIQUE(id_guild, rule_type, threshold)
     * بالسكيما يضمن عدم وجود قاعدتين بنفس العتبة أصلاً، فـ .find() هنا
     * دايماً يرجع قاعدة وحدة كحد أقصى.
     *
     * [NEW] تصعيد متسلسل (Chained Escalation): لو العقوبة الناتجة من هذي
     * القاعدة نفسها 'mute' أو 'kick'، نستدعي نفس الفحص مرة ثانية لهذا النوع
     * الجديد فوراً - يسمح بسلاسل زي "6 ميوتات = طرد" ثم "2 طرد = باند" تُفحص
     * بنفس اللحظة بدون انتظار عقوبة تالية منفصلة.
     *
     * [قيد موروث من النسخة القديمة، لم يتغيّر] يُستدعى فقط من داخل
     * applyPunishment() بهذا الملف (يعني بس لما AutoMod نفسه يطبّق mute/kick
     * تلقائياً، أو warn.js يستدعيه صراحة بعد تصعيده الخاص - راجع warn.js).
     * عقوبات mute/kick يدوية بأوامر staff مباشرة (mute.js/kick.js) ما تمر
     * من هنا حالياً - نفس الفجوة الموجودة أصلاً بالنسخة القديمة، لم تُوسَّع
     * ولم تُصلح بهذا التعديل (يحتاج ملفات mute.js/kick.js لإضافة الاستدعاء
     * فيها لو حبيت تغطيها لاحقاً).
     */
    async checkRuleEscalation(guild, member, author, triggerType) {
        try {
            const rules = await dbUtils.getAutoModRules(guild.id, triggerType);
            if (!rules || rules.length === 0) return;

            const supabase = require('../supabase/db');
            const { count, error } = await supabase
                .from('log_moderation')
                .select('id', { count: 'exact', head: true })
                .eq('id_guild', guild.id)
                .eq('id_target', author.id)
                .eq('action_type', triggerType);

            if (error || count == null) return;

            const matchedRule = rules.find(r => r.threshold === count);
            if (!matchedRule) return;

            const reason = `Auto-Escalation: reached ${count} ${triggerType}(s)`;
            const escAction = matchedRule.action;

            switch (escAction) {
                case 'mute': {
                    const ms = parseDurationToMs(matchedRule.duration) || 10 * 60 * 1000;
                    if (!member.moderatable) return;
                    await member.timeout(ms, reason);
                    await supabase.from('temp_actions').insert({
                        id_guild: guild.id,
                        id_user: author.id,
                        action_type: 'mute',
                        ends_at: new Date(Date.now() + ms).toISOString(),
                        processed: false
                    });
                    break;
                }
                case 'kick':
                    if (!member.kickable) return;
                    await member.kick(reason);
                    break;
                case 'ban':
                    if (!member.bannable) return;
                    await member.ban({ reason });
                    break;
                case 'demote':
                    if (!(await this.demoteMember(member, reason))) return;
                    break;
                default:
                    return;
            }

            await dbUtils.addInfraction(guild.id, author.id, guild.client.user.id, escAction, reason, matchedRule.duration, author.username);

            // [NEW] تصعيد متسلسل - راجع الشرح بالأعلى
            if (escAction === 'mute' || escAction === 'kick') {
                await this.checkRuleEscalation(guild, member, author, escAction);
            }
        } catch (err) {
            console.error(`[AutoMod] Rule escalation check failed (${triggerType}) for ${author.tag}: ${err.message}`);
        }
    },

    /**
     * Universal Punishment Executor
    /**
     * Universal Punishment Executor
     * Executes Mute, Kick, Ban, Demote, or Warn based on DB settings
     */
    async applyPunishment(message, reason, action, duration) {
        const { guild, member, author } = message;

        if (action === 'none' || !action) return;

        try {
            // --- حالة 'warn' منفصلة: تمر بالكامل عبر warn.js (بدون تعديل عليه) ---
            // عشان أي إنذار تلقائي من AutoMod يُحسب ضمن نظام التصعيد بالتحذيرات
            // نفسه (warning_active + limit_trigger_warn)، بدل تسجيل منفصل ناقص.
            if (action === 'warn') {
                try {
                    const { executeWarn } = require('./warn'); // lazy require - يتجنب أي مشاكل ترتيب تحميل
                    const botModerator = {
                        id: message.client.user.id,
                        tag: message.client.user.tag || message.client.user.username,
                        roles: { highest: { position: Infinity } } // البوت يتجاوز فحص التسلسل الهرمي دائماً
                    };
                    await executeWarn(guild, author.id, botModerator, reason, dbUtils);
                } catch (warnErr) {
                    // احتياط نادر: لو فشل الاستدعاء لأي سبب، لا نفقد السجل بالكامل
                    console.error('[AutoMod] Failed to route warn through warn.js, using fallback log:', warnErr.message);
                    await dbUtils.addInfraction(guild.id, author.id, message.client.user.id, 'warn', reason, null, author.username);
                    await message.channel.send(`${author}, you have been warned: ${reason}`).catch(() => {});
                }
                return; // executeWarn يسجل كل شيء بنفسه - لا داعي للتسجيل العام بالأسفل
            }

            switch (action) {
                case 'mute': {
                    // [FIX #4] Timeout حقيقي بالمدة الفعلية من قاعدة البيانات (spam_action_duration)
                    // بدل رتبة يدوية كانت تبقى للأبد بدون أي آلية إزالة.
                    const ms = parseDurationToMs(duration) || 10 * 60 * 1000; // افتراضي 10 دقائق لو القيمة بالقاعدة غير صالحة/فارغة
                    if (!member.moderatable) {
                        console.error(`[AutoMod] Cannot mute ${author.tag}: member is not moderatable by the bot.`);
                        return;
                    }
                    await member.timeout(ms, reason);

                    // تسجيل توثيقي بـ temp_actions فقط (Discord نفسه ينهي التايم أوت تلقائياً،
                    // هذا يبقيها متسقة مع باقي الملفات مثل mute.js و warn.js فقط للأرشفة)
                    try {
                        const supabase = require('../supabase/db');
                        const endsAt = new Date(Date.now() + ms).toISOString();
                        await supabase.from('temp_actions').insert({
                            id_guild: guild.id,
                            id_user: author.id,
                            action_type: 'mute',
                            ends_at: endsAt,
                            processed: false
                        });
                    } catch (e) { /* لا نكسر تنفيذ العقوبة لو فشل التوثيق فقط */ }

                    await message.channel.send(`${author} has been muted for ${duration || '10m'}. Reason: ${reason}`).catch(() => {});
                    break;
                }

                case 'kick':
                    if (!member.kickable) {
                        console.error(`[AutoMod] Cannot kick ${author.tag}: member is not kickable by the bot.`);
                        return;
                    }
                    await member.kick(reason);
                    break;

                case 'ban':
                    if (!member.bannable) {
                        console.error(`[AutoMod] Cannot ban ${author.tag}: member is not bannable by the bot.`);
                        return;
                    }
                    await member.ban({ reason });
                    break;

                case 'demote': {
                    // [NEW] لم تكن منفذة إطلاقاً سابقاً - راجع demoteMember() بالأعلى
                    const demoted = await this.demoteMember(member, reason);
                    if (!demoted) return; // فشل التخفيض - لا نسجل عقوبة لم تُنفذ فعلياً
                    await message.channel.send(`${author} has been demoted. Reason: ${reason}`).catch(() => {});
                    break;
                }

                default:
                    console.warn(`[AutoMod] Unknown punishment action "${action}" - no action taken and nothing logged.`);
                    return;
            }

            // Log to log_moderation table (لكل الحالات ما عدا 'warn' اللي سجلت نفسها بالأعلى)
            // [BUG FIX] كانت تستخدم logModeration غير الموجودة أصلاً بـ databaseQueries.js -
            // استُبدلت بـ dbUtils.addInfraction المستخدمة بباقي ملفات الأوامر (ban.js, kick.js, mute.js).
            await dbUtils.addInfraction(guild.id, author.id, message.client.user.id, action, reason, duration, author.username);

            // [v5.3 REWRITE] فحص القواعد التراكمية الديناميكية - لكل من mute
            // و kick الآن (النسخة القديمة كانت تفحص mute فقط لأن Tier 2 كانت
            // مقفلة على "بعد X ميوت"؛ الجدول الجديد يدعم تصعيد Kick→Ban أيضاً).
            if (action === 'mute' || action === 'kick') {
                await this.checkRuleEscalation(guild, member, author, action);
            }

        } catch (error) {
            console.error(`Failed to apply punishment: ${error.message}`);
        }
    }
};