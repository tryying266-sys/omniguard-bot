// =====================================================================
// reactionRolePanel.js
// ---------------------------------------------------------------------
// مسؤول عن كل تفاعل هذا الملف مع ديسكورد الفعلي لميزة Reaction/Button
// Roles (بناء الـ Embed + الأزرار، نشرها، تعديلها في مكانها، حذفها) -
// نفس فلسفة events/ticketPanel.js (postOrUpdatePanel) بالضبط، لكن لكرت
// واحد مستقل بدل لوحة تذاكر واحدة ثابتة لكل سيرفر.
//
// ⚠️ هذا الملف "مو أمر شات حقيقي" ولا يُستدعى من commandhandler.js إطلاقاً
//    (يُستدعى فقط من apiRouter.js ومن Rolemanagement.js لمعالجة ضغطات
//    الأزرار) - يحتاج نفس استثناء الاسم لو مجلد الأوامر يفحص كل الملفات.
//
// حدود ديسكورد المُطبَّقة هنا:
//   - 5 أزرار كحد أقصى بكل صف (ActionRow)، 5 صفوف كحد أقصى بكل رسالة.
//   - حد المشروع نفسه (فرضه المطور): 15 زر كحد أقصى بكل كرت/Embed -
//     يُفرض فعلياً بـ apiRouter.js قبل ما توصل البيانات هنا، لكن
//     buildReactionRoleComponents() تحترمه دفاعياً أيضاً (تتجاهل أي زر
//     زايد عن 15 بدل ما تكسر أو ترمي خطأ غامض من ديسكورد نفسه).
// =====================================================================

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

const MAX_BUTTONS_PER_EMBED = 15;
const BUTTONS_PER_ROW = 5;

// custom_id الخاص بأزرار Reaction Roles: "rr_toggle_<roleId>". معرّفات
// الرتب بديسكورد (Snowflakes) فريدة عالمياً، فما نحتاج نضمّن id_embed
// أو id_guild بالـ custom_id عشان نعرف أي رتبة يقصدها الضغط.
const CUSTOM_ID_PREFIX = 'rr_toggle_';

function buildCustomId(roleId) {
    return `${CUSTOM_ID_PREFIX}${roleId}`;
}

/**
 * يرجّع roleId من custom_id لو كان زر Reaction Role فعلاً، وإلا null.
 * تُستخدم من Rolemanagement.js بحدث interactionCreate.
 */
function extractRoleIdFromCustomId(customId) {
    if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
    const roleId = customId.slice(CUSTOM_ID_PREFIX.length);
    return roleId || null;
}

const STYLE_MAP = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
};

/**
 * يبني [EmbedBuilder] من صف reaction_role_embed (لون افتراضي أحمر لو
 * embed_color غير موجود/غير صالح - نفس accent-red الأساسي للمشروع).
 */
function buildReactionRoleEmbed(embedRow) {
    const embed = new EmbedBuilder();
    if (embedRow.embed_title) embed.setTitle(embedRow.embed_title);
    if (embedRow.embed_description) embed.setDescription(embedRow.embed_description);

    let color = 0xff3344;
    if (embedRow.embed_color && /^#?[0-9a-fA-F]{6}$/.test(embedRow.embed_color)) {
        color = parseInt(embedRow.embed_color.replace('#', ''), 16);
    }
    embed.setColor(color);

    return embed;
}

/**
 * يبني مصفوفة [ActionRowBuilder] من أزرار الكرت (مرتبة sort_order مسبقاً
 * من databaseQueries.js). يقصّها لـ 5 بكل صف تلقائياً.
 */
function buildReactionRoleComponents(buttons) {
    const limited = (buttons || []).slice(0, MAX_BUTTONS_PER_EMBED);
    const rows = [];

    for (let i = 0; i < limited.length; i += BUTTONS_PER_ROW) {
        const rowButtons = limited.slice(i, i + BUTTONS_PER_ROW).map((btn) => {
            const b = new ButtonBuilder()
                .setCustomId(buildCustomId(btn.id_role))
                .setLabel(btn.button_label || 'Role')
                .setStyle(STYLE_MAP[btn.button_style] || ButtonStyle.Secondary);

            if (btn.button_emoji) {
                try { b.setEmoji(btn.button_emoji); } catch (_) { /* إيموجي غير صالح - نتجاهله بدل ما نكسر النشر كامل */ }
            }

            return b;
        });

        rows.push(new ActionRowBuilder().addComponents(rowButtons));
    }

    return rows;
}

/**
 * ينشر رسالة جديدة بالقناة المحددة لكرت لسه ما نُشر (أو نُقل لقناة
 * جديدة). يرمي خطأ واضح لو تعذّر (البوت مو بالسيرفر/ما عنده صلاحية/
 * القناة انحذفت) - apiRouter.js يحوّله لرد خطأ واضح للداشبورد.
 * @returns {Promise<{channelId: string, messageId: string}>}
 */
async function publishReactionRoleEmbed(client, guildId, embedRow) {
    if (!client.isReady()) throw new Error('Bot is not ready yet.');

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new Error('Bot is not in this server.');

    const channel = await guild.channels.fetch(embedRow.id_channel).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        throw new Error('Target channel not found or is not a text channel.');
    }

    const message = await channel.send({
        embeds: [buildReactionRoleEmbed(embedRow)],
        components: buildReactionRoleComponents(embedRow.buttons),
    });

    return { channelId: channel.id, messageId: message.id };
}

/**
 * يحذف رسالة ديسكورد قديمة (best-effort - ما يرمي خطأ لو الرسالة أو
 * القناة أصلاً محذوفة/مو موجودة، لأن الهدف النهائي "ما تعود موجودة"
 * محقق أصلاً بهالحالة).
 */
async function deleteReactionRoleMessage(client, embedRow) {
    if (!embedRow?.id_channel || !embedRow?.id_message) return;
    if (!client.isReady()) return;

    try {
        const channel = await client.channels.fetch(embedRow.id_channel).catch(() => null);
        if (!channel || !channel.isTextBased()) return;
        const message = await channel.messages.fetch(embedRow.id_message).catch(() => null);
        if (message) await message.delete().catch(() => {});
    } catch (err) {
        console.error('[ReactionRolePanel] Failed to delete old message (non-fatal):', err.message);
    }
}

/**
 * "تحديث" كرت موجود مسبقاً بعد تعديله بالداشبورد:
 *   - لو القناة المستهدفة **ما تغيّرت** ورسالة سابقة موجودة -> نعدّل نفس
 *     الرسالة بمكانها (edit) بدل نشر جديدة.
 *   - لو القناة **تغيّرت**، أو ما كان فيه رسالة سابقة أصلاً، أو تعذّر
 *     تعديل القديمة (انحذفت يدوياً من ديسكورد) -> نحذف القديمة (لو موجودة)
 *     وننشر رسالة جديدة بالقناة الحالية.
 * @returns {Promise<{channelId: string, messageId: string}>}
 */
async function syncReactionRoleMessage(client, guildId, embedRow, previousChannelId, previousMessageId) {
    if (!client.isReady()) throw new Error('Bot is not ready yet.');

    const channelChanged = previousChannelId && previousChannelId !== embedRow.id_channel;

    if (!channelChanged && previousMessageId) {
        try {
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) throw new Error('Bot is not in this server.');

            const channel = await guild.channels.fetch(embedRow.id_channel).catch(() => null);
            if (!channel || !channel.isTextBased()) throw new Error('Target channel not found or is not a text channel.');

            const message = await channel.messages.fetch(previousMessageId).catch(() => null);
            if (message) {
                await message.edit({
                    embeds: [buildReactionRoleEmbed(embedRow)],
                    components: buildReactionRoleComponents(embedRow.buttons),
                });
                return { channelId: channel.id, messageId: message.id };
            }
            // الرسالة القديمة انحذفت يدوياً من ديسكورد -> ننشر جديدة تحت.
        } catch (editErr) {
            console.error('[ReactionRolePanel] Failed to edit existing message, will republish instead:', editErr.message);
        }
    } else if (previousMessageId) {
        // القناة تغيّرت -> نحذف الرسالة القديمة من قناتها القديمة أولاً.
        await deleteReactionRoleMessage(client, { id_channel: previousChannelId, id_message: previousMessageId });
    }

    return publishReactionRoleEmbed(client, guildId, embedRow);
}

module.exports = {
    MAX_BUTTONS_PER_EMBED,
    buildCustomId,
    extractRoleIdFromCustomId,
    buildReactionRoleEmbed,
    buildReactionRoleComponents,
    publishReactionRoleEmbed,
    deleteReactionRoleMessage,
    syncReactionRoleMessage,
};