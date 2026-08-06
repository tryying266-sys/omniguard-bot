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
// [v5.3 NEW] ينفّذ فعلياً خانتي "Notify via DM" / "Notify in Channel" بالداشبورد
const { notifyCommandExecution } = require('./commandNotifications');

// عدادات السبام وحماية الأدمن - الآن مفتاحها `guildId:userId` (عزل كامل بين السيرفرات) [FIX #9]
const spamTracker = new Map();
const adminActionTracker = new Map();

// [NEW] عداد Mass Mentions - يجمع المنشنات عبر رسائل متتالية بدل فحص رسالة وحدة فقط
const mentionTracker = new Map();
const MENTION_WINDOW_MS = 15000; // نافذة 15 ثانية تُعتبر "رسائل متتالية"
const MENTION_THRESHOLD = 15;    // العتبة الإجمالية (برسالة وحدة أو مجمّعة)

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
        let skipPunishment = false; // نعاقب مرة وحدة بس بكل نافذة Mass Mentions

        if (settings.invites_block && inviteRegex.test(message.content)) {
            triggered = true;
            reason = 'Posting Discord Invites';
        } else if (settings.links_block && linkRegex.test(message.content)) {
            triggered = true;
            reason = 'Posting Unauthorized Links';
        } else if (settings.block_mentions && message.mentions.users.size > 0) {
            const key = `${message.guild.id}:${message.author.id}`;
            const now = Date.now();
            const mentionCount = message.mentions.users.size;

            let tracker = mentionTracker.get(key);
            if (!tracker || now - tracker.windowStart > MENTION_WINDOW_MS) {
                tracker = { total: 0, windowStart: now, flagged: false, punished: false };
                mentionTracker.set(key, tracker);
            }
            tracker.total += mentionCount;

            const singleMessageExceeds = mentionCount > MENTION_THRESHOLD;
            if (singleMessageExceeds || tracker.total > MENTION_THRESHOLD) {
                tracker.flagged = true;
            }

            if (tracker.flagged) {
                triggered = true;
                reason = 'Mass Mentioning';
                skipPunishment = tracker.punished;
                tracker.punished = true;
            }
        }

        if (triggered) {
            await message.delete().catch(() => {});
            if (!skipPunishment && settings.spam_default_action !== 'none') {
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
     * [v5.3 FIX-11] قائمة الصلاحيات اللي تُعتبر "إشراف/إدارة" - أي رتبة تملك
     * ولو صلاحية وحدة منها تُستبعد تلقائياً كوجهة محتملة للتخفيض (Demote)،
     * بغض النظر عن الوضع المُختار (single_rank أو fixed_role). عدّل هذي
     * القائمة لو تبي تضيف/تشيل صلاحية معينة من التعريف.
     */
    DEMOTE_UNSAFE_PERMISSIONS: [
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.ModerateMembers, // Timeout (Mute)
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageWebhooks,
        PermissionFlagsBits.MentionEveryone
    ],

    /**
     * [v5.3 FIX-11] هل هذي الرتبة "آمنة" كوجهة تخفيض؟
     * تتأكد أن الرتبة ليس بها صلاحيات إشراف، وليست من رتب إدارة البوت،
     * وتضمن ألا تكون رتبة عزل أو ميوت (لا تمنع إرسال الرسائل أو رؤية القنوات).
     */
    isRoleSafeForDemotion(role, roleSettings) {
        // 1. استبعاد الرتب ذات الصلاحيات الإدارية أو صلاحيات إدارة البوت
        if (role.permissions.any(this.DEMOTE_UNSAFE_PERMISSIONS)) return false;
        if (roleSettings?.roles_admin_bot?.includes(role.id)) return false;

        // 2. استبعاد رتب العزل/الميوت (التي تعطّل رؤية القنوات أو إرسال الرسائل)
        if (!role.permissions.has(PermissionFlagsBits.SendMessages) || !role.permissions.has(PermissionFlagsBits.ViewChannel)) {
            return false;
        }

        // 3. استبعاد الرتب التي تحتوي على أسماء تدل على العزل أو الميوت
        const nameLower = role.name.toLowerCase();
        const isolatedKeywords = ['mute', 'isolated', 'jail', 'unverified', 'prison', 'معزول', 'ميوت', 'مكتوم', 'سجن'];
        if (isolatedKeywords.some(keyword => nameLower.includes(keyword))) {
            return false;
        }

        return true;
    },

    /**
     * [NEW] يحسب عدد الصلاحيات الخطرة اللي عند الرتبة (من DEMOTE_UNSAFE_PERMISSIONS)
     * يُستخدم فقط كـ"ترتيب احتياطي" لو ما فيه ولا رتبة آمنة 100% بالسيرفر -
     * نختار وقتها الأقل ضرراً بدل ما نسيب العضو بدون أي رتبة إطلاقاً.
     */
    countUnsafePermissions(role) {
        return this.DEMOTE_UNSAFE_PERMISSIONS.reduce((count, perm) => {
            return role.permissions.has(perm) ? count + 1 : count;
        }, 0);
    },

    /**
     * [NEW / v5.3 FIX-11] تنفيذ تخفيض الرتبة الفعلي
     * يقرأ وضع التخفيض من setting_management_role:
     *   - demote_mode = 'single_rank'  -> ينزل بالتسلسل الهرمي حتى أول رتبة
     *                                     آمنة تماماً (بدون صلاحيات إشراف)
     *   - demote_mode = 'fixed_role'   -> ينزله مباشرة لرتبة "بدون صلاحيات" محددة (demote_target_role)
     *
     * [تعديل سلوك متعمّد v5.3] كلا الوضعين الآن يشيلون كل رتب العضو الحالية
     * (مو بس أعلى رتبة) قبل إضافة الرتبة الآمنة - قبل هذا التعديل، وضع
     * single_rank كان يشيل أعلى رتبة بس، فلو العضو عنده رتبة ثانية فيها
     * صلاحيات إشراف بجانب أعلى رتبة، كانت تضل معه بعد "التخفيض" - يكسر
     * الضمان المطلوب: العضو المخفّض ما يبقى معه أي صلاحية إشراف إطلاقاً.
     *
     * يرجع true لو نجح التخفيض، false لو تعذر (بدون رمي خطأ - يُسجَّل بالـ console فقط)
     */
    async demoteMember(member, reason, roleToRemoveInput = null) {
        const guild = member.guild;
        const botMember = guild.members.me;
        if (!botMember) return { success: false, roleName: null };

        const currentRoles = member.roles.cache.filter(r => r.id !== guild.id && !r.managed);
        if (currentRoles.size === 0) {
            console.log(`[AutoMod] Demote skipped for ${member.user.tag}: no demotable roles.`);
            return { success: false, roleName: null };
        }

        // [FIX] الرتبة المحددة يدوياً (أمر !demote) تُعتبر "الرتبة المطلوب
        // شيلها بالضبط" - مو رتبة نضيفها كبديل. لو ما تحدد شي (تخفيض تلقائي
        // من AutoMod عند سبام مثلاً)، نشيل كل رتب العضو زي القديم (ضمان
        // عدم بقاء أي صلاحية إشراف بعد التخفيض التلقائي).
        let rolesToStrip;
        let primaryRemovedRole;

        if (roleToRemoveInput) {
            if (!currentRoles.has(roleToRemoveInput.id)) {
                console.warn(`[AutoMod] Demote failed: ${member.user.tag} does not have role "${roleToRemoveInput.name}".`);
                return { success: false, roleName: null };
            }
            rolesToStrip = [roleToRemoveInput];
            primaryRemovedRole = roleToRemoveInput;
        } else {
            rolesToStrip = currentRoles;
            primaryRemovedRole = currentRoles.sort((a, b) => b.position - a.position).first();
        }

        if (botMember.roles.highest.position <= primaryRemovedRole.position) {
            console.error(`[AutoMod] Demote failed for ${member.user.tag}: bot's role is not higher than the role being removed.`);
            return { success: false, roleName: null };
        }

        try {
            const roleSettings = await universalGet('setting_management_role', guild.id);
            let safeRole = null;

            // [فحص جديد] التأكد مما إذا كان العضو يمتلك رتبة أخرى آمنة متبقية بعد سحب الرتب المحددة
            const rolesToStripArray = Array.isArray(rolesToStrip) ? rolesToStrip : [...rolesToStrip.values()];
            const rolesToStripIds = new Set(rolesToStripArray.map(r => r.id));
            const remainingRoles = currentRoles.filter(r => !rolesToStripIds.has(r.id));
            const hasExistingSafeRole = remainingRoles.some(r => this.isRoleSafeForDemotion(r, roleSettings));

            // فقط إذا لم تكن لدى العضو أي رتبة متبقية آمنة، نبحث عن رتبة بديلة أو نستخدم الرتبة المحددة
            if (!hasExistingSafeRole) {
                if (roleSettings?.demote_mode === 'fixed_role' && roleSettings?.demote_target_role) {
                    safeRole = guild.roles.cache.get(roleSettings.demote_target_role) || null;
                }

                if (!safeRole) {
                    const candidateRoles = guild.roles.cache.filter(r =>
                        r.id !== guild.id &&
                        !r.managed &&
                        !currentRoles.has(r.id) &&
                        r.position < botMember.roles.highest.position
                    );

                    // المرحلة 1: رتبة آمنة تماماً (صفر صلاحيات خطرة وليست ميوت/عزل)
                    safeRole = candidateRoles
                        .filter(r => this.isRoleSafeForDemotion(r, roleSettings))
                        .sort((a, b) => b.position - a.position)
                        .first() || null;

                    // المرحلة 2: لو ما فيه ولا رتبة نظيفة 100%، نختار الأقل ضرراً
                    if (!safeRole && candidateRoles.size > 0) {
                        safeRole = [...candidateRoles.values()]
                            .sort((a, b) => {
                                const riskDiff = this.countUnsafePermissions(a) - this.countUnsafePermissions(b);
                                return riskDiff !== 0 ? riskDiff : b.position - a.position;
                            })[0] || null;

                        if (safeRole) {
                            console.warn(`[AutoMod] No fully safe role found in guild ${guild.id} - using least-risky role "${safeRole.name}" instead.`);
                        }
                    }
                }
            }

            await member.roles.remove(rolesToStrip, reason);
            if (safeRole) {
                await member.roles.add(safeRole, reason).catch(() => {});
            }

            return { success: true, roleName: primaryRemovedRole.name };
        } catch (error) {
            console.error(`[AutoMod] Demote error for ${member.user.tag}: ${error.message}`);
            return { success: false, roleName: null };
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
    async checkRuleEscalation(guild, member, author, triggerType, channel = null) {
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

            let demotedRoleName = null;

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
                case 'demote': {
                    const demoteResult = await this.demoteMember(member, reason);
                    if (!demoteResult.success) return;
                    demotedRoleName = demoteResult.roleName;
                    break;
                }
                default:
                    return;
            }

            await dbUtils.addInfraction(guild.id, author.id, guild.client.user.id, escAction, reason, matchedRule.duration, author.username);

            // [v5.3 NEW] إشعار DM/Channel لو مفعّل بإعدادات السيرفر
            await notifyCommandExecution({
                guild,
                targetMember: member,
                moderator: guild.client.user,
                channel,
                action: escAction,
                reason,
                duration: matchedRule.duration,
                roleName: demotedRoleName
            });

            // [FIX] تفادي حلقة تصعيد ذاتية: لو قاعدة نوعها mute أدّت لعقوبة
            // mute بنفس النوع، ما نكرر فحص نفس النوع فوراً بنفس السلسلة
            // المتزامنة - نخليها تُلتقط طبيعياً بالمرة الجاية لما يصير ميوت
            // فعلي جديد لاحقاً، بدل تسلسل فوري بلا توقف بنفس اللحظة.
            // التصعيد المتسلسل بين أنواع مختلفة (مثلاً mute → kick → ban)
            // يبقى شغّال زي ما هو، هذا القيد يمنع بس النوع يصعّد نفسه.
            if ((escAction === 'mute' || escAction === 'kick') && escAction !== triggerType) {
                await this.checkRuleEscalation(guild, member, author, escAction, channel);
            }
        } catch (err) {
            console.error(`[AutoMod] Rule escalation check failed (${triggerType}) for ${author.tag}: ${err.message}`);
        }
    },

    /**
     * Universal Punishment Executor
     * Executes Mute, Kick, Ban, Demote, or Warn based on DB settings
     *
     * [v5.3 NOTE] مسار warn العادي (executeWarn ناجحة) يسجّل ويصعّد كل شي
     * بنفسه من warn.js - إشعار DM/Channel لهالمسار لازم يُضاف داخل warn.js
     * نفسه (بعد نجاح executeWarn هناك)، مو هنا. مسار الفشل الاحتياطي تحت
     * (catch) مغطّى بالكامل بهذا الملف.
     */
    async applyPunishment(message, reason, action, duration) {
        const { guild, member, author } = message;

        if (action === 'none' || !action) return;

        try {
            if (action === 'warn') {
                try {
                    const { executeWarn } = require('./warn');
                    const botModerator = {
                        id: message.client.user.id,
                        tag: message.client.user.tag || message.client.user.username,
                        roles: { highest: { position: Infinity } }
                    };
                    await executeWarn(guild, author.id, botModerator, reason, dbUtils);
                } catch (warnErr) {
                    console.error('[AutoMod] Failed to route warn through warn.js, using fallback log:', warnErr.message);
                    await dbUtils.addInfraction(guild.id, author.id, message.client.user.id, 'warn', reason, null, author.username);
                    await notifyCommandExecution({
                        guild, targetMember: member, moderator: message.client.user,
                        channel: message.channel, action: 'warn', reason, duration: null
                    });
                }
                return;
            }

            let demotedRoleName = null;

            switch (action) {
                case 'mute': {
                    const ms = parseDurationToMs(duration) || 10 * 60 * 1000;
                    if (!member.moderatable) {
                        console.error(`[AutoMod] Cannot mute ${author.tag}: member is not moderatable by the bot.`);
                        return;
                    }
                    await member.timeout(ms, reason);

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
                    } catch (e) {}
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
                    const demoteResult = await this.demoteMember(member, reason);
                    if (!demoteResult.success) return;
                    demotedRoleName = demoteResult.roleName;
                    break;
                }

                default:
                    console.warn(`[AutoMod] Unknown punishment action "${action}" - no action taken and nothing logged.`);
                    return;
            }

            // [FIX] Demote عقوبة نهائية بلا مدة - نتجاهل duration القادمة من
            // الداشبورد إجبارياً بغض النظر عن أي قيمة محفوظة سابقاً بالإعدادات
            const finalDuration = action === 'demote' ? null : duration;

            await dbUtils.addInfraction(guild.id, author.id, message.client.user.id, action, reason, finalDuration, author.username);

            // إرسال الإشعار كاملاً عبر المتحكم الموحد بناءً على إعدادات الداشبورد
            await notifyCommandExecution({
                guild,
                targetMember: member,
                moderator: message.client.user,
                channel: message.channel,
                action,
                reason,
                duration: finalDuration,
                roleName: demotedRoleName
            });

            if (action === 'mute' || action === 'kick') {
                await this.checkRuleEscalation(guild, member, author, action, message.channel);
            }

        } catch (error) {
            console.error(`Failed to apply punishment: ${error.message}`);
        }
    }
};