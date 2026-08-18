// =====================================================================
// PollManagement.js
// ---------------------------------------------------------------------
// المسؤوليات:
//   1) معالجة ضغطات أزرار التصويت (interactionCreate) - custom_id بصيغة
//      "poll_vote_<pollId>_<optionIndex>" -> يسجّل/يبدّل صوت العضو، يرد
//      عليه بتأكيد خاص (ephemeral)، ويحدّث عدّاد الأصوات بالرسالة حياً.
//   2) سكجولر (setInterval) يفحص كل الاستطلاعات اللي عندها --time محدد
//      ووصل وقتها، ويقفلها تلقائياً (نفس فكرة سكجولر role_removal_schedule
//      القديم - بس هذا لاستطلاعات، مو رتب).
//
// ⚠️ هذا الملف "مو أمر شات حقيقي" — لازم يُستثنى بالاسم من commandhandler.js
//    (نفس طريقة استثناء AutoMod.js / Rolemanagement.js)
//
// طريقة الاستخدام (تسويها انت بـ index.js):
//    require('./commands/PollManagement.js')(client);
// =====================================================================

const {
    extractPollVoteFromCustomId,
    getPollById,
    castVote,
    refreshPollMessage,
    getDuePolls,
    closePoll,
} = require('../events/pollPanel.js');

const SCHEDULER_INTERVAL_MS = 30 * 1000; // نفس فترة سكجولر الرتب القديم بالضبط

async function handlePollVoteButton(interaction) {
    const parsed = extractPollVoteFromCustomId(interaction.customId);
    if (!parsed) return;

    const { pollId, optionIndex } = parsed;

    const pollRow = await getPollById(pollId);
    if (!pollRow) {
        await interaction.reply({ content: 'This poll no longer exists.', ephemeral: true }).catch(() => {});
        return;
    }

    if (pollRow.closed) {
        await interaction.reply({ content: 'This poll has already ended.', ephemeral: true }).catch(() => {});
        return;
    }

    const option = (pollRow.options || [])[optionIndex];
    if (!option) {
        await interaction.reply({ content: 'This option no longer exists.', ephemeral: true }).catch(() => {});
        return;
    }

    try {
        await castVote(pollId, interaction.user.id, optionIndex);
        await interaction.reply({ content: `✅ Your vote for **${option.label}** has been recorded.`, ephemeral: true });
        await refreshPollMessage(interaction.channel, pollRow);
    } catch (err) {
        console.error('[PollManagement] Failed to process vote:', err.message);
        await interaction.reply({ content: 'Something went wrong while recording your vote. Please try again.', ephemeral: true }).catch(() => {});
    }
}

async function processDuePolls(client) {
    try {
        const duePolls = await getDuePolls();
        if (duePolls.length === 0) return;

        for (const pollRow of duePolls) {
            try {
                await closePoll(client, pollRow);
                console.log(`[PollManagement] Auto-closed poll #${pollRow.id} ("${pollRow.question}") in guild ${pollRow.id_guild} after its --time expired.`);
            } catch (err) {
                console.error(`[PollManagement] Failed to auto-close poll #${pollRow.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[PollManagement] Unexpected error in poll scheduler:', err);
    }
}

module.exports = (client) => {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;
        if (!interaction.customId?.startsWith('poll_vote_')) return;

        try {
            await handlePollVoteButton(interaction);
        } catch (err) {
            console.error('[PollManagement] Error in interactionCreate handler:', err);
        }
    });

    client.once('ready', () => {
        processDuePolls(client);
        setInterval(() => processDuePolls(client), SCHEDULER_INTERVAL_MS);
        console.log(`[PollManagement] Poll auto-close scheduler started (every ${SCHEDULER_INTERVAL_MS / 1000} seconds).`);
    });

    console.log('[PollManagement] Event listeners initialized (interactionCreate).');
};