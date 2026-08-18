// =====================================================================
// pollPanel.js
// ---------------------------------------------------------------------
// مسؤول عن كل تفاعل هذا الملف مع ديسكورد + قاعدة البيانات لميزة
// Interactive Polls (بناء الـ Embed + أزرار الخيارات، نشرها، تحديث
// عدّاد الأصوات الحي، إغلاقها وعرض النتائج النهائية) - نفس فلسفة
// reactionRolePanel.js بالضبط: ملف "مساعد" بدون أي تسجيل أحداث client
// بداخله - يُستخدم من طرف commands/PollManagement.js (اللي يسجّل
// الأحداث الفعلية) ومن طرف Anothercommands.js (أمر !poll/!endpoll).
//
// [تصميم مهم] التصويت بالأزرار (Buttons) مو بالريأكشنات (Reactions) -
// قرار متعمّد: الريأكشنات بطبيعتها عامة 100% (أي حد يقدر يشوف مين ضغط
// أي إيموجي)، فما تقدر تحقق "استطلاع مجهول" ولا "صوت واحد لكل شخص
// يقدر يغيّره" بشكل موثوق فيها. الأزرار تسمح لنا نتحكم بالتصويت بالكامل
// من قاعدة البيانات (upsert بمفتاح UNIQUE(id_poll, id_user))، ونرد
// بتأكيد خاص (ephemeral) ما يشوفه غير الشخص نفسه.
//
// لا يوجد أي جدول متعلق بهذا الملف على مسار الداشبورد (Poll مو ميزة
// داشبورد إطلاقاً - أمر شات بحت) - لذلك كل استعلامات Supabase هنا
// مباشرة، بدون المرور على databaseQueries.js (نفس قرار Rolemanagement.js
// بالضبط مع setting_management_role).
// =====================================================================

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const supabase = require('../supabase/db.js');

const TABLE_POLL = 'reaction_poll';
const TABLE_VOTE = 'poll_vote';

const MAX_POLL_OPTIONS = 10;
const CUSTOM_ID_PREFIX = 'poll_vote_';
const OPTION_BUTTON_STYLES = [ButtonStyle.Primary, ButtonStyle.Success, ButtonStyle.Secondary];

const DEFAULT_OPTIONS_YES_NO = [
    { emoji: '👍', label: 'Yes' },
    { emoji: '👎', label: 'No' },
];

function buildCustomId(pollId, optionIndex) {
    return `${CUSTOM_ID_PREFIX}${pollId}_${optionIndex}`;
}

/**
 * يرجّع {pollId, optionIndex} لو كان زر تصويت فعلاً، وإلا null.
 * تُستخدم من commands/PollManagement.js بحدث interactionCreate.
 */
function extractPollVoteFromCustomId(customId) {
    if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
    const rest = customId.slice(CUSTOM_ID_PREFIX.length); // "<pollId>_<optionIndex>"
    const parts = rest.split('_');
    if (parts.length !== 2) return null;
    const pollId = parts[0];
    const optionIndex = parseInt(parts[1], 10);
    if (!pollId || !Number.isInteger(optionIndex)) return null;
    return { pollId, optionIndex };
}

// =====================================================================
// تحويل مدة نصية (30s, 10m, 2h, 1d, 1w) إلى ميلي ثانية. نفس الصيغة
// المستخدمة بباقي المشروع. الحد الأدنى 10 ثواني (يمنع --time عبثي)،
// الحد الأقصى 30 يوم.
// =====================================================================
function parsePollDurationToMs(input) {
    if (!input || typeof input !== 'string') return null;
    const match = input.trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const unitToMs = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
    const ms = value * unitToMs[unit];

    if (ms < 10 * 1000) return null;          // أقل من 10 ثواني - مرفوض
    if (ms > 30 * 86400000) return null;       // أكثر من 30 يوم - مرفوض
    return ms;
}

// =====================================================================
// جلب عدّاد الأصوات الحالي لكل خيار (Map: optionIndex -> count) + عدد
// المصوّتين الكلي + (لو مو مجهول) قائمة المصوّتين لكل خيار.
// =====================================================================
async function getPollVoteTallies(pollId) {
    const { data, error } = await supabase
        .from(TABLE_VOTE)
        .select('id_user, option_index')
        .eq('id_poll', pollId);

    if (error) {
        console.error('[PollPanel] Failed to fetch votes:', error.message);
        return { counts: new Map(), voters: new Map(), total: 0 };
    }

    const counts = new Map();
    const voters = new Map(); // optionIndex -> [userId, ...]
    for (const row of data || []) {
        counts.set(row.option_index, (counts.get(row.option_index) || 0) + 1);
        if (!voters.has(row.option_index)) voters.set(row.option_index, []);
        voters.get(row.option_index).push(row.id_user);
    }

    return { counts, voters, total: (data || []).length };
}

// =====================================================================
// بناء الـ Embed (يُستخدم للحالتين: مفتوح وحي، أو مُغلق مع النتائج)
// =====================================================================
function buildPollEmbed(pollRow, tallies, { closed = false } = {}) {
    const options = pollRow.options || [];
    const total = tallies.total || 0;

    const lines = options.map((opt, index) => {
        const count = tallies.counts.get(index) || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const filledBlocks = total > 0 ? Math.round(pct / 10) : 0;
        const bar = '▰'.repeat(filledBlocks) + '▱'.repeat(10 - filledBlocks);

        let line = `${opt.emoji} **${opt.label}**\n${bar}  ${pct}% (${count} vote${count === 1 ? '' : 's'})`;

        if (closed && !pollRow.anonymous && count > 0) {
            const voterIds = tallies.voters.get(index) || [];
            const shown = voterIds.slice(0, 10).map(id => `<@${id}>`).join(', ');
            const extra = voterIds.length > 10 ? ` and ${voterIds.length - 10} more` : '';
            line += `\n> ${shown}${extra}`;
        }

        return line;
    });

    const embed = new EmbedBuilder()
        .setColor(closed ? 0x99a1ac : 0x5865f2)
        .setTitle(`📊 ${pollRow.question}`)
        .setDescription(lines.join('\n\n'))
        .setTimestamp();

    const footerParts = [`${total} total vote${total === 1 ? '' : 's'}`];
    if (pollRow.anonymous) footerParts.push('🔒 Anonymous');
    if (closed) {
        footerParts.push('Poll ended');
    } else if (pollRow.ends_at) {
        footerParts.push(`Ends`);
    }
    embed.setFooter({ text: footerParts.join(' • ') });

    if (!closed && pollRow.ends_at) {
        const endsUnix = Math.floor(new Date(pollRow.ends_at).getTime() / 1000);
        embed.addFields({ name: '\u200b', value: `Closes <t:${endsUnix}:R>` });
    }

    return embed;
}

/**
 * أزرار الخيارات - تُعطّل كلها (disabled) لو الاستطلاع مغلق، عشان
 * الرسالة القديمة توضح بصرياً إنها ما عادت تقبل تصويت.
 */
function buildPollComponents(pollRow, { closed = false } = {}) {
    const options = pollRow.options || [];
    const rows = [];

    for (let i = 0; i < options.length; i += 5) {
        const rowOptions = options.slice(i, i + 5).map((opt, offset) => {
            const index = i + offset;
            return new ButtonBuilder()
                .setCustomId(buildCustomId(pollRow.id, index))
                .setLabel(opt.label.slice(0, 80))
                .setEmoji(opt.emoji)
                .setStyle(OPTION_BUTTON_STYLES[index % OPTION_BUTTON_STYLES.length])
                .setDisabled(closed);
        });
        rows.push(new ActionRowBuilder().addComponents(rowOptions));
    }

    return rows;
}

// =====================================================================
// إنشاء استطلاع جديد بقاعدة البيانات + نشره فعلياً بديسكورد.
// @param {{guildId, channelId, creatorId, question, options, anonymous, endsAt}} data
// options: [{emoji, label}], endsAt: ISO string أو null
// =====================================================================
async function createAndPublishPoll(channel, data) {
    const { data: pollRow, error } = await supabase
        .from(TABLE_POLL)
        .insert({
            id_guild: data.guildId,
            id_channel: data.channelId,
            id_creator: data.creatorId,
            question: data.question,
            options: data.options,
            anonymous: !!data.anonymous,
            ends_at: data.endsAt || null,
        })
        .select()
        .single();

    if (error) {
        console.error('[PollPanel] Failed to create poll row:', error.message);
        throw new Error('Could not create the poll in the database.');
    }

    const tallies = { counts: new Map(), voters: new Map(), total: 0 };
    const message = await channel.send({
        embeds: [buildPollEmbed(pollRow, tallies, { closed: false })],
        components: buildPollComponents(pollRow, { closed: false }),
    });

    const { error: updateErr } = await supabase
        .from(TABLE_POLL)
        .update({ id_message: message.id })
        .eq('id', pollRow.id);

    if (updateErr) console.error('[PollPanel] Failed to store poll message id:', updateErr.message);

    pollRow.id_message = message.id;
    return { pollRow, message };
}

async function getPollByMessageId(messageId, guildId) {
    const { data, error } = await supabase
        .from(TABLE_POLL)
        .select('*')
        .eq('id_message', messageId)
        .eq('id_guild', guildId)
        .maybeSingle();

    if (error) {
        console.error('[PollPanel] Failed to fetch poll by message id:', error.message);
        return null;
    }
    return data;
}

async function getPollById(pollId) {
    const { data, error } = await supabase.from(TABLE_POLL).select('*').eq('id', pollId).maybeSingle();
    if (error) {
        console.error('[PollPanel] Failed to fetch poll by id:', error.message);
        return null;
    }
    return data;
}

/**
 * يسجّل/يبدّل صوت عضو (upsert بمفتاح UNIQUE(id_poll, id_user) - يستبدل
 * الصوت القديم تلقائياً لو صوّت لخيار ثاني).
 */
async function castVote(pollId, userId, optionIndex) {
    const { error } = await supabase
        .from(TABLE_VOTE)
        .upsert({ id_poll: pollId, id_user: userId, option_index: optionIndex, voted_at: new Date().toISOString() }, { onConflict: 'id_poll,id_user' });

    if (error) {
        console.error('[PollPanel] Failed to cast vote:', error.message);
        throw new Error('Could not record your vote.');
    }
}

/**
 * يحدّث رسالة الاستطلاع الحية بعدّاد الأصوات الجديد (تُستدعى بعد كل صوت).
 */
async function refreshPollMessage(channel, pollRow) {
    const message = await channel.messages.fetch(pollRow.id_message).catch(() => null);
    if (!message) return;

    const tallies = await getPollVoteTallies(pollRow.id);
    await message.edit({
        embeds: [buildPollEmbed(pollRow, tallies, { closed: false })],
        components: buildPollComponents(pollRow, { closed: false }),
    }).catch(() => {});
}

/**
 * يغلق استطلاع (سواء يدوياً عبر !endpoll أو تلقائياً من السكجولر عند
 * انتهاء --time): يعلّمه closed بقاعدة البيانات، ويعدّل رسالته الأصلية
 * بالنتائج النهائية + تعطيل الأزرار.
 */
async function closePoll(client, pollRow) {
    const { error } = await supabase
        .from(TABLE_POLL)
        .update({ closed: true })
        .eq('id', pollRow.id);

    if (error) {
        console.error('[PollPanel] Failed to mark poll closed:', error.message);
        throw new Error('Could not close the poll in the database.');
    }

    const tallies = await getPollVoteTallies(pollRow.id);

    try {
        const channel = await client.channels.fetch(pollRow.id_channel).catch(() => null);
        if (!channel) return tallies;
        const message = await channel.messages.fetch(pollRow.id_message).catch(() => null);
        if (!message) return tallies;

        await message.edit({
            embeds: [buildPollEmbed(pollRow, tallies, { closed: true })],
            components: buildPollComponents(pollRow, { closed: true }),
        });
    } catch (err) {
        console.error('[PollPanel] Failed to edit poll message on close (non-fatal):', err.message);
    }

    return tallies;
}

/**
 * يرجّع كل الاستطلاعات اللي وصل وقت انتهائها (--time) وما زالت مفتوحة -
 * تُستخدم من سكجولر PollManagement.js.
 */
async function getDuePolls() {
    const { data, error } = await supabase
        .from(TABLE_POLL)
        .select('*')
        .eq('closed', false)
        .not('ends_at', 'is', null)
        .lte('ends_at', new Date().toISOString())
        .limit(50);

    if (error) {
        console.error('[PollPanel] Failed to fetch due polls:', error.message);
        return [];
    }
    return data || [];
}

module.exports = {
    MAX_POLL_OPTIONS,
    DEFAULT_OPTIONS_YES_NO,
    buildCustomId,
    extractPollVoteFromCustomId,
    parsePollDurationToMs,
    getPollVoteTallies,
    buildPollEmbed,
    buildPollComponents,
    createAndPublishPoll,
    getPollByMessageId,
    getPollById,
    castVote,
    refreshPollMessage,
    closePoll,
    getDuePolls,
};