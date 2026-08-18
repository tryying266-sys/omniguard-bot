// ============================================================================
// Anothercommands.js - Utility Commands Bundle (v2.0 - Interactive Polls)
// ============================================================================
// Supports: Prefix (via commandhandler.js Auto-Loading), same file-shape
// convention as lock.js (single module.exports + `aliases` array, one
// dispatcher `run()` that branches internally by the typed command name).
//
// Commands bundled here: slowmode, unslow, nick, removenick, poll, endpoll,
// avatar, invites.
//
// [IMPORTANT DESIGN NOTE] commandhandler.js checks `command.permissions` at
// the MODULE level (one shared value for whichever name/alias was typed,
// since every alias points to the exact same exports object - see its
// header comment for lock/unlock). That works fine for lock.js because lock
// and unlock both need the same permission (ManageChannels). It does NOT
// work here: these commands each need a DIFFERENT permission (slowmode/
// unslow -> ManageChannels, nick/removenick -> ManageNicknames, poll/avatar
// -> none, invites -> none for the member but ManageGuild for the bot
// itself, endpoll -> creator OR ManageMessages, checked inline).
//
// Fix: `module.exports.permissions` is intentionally left undefined below,
// so commandhandler.js's generic check (`if (command.permissions && ...)`)
// is skipped entirely for every alias. Each branch inside run() below does
// its OWN explicit permission check instead, and replies with a plain-text
// rejection (matching lock.js's error-message convention) before doing
// anything else. No changes needed to commandhandler.js.
//
// [REPLY CONVENTION] Every successful action replies with an Embed. Every
// rejection/permission-error/validation-error replies with a plain
// `message.reply("❌ ...")` - matching lock.js's exact pattern.
//
// [v2.0 CHANGES]
//   - slowmode/unslow: المدة الحين تقبل صيغة "30s" / "10m" / "2h" (رقم صرف
//     لسا يشتغل = ثواني، توافق خلفي مع السلوك القديم).
//   - unslow (جديد): يصفّر السلو مود لصفر بنفس القناة أو قناة محددة - نفس
//     تنفيذ slowmode 0 بالضبط.
//   - removenick (جديد): يرجّع عضو لاسمه الأصلي (بديل مباشر لـ nick بدون
//     اسم جديد).
//   - poll: أُعيد بناؤه بالكامل - تصويت بأزرار حقيقية (مو ريأكشنات، راجع
//     events/pollPanel.js لسبب هذا القرار)، صيغة اقتباس (") بدل "|",
//     إيموجي مخصص اختياري لكل خيار، أسماء خيارات حرة، --time لإغلاق
//     تلقائي، --anon لإخفاء هوية المصوّتين بالنتائج.
//   - endpoll (جديد): يقفل استطلاع قبل وقته (رد على رسالته أو معرّفها).
// ============================================================================

const { PermissionsBitField, EmbedBuilder } = require('discord.js');
const {
    MAX_POLL_OPTIONS,
    DEFAULT_OPTIONS_YES_NO,
    parsePollDurationToMs,
    createAndPublishPoll,
    getPollByMessageId,
    closePoll,
} = require('../events/pollPanel.js');

const EMBED_COLOR_SUCCESS = 0x2ecc71; // أخضر - نفس نجاح unlock بـ lock.js
const EMBED_COLOR_INFO = 0x5865F2;    // أزرق (Blurple) - أوامر معلومات عامة (avatar/invites)

/**
 * نفس دالة resolveTargetChannel بـ lock.js بالضبط - معاد تعريفها هنا محلياً
 * (مو require من lock.js) لأن كل ملف أمر بالمشروع مستقل بذاته بالكامل،
 * نفس فلسفة الملفات الثانية (kick.js/mute.js/lock.js) - بدون أي تبعية
 * بينية بين ملفات الأوامر.
 */
function resolveTargetChannel(guild, arg) {
    if (!arg) return null;
    const idMatch = arg.match(/^<#(\d+)>$/) || arg.match(/^(\d+)$/);
    if (!idMatch) return null;
    return guild.channels.cache.get(idMatch[1]) || null;
}

/**
 * [v2.0 NEW] يحوّل نص مدة السلو مود لعدد ثواني صحيح. يدعم:
 *   - رقم صرف (بدون وحدة) -> يُفهم كثواني (توافق خلفي مع السلوك القديم).
 *   - "<رقم>s" / "<رقم>m" / "<رقم>h" -> ثواني/دقائق/ساعات.
 * يرجّع null لو الصيغة غير صالحة إطلاقاً - executeSlowmode يتحقق بعدها
 * من نطاق ديسكورد الفعلي (0-21600).
 */
function parseSlowmodeDuration(input) {
    if (!input) return null;
    const trimmed = String(input).trim().toLowerCase();

    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10); // رقم صرف = ثواني

    const match = trimmed.match(/^(\d+)\s*(s|m|h)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const multiplier = { s: 1, m: 60, h: 3600 }[match[2]];
    return value * multiplier;
}

// ----------------------------------------------------------------------
// 1. CORE LOGIC: executeSlowmode (يُستخدم لكل من slowmode و unslow)
// ----------------------------------------------------------------------
async function executeSlowmode(guild, channelId, seconds, moderator, reason) {
    try {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) return { success: false, error: "Channel not found in this server." };
        if (!channel.isTextBased || !channel.isTextBased()) {
            return { success: false, error: "This channel type does not support slowmode." };
        }

        const botMember = guild.members.me;
        if (!channel.permissionsFor(botMember)?.has(PermissionsBitField.Flags.ManageChannels)) {
            return { success: false, error: "I don't have 'Manage Channels' permission in this channel." };
        }

        // ديسكورد يقبل 0 (تعطيل) لين 21600 ثانية (6 ساعات) - أقصى حد فعلي بالـ API
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
            return { success: false, error: "Slowmode must be between 0 and 21600 seconds (6 hours). Examples: `30s`, `10m`, `2h`." };
        }

        await channel.setRateLimitPerUser(seconds, `${reason} | Set by: ${moderator.user.tag}`);
        return { success: true, channelName: channel.name, seconds };
    } catch (err) {
        console.error('[Slowmode Engine Error]:', err);
        return { success: false, error: "Internal error while setting slowmode." };
    }
}

// ----------------------------------------------------------------------
// 2. CORE LOGIC: executeNick (يُستخدم لكل من nick و removenick)
// ----------------------------------------------------------------------
async function executeNick(guild, targetId, newNick, moderator) {
    try {
        const target = await guild.members.fetch(targetId).catch(() => null);
        if (!target) return { success: false, error: "Member not found in this server." };

        // manageable = يتحقق تلقائياً من هرمية الرتب بين البوت والعضو المستهدف
        if (!target.manageable) {
            return { success: false, error: "I can't change this member's nickname (their highest role may be above or equal to mine)." };
        }

        // هرمية المشرف نفسه مقابل الهدف - ما يقدر يغيّر نك شخص برتبة مساوية/أعلى
        // منه إلا لو هو مالك السيرفر (نفس منطق أوامر العقوبات الثانية بالمشروع)
        const isOwner = guild.ownerId === moderator.id;
        if (!isOwner && target.roles.highest.position >= moderator.roles.highest.position) {
            return { success: false, error: "You cannot change the nickname of a member with an equal or higher role than you." };
        }

        const oldNick = target.displayName;
        await target.setNickname(newNick || null, `Changed by: ${moderator.user.tag}`);

        return { success: true, targetTag: target.user.tag, oldNick, newNick: newNick || target.user.username };
    } catch (err) {
        console.error('[Nick Engine Error]:', err);
        return { success: false, error: "Internal error while changing the nickname." };
    }
}

// ----------------------------------------------------------------------
// 3. CORE LOGIC: executeAvatar
// ----------------------------------------------------------------------
async function executeAvatar(target) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR_INFO)
        .setTitle(`${target.user.tag}'s Avatar`)
        .setImage(target.user.displayAvatarURL({ size: 1024, extension: 'png' }))
        .setTimestamp();

    // [NOTE] alreadyHandled = true - الإيمبيد هنا مخصص (فيه صورة كبيرة)، مو
    // شكل النجاح العام (اسم قناة/عضو + Reason) اللي يبنيه الـ dispatcher تحت.
    return { success: true, embed, alreadyHandled: true };
}

// ----------------------------------------------------------------------
// 4. CORE LOGIC: executeInvites
// ----------------------------------------------------------------------
async function executeInvites(guild, targetUser) {
    try {
        const botMember = guild.members.me;
        if (!botMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return { success: false, error: "I don't have 'Manage Server' permission, which Discord requires to view server invites." };
        }

        const invites = await guild.invites.fetch();
        const userInvites = invites.filter(inv => inv.inviter?.id === targetUser.id);
        const totalUses = userInvites.reduce((sum, inv) => sum + (inv.uses || 0), 0);

        return { success: true, targetTag: targetUser.tag, inviteLinks: userInvites.size, totalUses };
    } catch (err) {
        console.error('[Invites Engine Error]:', err);
        return { success: false, error: "Internal error while fetching invites." };
    }
}

// ----------------------------------------------------------------------
// 5. POLL - [v2.0 REWRITE] تصويت بالأزرار، بدون "|", إيموجي مخصص اختياري،
//    أسماء خيارات حرة، --time، --anon. راجع events/pollPanel.js لكل منطق
//    البناء/النشر/عدّاد الأصوات/الإغلاق - هذا القسم مسؤول بس عن "فهم" ما
//    كتبه المستخدم بالأمر وتحويله لبيانات نظيفة تُمرَّر لـ pollPanel.js.
// ----------------------------------------------------------------------

// رموز الترقيم الافتراضية - تُستخدم لأي خيار ما حدد له المستخدم إيموجي
// مخصص بنفسه (لين 10 خيارات، نفس الحد الأقصى المسموح بالاستطلاع).
const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// يطابق إيموجي (يونيكود عادي أو إيموجي مخصص بديسكورد <a:name:id>) بأول
// الخيار متبوع بمسافة فأكثر ثم باقي النص كتسمية. لو ما فيه تطابق، الخيار
// كامل يُعتبر تسمية والإيموجي الافتراضي (رقمي) يُستخدم بدلاً منه.
const EMOJI_PREFIX_REGEX = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200d\p{Extended_Pictographic})*|<a?:\w+:\d+>)\s+(.+)$/u;

function parsePollOptionToken(token, fallbackEmoji) {
    const match = token.match(EMOJI_PREFIX_REGEX);
    if (match) {
        return { emoji: match[1], label: match[2].trim() };
    }
    return { emoji: fallbackEmoji, label: token.trim() };
}

/**
 * يفصل الأعلام (--time/--anon) عن باقي النص، ثم يستخرج كل النصوص
 * المحصورة بين علامتي اقتباس " " كمصفوفة (أول وحدة = السؤال، الباقي
 * خيارات). الاقتباس إجباري لكل جزء - يمنع أي لبس بمسافات النصوص الحرة.
 */
function parsePollArgs(rawContent) {
    let content = rawContent;
    let anonymous = false;
    let durationStr = null;

    content = content.replace(/--anon(?:ymous)?\b/gi, () => { anonymous = true; return ' '; });
    content = content.replace(/--time\s+(\S+)/i, (_, d) => { durationStr = d; return ' '; });

    const tokens = [...content.matchAll(/"([^"]*)"/g)]
        .map(m => m[1].trim())
        .filter(t => t.length > 0);

    return { tokens, anonymous, durationStr };
}

const POLL_USAGE = 'Usage: `!poll "Question" "Option 1" "Option 2" ... [--time 1h] [--anon]`\n' +
    'Add a custom emoji to any option by putting it right before the text, e.g. `"🍕 Pepperoni"`.\n' +
    'Leave out all options for a quick Yes/No poll: `!poll "Is pineapple on pizza okay?"`';

async function handlePollCommand(message, rawContent) {
    const { tokens, anonymous, durationStr } = parsePollArgs(rawContent);

    const question = tokens[0];
    if (!question) {
        return message.reply(`❌ ${POLL_USAGE}`);
    }
    if (question.length > 256) {
        return message.reply('❌ The poll question must be 256 characters or fewer.');
    }

    const optionTokens = tokens.slice(1);
    let options;

    if (optionTokens.length === 0) {
        options = DEFAULT_OPTIONS_YES_NO;
    } else {
        if (optionTokens.length === 1) {
            return message.reply(`❌ A poll needs at least 2 options, or none at all for a quick Yes/No poll.\n${POLL_USAGE}`);
        }
        if (optionTokens.length > MAX_POLL_OPTIONS) {
            return message.reply(`❌ A poll can have a maximum of ${MAX_POLL_OPTIONS} options.`);
        }

        options = optionTokens.map((token, i) => parsePollOptionToken(token, NUMBER_EMOJIS[i]));

        const tooLong = options.find(opt => opt.label.length > 80);
        if (tooLong) {
            return message.reply(`❌ Each option label must be 80 characters or fewer. "${tooLong.label.slice(0, 40)}..." is too long.`);
        }
    }

    let endsAt = null;
    if (durationStr) {
        const ms = parsePollDurationToMs(durationStr);
        if (!ms) {
            return message.reply('❌ Invalid `--time` value. Use formats like `30s`, `10m`, `2h`, `1d` (minimum 10 seconds, maximum 30 days).');
        }
        endsAt = new Date(Date.now() + ms).toISOString();
    }

    try {
        await createAndPublishPoll(message.channel, {
            guildId: message.guild.id,
            channelId: message.channel.id,
            creatorId: message.author.id,
            question,
            options,
            anonymous,
            endsAt,
        });
        return { success: true, alreadyHandled: true };
    } catch (err) {
        console.error('[Poll Command Error]:', err.message);
        return { success: false, error: err.message || 'Failed to create the poll.' };
    }
}

// ----------------------------------------------------------------------
// 6. ENDPOLL - [v2.0 NEW] يقفل استطلاع قبل وقته المحدد (أو استطلاع
//    بدون --time إطلاقاً) ويعرض النتائج النهائية فوراً.
// ----------------------------------------------------------------------
async function handleEndPollCommand(message, args) {
    const targetMessageId = message.reference?.messageId || args[0];

    if (!targetMessageId) {
        return message.reply('❌ Reply to the poll message with `!endpoll`, or use `!endpoll <messageId>`.');
    }

    const pollRow = await getPollByMessageId(targetMessageId, message.guild.id);
    if (!pollRow) {
        return message.reply('❌ No active poll found for that message.');
    }
    if (pollRow.closed) {
        return message.reply('❌ This poll has already ended.');
    }

    const isCreator = pollRow.id_creator === message.author.id;
    const hasManageMessages = message.member.permissions.has(PermissionsBitField.Flags.ManageMessages);
    if (!isCreator && !hasManageMessages) {
        return message.reply("❌ Only the poll creator or a moderator with 'Manage Messages' permission can end this poll.");
    }

    try {
        await closePoll(message.client, pollRow);
        return message.reply('✅ Poll closed — final results have been posted above.');
    } catch (err) {
        console.error('[EndPoll Command Error]:', err.message);
        return message.reply(`❌ Error: ${err.message || 'Failed to close the poll.'}`);
    }
}

// ----------------------------------------------------------------------
// 7. PREFIX HANDLER (Auto-Loading Entry Point) - single dispatcher for
//    all commands, exact same shape lock.js uses for lock/unlock.
// ----------------------------------------------------------------------
async function run(message, dbUtils) {
    // [v2.0 NOTE] ما نستخدم split(/\s+/) العام لاستخراج الأمر بس - لازم
    // نحافظ على النص الخام (rawRest) لأمر poll عشان علامات الاقتباس "
    // ما تنكسر. args (مقسّمة بمسافات) لسا تُبنى وتُستخدم بباقي الأوامر
    // زي القديم بالضبط - صفر تغيير بسلوكهم.
    const trimmedContent = message.content.trim();
    const firstSpaceIdx = trimmedContent.search(/\s/);
    const command = (firstSpaceIdx === -1 ? trimmedContent : trimmedContent.slice(0, firstSpaceIdx)).toLowerCase();
    const rawRest = firstSpaceIdx === -1 ? '' : trimmedContent.slice(firstSpaceIdx + 1).trim();
    const args = rawRest.length ? rawRest.split(/\s+/) : [];

    const validCommands = ['slowmode', 'unslow', 'nick', 'removenick', 'poll', 'endpoll', 'avatar', 'invites'];
    if (!validCommands.includes(command)) return;

    let result;
    let successTitle = '';
    let successFields = [];

    if (command === 'slowmode' || command === 'unslow') {
        // [PERM] فحص يدوي - راجع الملاحظة بأعلى الملف
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
            return message.reply("❌ You lack 'Manage Channels' permission.");
        }

        let targetChannel = message.channel;
        let seconds;
        let reasonArgs;

        if (command === 'unslow') {
            // !unslow [#channel] [reason] - أول توكن ممكن يكون قناة، وإلا القناة الحالية
            seconds = 0;
            const maybeChannel = args[0] ? resolveTargetChannel(message.guild, args[0]) : null;
            if (maybeChannel) {
                targetChannel = maybeChannel;
                reasonArgs = args.slice(1);
            } else {
                reasonArgs = args;
            }
        } else {
            // !slowmode <duration> [#channel] [reason]
            const parsedSeconds = parseSlowmodeDuration(args[0]);
            if (parsedSeconds === null) {
                return message.reply('❌ Invalid duration. Use formats like `30s`, `10m`, `2h` (or a plain number of seconds).');
            }
            seconds = parsedSeconds;

            const maybeChannel = args[1] ? resolveTargetChannel(message.guild, args[1]) : null;
            if (maybeChannel) {
                targetChannel = maybeChannel;
                reasonArgs = args.slice(2);
            } else {
                reasonArgs = args.slice(1);
            }
        }

        const reason = reasonArgs.join(' ') || (command === 'unslow' ? 'Slowmode removed' : 'No reason provided');

        result = await executeSlowmode(message.guild, targetChannel.id, seconds, message.member, reason);
        successTitle = command === 'unslow' ? '🐌 Slowmode Removed' : '🐌 Slowmode Updated';
        successFields = result.success ? [
            { name: 'Channel', value: `#${result.channelName}`, inline: true },
            { name: 'Delay', value: result.seconds === 0 ? 'Disabled' : `${result.seconds}s`, inline: true },
            { name: 'Moderator', value: message.author.tag, inline: true },
            { name: 'Reason', value: reason }
        ] : [];

    } else if (command === 'nick' || command === 'removenick') {
        // [PERM] فحص يدوي - راجع الملاحظة بأعلى الملف
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
            return message.reply("❌ You lack 'Manage Nicknames' permission.");
        }

        const targetId = message.mentions.members?.first()?.id || args[0];
        if (!targetId) {
            return message.reply(`❌ Please mention a member. Usage: \`!${command}${command === 'nick' ? ' @member [new nickname]' : ' @member'}\``);
        }

        // removenick يفرض نك فاضي دائماً (تصفير) - nick يستخدم الباقي (فاضي = تصفير برضه)
        const newNick = command === 'removenick' ? '' : args.slice(1).join(' ');

        result = await executeNick(message.guild, targetId, newNick, message.member);
        successTitle = command === 'removenick' ? '🔄 Nickname Reset' : '✏️ Nickname Changed';
        successFields = result.success ? [
            { name: 'Member', value: result.targetTag, inline: true },
            { name: 'Old Nickname', value: result.oldNick, inline: true },
            { name: 'New Nickname', value: result.newNick, inline: true },
            { name: 'Moderator', value: message.author.tag }
        ] : [];

    } else if (command === 'poll') {
        // بدون صلاحية - متاح للكل عمداً (راجع الجدول بأعلى الملف)
        result = await handlePollCommand(message, rawRest);
        if (!result) return; // handlePollCommand رد بنفسه مباشرة (رسالة استخدام/خطأ تحقق)

    } else if (command === 'endpoll') {
        // بدون صلاحية عامة - الفحص (منشئ الاستطلاع أو Manage Messages) داخل الدالة نفسها
        return handleEndPollCommand(message, args);

    } else if (command === 'avatar') {
        // بدون صلاحية - متاح للكل عمداً
        const target = message.mentions.members?.first()
            || (args[0] && await message.guild.members.fetch(args[0]).catch(() => null))
            || message.member;

        result = await executeAvatar(target);

    } else if (command === 'invites') {
        // بدون صلاحية للعضو - الفحص الوحيد داخل executeInvites للبوت نفسه
        const targetUser = message.mentions.users?.first()
            || (args[0] && await message.client.users.fetch(args[0]).catch(() => null))
            || message.author;

        result = await executeInvites(message.guild, targetUser);
        successTitle = '📨 Invite Stats';
        successFields = result.success ? [
            { name: 'Member', value: result.targetTag, inline: true },
            { name: 'Active Invite Links', value: String(result.inviteLinks), inline: true },
            { name: 'Total Uses', value: String(result.totalUses), inline: true }
        ] : [];
    }

    if (!result.success) {
        return message.reply(`❌ Error: ${result.error}`);
    }

    // تسجيل استخدام الأمر (log_command_bot - بدون قيود على القيم، نفس نمط lock.js)
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

    // poll و avatar يبنون ويرسلون الـ Embed الخاص فيهم بنفسهم (alreadyHandled)
    if (result.alreadyHandled) {
        if (result.embed) return message.channel.send({ embeds: [result.embed] });
        return; // poll خلص إرساله + أزرار التصويت فوق بـ handlePollCommand/pollPanel.js
    }

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR_SUCCESS)
        .setTitle(successTitle)
        .addFields(...successFields)
        .setTimestamp();

    return message.channel.send({ embeds: [embed] });
}

module.exports = {
    name: 'slowmode',
    aliases: ['unslow', 'nick', 'removenick', 'poll', 'endpoll', 'avatar', 'invites'],
    description: 'Utility command bundle: slowmode, unslow, nick, removenick, poll, endpoll, avatar, invites',
    // [IMPORTANT] permissions عمداً بدون تحديد - راجع ملاحظة التصميم بأعلى
    // الملف. كل أمر يتحقق من صلاحيته الخاصة يدوياً جوة run().
    executeSlowmode,
    executeNick,
    executeAvatar,
    executeInvites,
    run
};