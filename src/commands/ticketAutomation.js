// ============================================================================
// ticketAutomation.js (v1.0)
// ============================================================================
// يغطي الجزئين اللي ticketsystem.js نفسه وثّق صراحة إنه ما يغطيهم (راجع
// تعليق SCOPE بأعلى ذاك الملف):
//   1. Idle Watcher: يحدّث last_user_message_at لما صاحب التذكرة يكتب،
//      ويشغّل فحص Auto Respond (Fuzzy) على نفس الرسالة.
//   2. Auto Close Scheduler: setInterval كل 60 ثانية (نفس نمط
//      checkExpiredActions بـ index.js) يفحص كل التذاكر المفتوحة الخاملة
//      ويحذّر/يغلق حسب [TICKET-8] و[TICKET-11].
//
// ⚠️ هذا الملف "مو أمر شات حقيقي" - لازم يُستثنى بالاسم من
//    commandhandler.js (نفس طريقة استثناء AutoMod.js/AntiAlt.js/GRS.js/
//    getroles.js/Rolemanagement.js/welcome.js).
//
// طريقة الاستخدام بـ index.js (نفس نمط roleManagement/welcome/getroles -
// قبل client.login()، لأن هذا الملف يسجل client.once('ready', ...) داخلي
// خاص فيه لبدء السكجولر):
//    const ticketAutomation = require(path.join(__dirname, 'commands', 'ticketAutomation'));
//    ticketAutomation(client);
// ============================================================================

const { EmbedBuilder } = require('discord.js');
const supabase = require('../supabase/db');
const { executeClose, getTicketContext } = require('./ticketsystem');

// مدة فحص السكجولر (كل 60 ثانية - نفس نمط checkExpiredActions بـ index.js)
const SCHEDULER_INTERVAL_MS = 60 * 1000;

// ----------------------------------------------------------------------
// 1. Fuzzy Matching محلي (Levenshtein Distance) - بدون أي AI خارجي
// ----------------------------------------------------------------------
// [TICKET-8] auto_respond_fuzzy_threshold رقم تشابه من 0 إلى 1 (مو تطابق
// تام). الخيار المعتمد: Keyword-level Fuzzy - كل كلمة برسالة العضو تُقارن
// على حدة مع كلمات trigger_phrase، وأعلى نسبة تشابه هي اللي تُحتسب.

function levenshteinDistance(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,      // حذف
                dp[i][j - 1] + 1,      // إضافة
                dp[i - 1][j - 1] + cost // استبدال
            );
        }
    }
    return dp[m][n];
}

// نسبة تشابه من 0 إلى 1 (1 = تطابق تام)
function similarityRatio(wordA, wordB) {
    const longer = Math.max(wordA.length, wordB.length);
    if (longer === 0) return 1;
    return 1 - levenshteinDistance(wordA, wordB) / longer;
}

function normalizeWords(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ') // إزالة علامات الترقيم، إبقاء الحروف/الأرقام (يدعم العربي)
        .split(/\s+/)
        .filter(Boolean);
}

/**
 * يبحث عن أول قاعدة (rule) تحقق نسبة تشابه >= threshold بين أي كلمة من
 * رسالة العضو وأي كلمة من trigger_phrase الخاص بها. يرجع القاعدة نفسها
 * أو null لو ما فيه تطابق.
 */
function findMatchingRule(messageContent, rules, threshold) {
    const messageWords = normalizeWords(messageContent);
    if (messageWords.length === 0) return null;

    for (const rule of rules) {
        const triggerWords = normalizeWords(rule.trigger_phrase);
        if (triggerWords.length === 0) continue;

        const isMatch = messageWords.some(mWord =>
            triggerWords.some(tWord => similarityRatio(mWord, tWord) >= threshold)
        );
        if (isMatch) return rule;
    }
    return null;
}

// ----------------------------------------------------------------------
// 2. Idle Watcher (messageCreate) - تحديث last_user_message_at + Auto Respond
// ----------------------------------------------------------------------

async function handleTicketMessage(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    const { ticket } = await getTicketContext(message.channel.id);
    if (!ticket) return; // مو قناة تذكرة مفتوحة إطلاقاً

    // [TICKET-8/TICKET-11] بس رسائل صاحب التذكرة تُحسب لتتبع الخمول
    // ولتشغيل Auto Respond (تفادي رد تلقائي على كلام الطاقم نفسه).
    if (message.author.id !== ticket.id_opener) return;

    // تحديث الخمول + إلغاء أي تحذير سابق (رجوع العضو يكتب = يلغي العدّاد)
    await supabase
        .from('ticket_record')
        .update({ last_user_message_at: new Date().toISOString(), warned_at: null })
        .eq('id', ticket.id)
        .then(({ error }) => {
            if (error) console.error('[Ticket Automation] Failed to bump last_user_message_at:', error.message);
        });

    // Auto Respond (Fuzzy)
    try {
        const { data: settings } = await supabase
            .from('setting_ticket_system')
            .select('auto_respond_enabled, auto_respond_fuzzy_threshold')
            .eq('id_guild', message.guild.id)
            .maybeSingle();

        if (!settings?.auto_respond_enabled) return;

        const { data: rules } = await supabase
            .from('ticket_auto_respond')
            .select('trigger_phrase, response_text')
            .eq('id_guild', message.guild.id);

        if (!rules || rules.length === 0) return;

        const threshold = settings.auto_respond_fuzzy_threshold ?? 0.72;
        const matchedRule = findMatchingRule(message.content, rules, threshold);
        if (matchedRule) {
            await message.channel.send(matchedRule.response_text).catch(err =>
                console.error('[Ticket Automation] Failed to send auto-respond message:', err.message)
            );
        }
    } catch (err) {
        console.error('[Ticket Automation] Auto-respond check failed:', err.message);
    }
}

// ----------------------------------------------------------------------
// 3. Auto Close Scheduler (كل 60 ثانية)
// ----------------------------------------------------------------------

/**
 * [TICKET-8/TICKET-10/TICKET-11] يرسل closing_message (لو فيه نص) ثم يستدعي
 * executeClose المركزية - هي نفسها المسؤولة عن الترانسكربت + قرار الحذف
 * التلقائي بعد 10 ثواني (TICKET-10)، بدون أي تكرار لذاك المنطق هنا.
 */
async function performAutoClose(client, channel, closingMessage) {
    if (closingMessage && closingMessage.trim()) {
        await channel.send(closingMessage).catch(() => {});
    }

    // [TICKET-9/isTicketStaff] executeClose تتوقع كائن "moderator" شبه
    // GuildMember - نمرر البوت نفسه، مع permissions.has() ترجع true دايماً
    // عشان isTicketStaff() يتجاوزه (نفس معاملة الأدمن بالضبط).
    const botModerator = {
        id: client.user.id,
        user: { tag: client.user.tag },
        permissions: { has: () => true }
    };

    const result = await executeClose(channel, botModerator, 'Automatically closed due to inactivity');
    if (!result.success) {
        console.error(`[Ticket Automation] Auto-close failed for channel ${channel.id}:`, result.error);
    }
}

async function checkIdleTickets(client) {
    try {
        const { data: enabledSettings, error: settingsErr } = await supabase
            .from('setting_ticket_system')
            .select('id_guild, auto_close_warn_minutes, auto_close_after_warn_minutes, auto_close_warning_msg, closing_message')
            .eq('auto_close_enabled', true);

        if (settingsErr) {
            console.error('[Ticket Automation] Failed to load auto-close settings:', settingsErr.message);
            return;
        }
        if (!enabledSettings || enabledSettings.length === 0) return;

        const now = Date.now();

        for (const settings of enabledSettings) {
            const { data: openTickets, error: ticketsErr } = await supabase
                .from('ticket_record')
                .select('id, id_channel, id_guild, last_user_message_at, warned_at')
                .eq('id_guild', settings.id_guild)
                .eq('status', 'open');

            if (ticketsErr) {
                console.error(`[Ticket Automation] Failed to load open tickets for guild ${settings.id_guild}:`, ticketsErr.message);
                continue;
            }
            if (!openTickets || openTickets.length === 0) continue;

            for (const ticket of openTickets) {
                const idleMinutes = (now - new Date(ticket.last_user_message_at).getTime()) / 60000;

                // [TICKET-11] auto_close_warn_minutes = NULL -> بدون مرحلة
                // تحذير إطلاقاً، الخمول يُحسب مباشرة على after_warn_minutes.
                const skipWarningStage = settings.auto_close_warn_minutes === null || settings.auto_close_warn_minutes === undefined;

                let shouldClose = false;

                if (skipWarningStage) {
                    shouldClose = idleMinutes >= settings.auto_close_after_warn_minutes;
                } else if (!ticket.warned_at) {
                    if (idleMinutes >= settings.auto_close_warn_minutes) {
                        const channel = await client.channels.fetch(ticket.id_channel).catch(() => null);
                        if (channel && settings.auto_close_warning_msg) {
                            await channel.send(settings.auto_close_warning_msg).catch(() => {});
                        }
                        await supabase
                            .from('ticket_record')
                            .update({ warned_at: new Date().toISOString() })
                            .eq('id', ticket.id);
                    }
                } else {
                    const sinceWarnMinutes = (now - new Date(ticket.warned_at).getTime()) / 60000;
                    shouldClose = sinceWarnMinutes >= settings.auto_close_after_warn_minutes;
                }

                if (shouldClose) {
                    const channel = await client.channels.fetch(ticket.id_channel).catch(() => null);
                    if (channel) {
                        await performAutoClose(client, channel, settings.closing_message);
                    } else {
                        // القناة انحذفت يدوياً بدون تحديث الداتابيس - ننضّف السجل بس
                        console.warn(`[Ticket Automation] Channel ${ticket.id_channel} missing - marking ticket ${ticket.id} closed without a transcript.`);
                        await supabase
                            .from('ticket_record')
                            .update({ status: 'closed', closed_at: new Date().toISOString(), close_reason: 'Channel no longer exists' })
                            .eq('id', ticket.id);
                    }
                }
            }
        }
    } catch (err) {
        console.error('[Ticket Automation] Unexpected error in checkIdleTickets:', err);
    }
}

// ----------------------------------------------------------------------
// 4. التصدير الرئيسي: ربط الأحداث + بدء السكجولر
// ----------------------------------------------------------------------

module.exports = (client) => {
    client.on('messageCreate', (message) => {
        handleTicketMessage(message).catch(err =>
            console.error('[Ticket Automation] handleTicketMessage crashed:', err)
        );
    });

    client.once('ready', () => {
        setInterval(() => checkIdleTickets(client), SCHEDULER_INTERVAL_MS);
        console.log('[Ticket Automation] Auto Close Scheduler: STARTED (Checking every 60s)');
    });

    console.log('[Ticket Automation] تم تفعيل مستمع الرسائل (Idle Watcher + Auto Respond).');
};