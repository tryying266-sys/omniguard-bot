// ============================================================================
// ticketPanel.js - Ticket Panel Interaction Flow (v1.0)
// ============================================================================
// This is the piece ticketsystem.js's own header comment explicitly says
// does NOT exist yet: "the panel button / select-menu 'open ticket'
// interaction flow ... belong in their own dedicated file(s)".
//
// Design (per schema TICKET-1, confirmed with the user):
//   1. postOrUpdatePanel(client, guildId) - posts/edits the single fixed
//      panel message (Embed + one button) in setting_ticket_system's
//      panel_channel_id. Called from apiRouter.js right after any
//      /ticket-settings save.
//   2. handleTicketPanelInteraction(interaction) - routed from
//      index.js's interactionCreate. Two steps:
//        a) Button "ticket_panel_open" click -> ephemeral (private) select
//           menu listing every ticket_type_config row for this guild.
//        b) Select menu "ticket_panel_select" choice -> creates the actual
//           ticket channel (permissions, opening embed, ticket_record row,
//           atomic counter via increment_ticket_counter RPC).
//
// Checks applied before a channel is created, in order:
//   - ticket_blacklist (server-wide ban from opening ANY ticket)
//   - restricted_roles on the chosen ticket_type_config row (per-type ban)
// (Both already exist in the schema/queries layer - this file is the first
// thing that actually reads them at ticket-open time.)
// ============================================================================

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    PermissionsBitField,
    ChannelType
} = require('discord.js');
const supabase = require('../supabase/db');
const queries = require('../supabase/databaseQueries');

const BUTTON_STYLE_MAP = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger
};

// [NEW] ديسكورد يرفض الطلب كامل (Invalid Form Body) لو أي إيموجي بأي مكون
// مو صالح - مو يتجاهله بس. هذي الدالة تتحقق/تنضّف القيمة المدخلة من
// المشرف قبل ما نبنيها بمكوّن حقيقي، وترجع null بهدوء لو القيمة خربانة
// بدل ما توقف كل التفاعل (مثلاً لو كتب "📩 Open Ticket" بالغلط بخانة
// الإيموجي، أو رمز مو مدعوم).
function parseEmojiInput(value) {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    // إيموجي مخصص بالسيرفر: <:name:id> أو المتحرك <a:name:id>
    const customMatch = trimmed.match(/^<(a)?:(\w+):(\d+)>$/);
    if (customMatch) {
        return { name: customMatch[2], id: customMatch[3], animated: !!customMatch[1] };
    }

    // إيموجي يونيكود عادي - نلقط أول رمز إيموجي فعلي بالنص ونتجاهل أي
    // نص زيادة حواليه (بدل ما نرفض القيمة كاملة).
    const emojiMatch = trimmed.match(/\p{Extended_Pictographic}/u);
    return emojiMatch ? emojiMatch[0] : null;
}

// ----------------------------------------------------------------------
// 1. Posting / updating the panel message itself
// ----------------------------------------------------------------------

/**
 * Posts the panel message if it doesn't exist yet (per panel_message_id),
 * or edits the existing one in place otherwise - so re-saving settings from
 * the dashboard never spams a new message into the channel.
 */
async function postOrUpdatePanel(client, guildId) {
    const settings = await queries.getTicketSettings(guildId);
    if (!settings || !settings.panel_channel_id) {
        return { success: false, error: 'No panel channel configured yet.' };
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return { success: false, error: 'Bot is not in this server.' };

    const channel = await guild.channels.fetch(settings.panel_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        return { success: false, error: 'The configured panel channel is missing or is not a text channel.' };
    }

    const embed = new EmbedBuilder()
        .setColor(settings.panel_embed_color || '#5865F2')
        .setTitle(settings.panel_embed_title || 'Support Tickets')
        .setDescription(settings.panel_embed_description || 'Click the button below to open a ticket.');

    const button = new ButtonBuilder()
        .setCustomId('ticket_panel_open')
        .setLabel(settings.panel_button_label || 'Open Ticket')
        .setStyle(BUTTON_STYLE_MAP[settings.panel_button_style] || ButtonStyle.Primary);
    if (settings.panel_button_emoji) button.setEmoji(settings.panel_button_emoji);

    const row = new ActionRowBuilder().addComponents(button);
    const payload = {
        content: settings.panel_content_above || '',
        embeds: [embed],
        components: [row]
    };

    let message = settings.panel_message_id
        ? await channel.messages.fetch(settings.panel_message_id).catch(() => null)
        : null;

    try {
        if (message) {
            await message.edit(payload);
        } else {
            message = await channel.send(payload);
            // نخزّن id الرسالة الجديدة عشان أي حفظ لاحق يعدّل نفس الرسالة
            // بدل ما ينشئ وحدة جديدة كل مرة.
            await queries.upsertTicketSettings(guildId, { panel_message_id: message.id });
        }
    } catch (err) {
        console.error('[Ticket Panel] Failed to post/update panel message:', err.message);
        return { success: false, error: 'Failed to send the panel message (check bot permissions in that channel).' };
    }

    return { success: true, messageId: message.id, channelId: channel.id };
}

// ----------------------------------------------------------------------
// 2. Interaction routing
// ----------------------------------------------------------------------

async function handleTicketPanelInteraction(interaction) {
    if (interaction.isButton() && interaction.customId === 'ticket_panel_open') {
        return handleOpenButton(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_panel_select') {
        return handleTypeSelected(interaction);
    }
}

/**
 * Step A: button click -> validate blacklist -> show the ephemeral select
 * menu of available ticket types (types the member isn't restricted from).
 */
async function handleOpenButton(interaction) {
    const guildId = interaction.guildId;

    const blacklist = await queries.getTicketBlacklist(guildId);
    const banEntry = blacklist.find(b => b.id_user === interaction.user.id);
    const isBanActive = banEntry && (!banEntry.expires_at || new Date(banEntry.expires_at) > new Date());
    if (isBanActive) {
        return interaction.reply({
            content: `❌ You are banned from opening tickets. Reason: ${banEntry.reason || 'No reason provided'}`,
            ephemeral: true
        });
    }

    const categories = await queries.getTicketCategories(guildId);
    const member = interaction.member;
    const available = categories.filter(cat => {
        const restricted = Array.isArray(cat.restricted_roles) ? cat.restricted_roles : [];
        return !restricted.some(roleId => member.roles.cache.has(roleId));
    });

    if (available.length === 0) {
        return interaction.reply({ content: '❌ There are no ticket categories available to you right now.', ephemeral: true });
    }

    // Discord select menus cap at 25 options - if a server somehow has more
    // than 25 categories, only the first 25 show (documented limitation).
    const menu = new StringSelectMenuBuilder()
        .setCustomId('ticket_panel_select')
        .setPlaceholder('Select a ticket type...')
        .addOptions(available.slice(0, 25).map(cat => {
            const option = { label: cat.name, value: cat.id };
            // [FIX] كانت ترسل القيمة الخام مباشرة - لو كانت غير صالحة
            // (مسافة/نص زيادة/رمز مو مدعوم) ديسكورد يرفض الطلب كامل
            // (Invalid Form Body) ويطلع "internal error" للعضو. الحين
            // نتحقق/ننضّف القيمة أول، ونتجاهلها بهدوء لو خربانة.
            const parsedEmoji = parseEmojiInput(cat.button_emoji);
            if (parsedEmoji) option.emoji = parsedEmoji;
            return option;
        }));

    const row = new ActionRowBuilder().addComponents(menu);
    return interaction.reply({ content: 'Please select the type of ticket you want to open:', components: [row], ephemeral: true });
}

/**
 * Step B: select menu choice -> re-validate (restricted_roles specific to
 * that type) -> create the channel -> send the opening embed -> log the row.
 */
async function handleTypeSelected(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const typeId = interaction.values[0];

    const categories = await queries.getTicketCategories(guild.id);
    const typeConfig = categories.find(c => c.id === typeId);
    if (!typeConfig) return interaction.editReply('❌ This ticket type no longer exists.');

    const restricted = Array.isArray(typeConfig.restricted_roles) ? typeConfig.restricted_roles : [];
    if (restricted.some(roleId => interaction.member.roles.cache.has(roleId))) {
        return interaction.editReply('❌ You are not allowed to open this ticket type.');
    }

    // [TICKET-13] الحد الأقصى للتذاكر المفتوحة بنفس الوقت - على مستوى
    // السيرفر كامل (كل الأنواع مجتمعة)، مو لكل نوع لحاله.
    const { data: settings } = await supabase
        .from('setting_ticket_system')
        .select('max_active_tickets, ticket_creation_cooldown_minutes')
        .eq('id_guild', guild.id)
        .maybeSingle();

    if (settings?.max_active_tickets) {
        const { count: openCount } = await supabase
            .from('ticket_record')
            .select('id', { count: 'exact', head: true })
            .eq('id_guild', guild.id)
            .eq('id_opener', interaction.user.id)
            .eq('status', 'open');

        if ((openCount || 0) >= settings.max_active_tickets) {
            return interaction.editReply(`❌ You already have the maximum number of open tickets allowed (${settings.max_active_tickets}). Please close an existing ticket before opening a new one.`);
        }
    }

    // [TICKET-14] الكولداون: قيمة عامة واحدة، بس تُطبَّق مستقلة لكل نوع
    // تكت (نجيب آخر تكت من نفس النوع أغلقه نفس العضو تحديداً).
    if (settings?.ticket_creation_cooldown_minutes) {
        const { data: lastClosed } = await supabase
            .from('ticket_record')
            .select('closed_at')
            .eq('id_guild', guild.id)
            .eq('id_opener', interaction.user.id)
            .eq('id_type', typeId)
            .eq('status', 'closed')
            .order('closed_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (lastClosed?.closed_at) {
            const elapsedMinutes = (Date.now() - new Date(lastClosed.closed_at).getTime()) / 60000;
            const remainingMinutes = settings.ticket_creation_cooldown_minutes - elapsedMinutes;
            if (remainingMinutes > 0) {
                const remainingText = remainingMinutes >= 60
                    ? `${Math.ceil(remainingMinutes / 60)}h`
                    : `${Math.ceil(remainingMinutes)}m`;
                return interaction.editReply(`❌ You must wait ${remainingText} before opening another ${typeConfig.name} ticket.`);
            }
        }
    }

    // [NEW] استثناء أي عضو طاقم محظور (ticket_blacklist) من صلاحية
    // الرؤية حتى لو رتبته موجودة بـ staff_roles - Overwrite مباشر على
    // المستخدم يتغلّب على Overwrite الرتبة العامة (سلوك ديسكورد الطبيعي).
    const { data: blacklistedStaff } = await supabase
        .from('ticket_blacklist')
        .select('id_user, expires_at')
        .eq('id_guild', guild.id);

    const activeBlacklistedIds = new Set(
        (blacklistedStaff || [])
            .filter(b => !b.expires_at || new Date(b.expires_at) > new Date())
            .map(b => b.id_user)
    );

    // [TICKET-9] عداد ذري عبر RPC - نفس فلسفة add_xp_smart بالسكيما الأصلية.
    let counterNumber = null;
    if (typeConfig.counter_enabled) {
        const { data, error } = await supabase.rpc('increment_ticket_counter', { p_type_id: typeId });
        if (error) {
            console.error('[Ticket Panel] increment_ticket_counter failed:', error.message);
        } else {
            counterNumber = data;
        }
    }

    const safeBase = (typeConfig.channel_base_name || 'ticket').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const channelName = counterNumber !== null
        ? `${safeBase}-${counterNumber}`
        : `${safeBase}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);

    const staffRoles = Array.isArray(typeConfig.staff_roles) ? typeConfig.staff_roles : [];
    const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
            id: interaction.user.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
        },
        {
            id: guild.members.me.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels]
        },
        ...staffRoles.map(roleId => ({
            id: roleId,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
        })),
        // [NEW] لو أي عضو طاقم بهالسيرفر محظور (ticket_blacklist)، نضيف
        // Overwrite حظر صريح له فوق صلاحية رتبته - يمنعه من رؤية القناة
        // الجديدة حتى لو رتبته ضمن staffRoles فوق.
        ...Array.from(activeBlacklistedIds).map(userId => ({
            id: userId,
            deny: [PermissionsBitField.Flags.ViewChannel]
        }))
    ];

    let channel;
    try {
        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: typeConfig.category_id || undefined,
            permissionOverwrites: overwrites
        });
    } catch (err) {
        console.error('[Ticket Panel] Channel creation failed:', err.message);
        return interaction.editReply('❌ Failed to create the ticket channel. Please contact a staff member.');
    }

    const { error: insertErr } = await supabase.from('ticket_record').insert({
        id_guild: guild.id,
        id_channel: channel.id,
        id_type: typeId,
        id_opener: interaction.user.id,
        ticket_number: counterNumber
    });
    if (insertErr) console.error('[Ticket Panel] Failed to insert ticket_record:', insertErr.message);

    const embed = new EmbedBuilder()
        .setColor(typeConfig.opening_embed_color || '#5865F2') // [FIX] كان لون ثابت، الحين مرتبط بالتصنيف المختار
        .setTitle(typeConfig.opening_embed_title || `Welcome to ${typeConfig.name}`)
        .setDescription(typeConfig.opening_embed_description || 'A staff member will be with you shortly.');

    const mentionRoles = Array.isArray(typeConfig.mention_roles) ? typeConfig.mention_roles : [];
    const mentionText = mentionRoles.map(id => `<@&${id}>`).join(' ');

    await channel.send({
        content: `<@${interaction.user.id}>${mentionText ? ' ' + mentionText : ''}`,
        embeds: [embed]
    });

    if (typeConfig.opening_copyable_text) {
        await channel.send({ content: '```' + typeConfig.opening_copyable_text + '```' });
    }

    return interaction.editReply(`✅ Your ticket has been created: ${channel}`);
}

module.exports = {
    postOrUpdatePanel,
    handleTicketPanelInteraction
};