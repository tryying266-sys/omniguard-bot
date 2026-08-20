// ============================================================================
// deploy-commands.js - Slash Command Registration Engine (v3.0)
// ============================================================================
// This script registers all Slash Commands with the Discord API.
// It supports both Global and Guild-specific deployment.
// Note: 'setDefaultMemberPermissions(0)' is used for moderation commands 
// to ensure only authorized staff can see/use them by default.
// ============================================================================

const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ----------------------------------------------------------------------------
// COMMAND DEFINITIONS
// ----------------------------------------------------------------------------
const commands = [
    
    // --- Moderation: BAN ---
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member from the server')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to ban')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Ban duration (e.g., 1d, 1w, permanent)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the ban')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Moderation: KICK ---
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member from the server')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to kick')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the kick')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Moderation: WARN ---
    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Issue a formal warning to a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to warn')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the warning')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // --- Moderation: MUTE ---
    new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Timeout/Mute a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to mute')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Mute duration (e.g., 10m, 1h, 1d)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the mute')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Moderation: UNMUTE ---
    new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Remove timeout from a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to unmute')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for unmuting')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Moderation: UNBAN ---
    new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Revoke a user ban using their Discord ID')
        .addStringOption(option =>
            option.setName('user_id') // Using underscore for ID consistency
                .setDescription('The Discord ID of the user to unban')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for unbanning')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Utility: ROLEADD ---
    new SlashCommandBuilder()
        .setName('roleadd')
        .setDescription('Assign a specific role to a member')
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('The role to assign')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user receiving the role')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // --- Moderation: UNWARN ---
    // [NEW] Case already implemented in slashCommandsHandler.js but never
    // registered here - this command never appeared in Discord's slash menu.
    new SlashCommandBuilder()
        .setName('unwarn')
        .setDescription('Remove the latest active warning from a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to remove a warning from')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for removing the warning')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Moderation: DEMOTE ---
    // [NEW] Handled by roleadd.js's handleDemote() via slashCommandsHandler.js,
    // but was missing here - same reason as unwarn above.
    new SlashCommandBuilder()
        .setName('demote')
        .setDescription('Demote a member (removes rank/role per dashboard config)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to demote')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the demotion')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Utility: DELETE ---
    // [NEW] Option name 'amount' must match options.getInteger('amount')
    // in slashCommandsHandler.js's 'delete' case exactly.
    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('Bulk delete messages in this channel (1-100)')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Number of messages to delete (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100))
        .setDefaultMemberPermissions(0),

    // ------------------------------------------------------------------
    // [NEW] Previously dead code - lock/unlock/serverinfo/checkpermissions
    // were already fully implemented and verified inside
    // slashCommandsHandler.js's switch statement, but had NO matching
    // registration here, so Discord never showed them as slash commands
    // and those cases could never fire. Registered now per explicit
    // request. Option shapes below match exactly what the handler already
    // builds for each (see slashCommandsHandler.js's own verified comments
    // on each case - no changes were needed there for these four).
    // ------------------------------------------------------------------

    // --- Moderation: LOCK ---
    new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Lock a channel (prevent @everyone from sending messages)')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Target channel (defaults to the current channel)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for locking this channel')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Moderation: UNLOCK ---
    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock a channel (restore @everyone send permissions)')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Target channel (defaults to the current channel)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for unlocking this channel')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Utility: SERVERINFO ---
    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Show information about this server'),

    // --- Utility: CHECKPERMISSIONS ---
    new SlashCommandBuilder()
        .setName('checkpermissions')
        .setDescription("Check a member's or channel's permissions")
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The member to check (optional)')
                .setRequired(false))
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel to check against (optional)')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Utility: USERINFO ---
    // [NEW] userinfo.js exists as a fully implemented prefix command but
    // had ZERO slash support before (no case in slashCommandsHandler.js,
    // no registration here). userinfo.js's run() reads an optional target
    // arg (mention or raw ID via resolveTargetMember()), defaulting to the
    // command sender when omitted - matched below with an optional user
    // option. Its permission check (ModerateMembers) is enforced inside
    // userinfo.js's own run(), so no extra permission gate is duplicated
    // here beyond the standard setDefaultMemberPermissions(0) baseline.
    new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription('Display information about a server member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Whose info to show (defaults to yourself)')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // ------------------------------------------------------------------
    // [NEW] Ticket System Bundle (ticketsystem.js, module name: 'claim') -
    // claim/unclaim/transfer/add/remove/bump/close/ticket-blacklist/
    // ticket-unblacklist/rename. None of these 10 had any slash equivalent
    // before - ticketsystem.js itself documents this as prefix-only for
    // now. Registered per explicit request.
    //
    // [DESIGN NOTE - permissions] Authorization for claim/unclaim/transfer/
    // add/remove/bump/close/rename is fully dynamic (per-ticket-type
    // staff_roles read from the DB inside run(), via isTicketStaff()) -
    // NOT a static Discord permission, exactly as ticketsystem.js's own
    // header comment explains ("a single static permission value can't
    // correctly cover all of them... authorization is done manually inside
    // run()"). setDefaultMemberPermissions(0) below only controls default
    // visibility (hidden until a server admin explicitly grants access via
    // Integrations), matching this project's existing convention for every
    // other staff-tier command (ban/kick/mute/etc.) - the real enforcement
    // stays exactly where ticketsystem.js already puts it, unchanged.
    //
    // [DESIGN NOTE - ping-user] 'bump' and 'ping-user' are the exact same
    // switch-case in ticketsystem.js's run() (identical behavior, no
    // difference at all). Only 'bump' is registered as a slash command to
    // avoid a pointless duplicate; 'ping-user' remains a prefix-only alias.
    // ------------------------------------------------------------------

    // --- Ticket: CLAIM ---
    new SlashCommandBuilder()
        .setName('claim')
        .setDescription('Claim this ticket as the assigned staff member')
        .setDefaultMemberPermissions(0),

    // --- Ticket: UNCLAIM ---
    new SlashCommandBuilder()
        .setName('unclaim')
        .setDescription('Release your claim on this ticket')
        .setDefaultMemberPermissions(0),

    // --- Ticket: TRANSFER ---
    new SlashCommandBuilder()
        .setName('transfer')
        .setDescription('Transfer this ticket to another staff member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The staff member to transfer this ticket to')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // --- Ticket: ADD ---
    // [NOTE] Mentionable, not User - the prefix version accepts EITHER a
    // user or a role (resolveMemberOrRole() checks the role cache first),
    // matched here with addMentionableOption instead of addUserOption.
    new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add a user or role to this ticket')
        .addMentionableOption(option =>
            option.setName('target')
                .setDescription('The user or role to add to this ticket')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // --- Ticket: REMOVE ---
    new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a user or role from this ticket')
        .addMentionableOption(option =>
            option.setName('target')
                .setDescription('The user or role to remove from this ticket')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // --- Ticket: BUMP ---
    new SlashCommandBuilder()
        .setName('bump')
        .setDescription('Ping the ticket opener to check if they are still there')
        .setDefaultMemberPermissions(0),

    // --- Ticket: CLOSE ---
    new SlashCommandBuilder()
        .setName('close')
        .setDescription('Technically close this ticket (locks it, does not delete it)')
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for closing this ticket')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Ticket: TICKET-BLACKLIST ---
    new SlashCommandBuilder()
        .setName('ticket-blacklist')
        .setDescription('Block a user from opening new tickets')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to blacklist')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Blacklist duration (e.g., 1d, 1w, permanent)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the blacklist')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Ticket: TICKET-UNBLACKLIST ---
    new SlashCommandBuilder()
        .setName('ticket-unblacklist')
        .setDescription('Allow a previously blacklisted user to open tickets again')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to remove from the ticket blacklist')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // --- Ticket: RENAME ---
    new SlashCommandBuilder()
        .setName('rename')
        .setDescription("Rename this ticket's channel")
        .addStringOption(option =>
            option.setName('name')
                .setDescription('The new channel name')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // ------------------------------------------------------------------
    // [NEW] Utility Bundle (Anothercommands.js) - slowmode/unslow/nick/
    // removenick/poll/endpoll/avatar/invites. These prefix commands had
    // NO slash equivalent before - added now per explicit request.
    //
    // [ASSUMPTION - poll option slots] pollPanel.js's exact MAX_POLL_OPTIONS
    // value was not available when this was written. 5 option slots below
    // is a reasonable middle ground for a slash UI (Discord's option list
    // gets unwieldy well before 10), NOT a hard technical limit copied from
    // pollPanel.js. If MAX_POLL_OPTIONS there is different, this can be
    // adjusted freely - it only affects how many optionN fields exist here.
    // ------------------------------------------------------------------

    // --- Utility: SLOWMODE ---
    new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Set slowmode (rate limit) for a channel')
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Delay (e.g., 30s, 10m, 2h, or a plain number of seconds). 0 disables it.')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Target channel (defaults to the current channel)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for this change')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Utility: UNSLOW ---
    new SlashCommandBuilder()
        .setName('unslow')
        .setDescription('Disable slowmode for a channel')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Target channel (defaults to the current channel)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for this change')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Utility: NICK ---
    new SlashCommandBuilder()
        .setName('nick')
        .setDescription("Change a member's nickname")
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The member to rename')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('nickname')
                .setDescription('The new nickname (leave empty to reset it)')
                .setRequired(false))
        .setDefaultMemberPermissions(0),

    // --- Utility: REMOVENICK ---
    new SlashCommandBuilder()
        .setName('removenick')
        .setDescription("Reset a member's nickname back to their username")
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The member to reset')
                .setRequired(true))
        .setDefaultMemberPermissions(0),

    // --- Utility: POLL ---
    // [DESIGN NOTE] The prefix version accepts a free-form, quote-delimited,
    // unlimited-ish option list ("Q" "Opt1" "Opt2" ...) which has no direct
    // 1:1 slash equivalent (slash options are a fixed, static set - they
    // can't repeat dynamically). This exposes a fixed number of optional
    // option slots instead - see slashCommandsHandler.js's 'poll' case for
    // exactly how these get bridged back into that same quote-based parser
    // (100% reused, not reimplemented).
    new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a poll with button voting (leave all options empty for a quick Yes/No poll)')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('The poll question (max 256 characters)')
                .setRequired(true))
        .addStringOption(option => option.setName('option1').setDescription('Option 1 (e.g. "🍕 Pepperoni") - leave all options empty for Yes/No').setRequired(false))
        .addStringOption(option => option.setName('option2').setDescription('Option 2').setRequired(false))
        .addStringOption(option => option.setName('option3').setDescription('Option 3').setRequired(false))
        .addStringOption(option => option.setName('option4').setDescription('Option 4').setRequired(false))
        .addStringOption(option => option.setName('option5').setDescription('Option 5').setRequired(false))
        .addStringOption(option =>
            option.setName('time')
                .setDescription('Auto-close after this long (e.g. 30s, 10m, 2h, 1d)')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('anonymous')
                .setDescription('Hide voter identities in the results')
                .setRequired(false)),

    // --- Utility: ENDPOLL ---
    // [NOTE] The prefix version can infer the target poll from a message
    // reply (`message.reference`). Slash interactions have no equivalent of
    // "replying to a message", so the message ID is a required option here.
    new SlashCommandBuilder()
        .setName('endpoll')
        .setDescription('Close a poll early and post the final results')
        .addStringOption(option =>
            option.setName('message_id')
                .setDescription('The ID of the poll message to close')
                .setRequired(true)),

    // --- Utility: AVATAR ---
    new SlashCommandBuilder()
        .setName('avatar')
        .setDescription("Show a member's avatar")
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Whose avatar to show (defaults to yourself)')
                .setRequired(false)),

    // --- Utility: INVITES ---
    new SlashCommandBuilder()
        .setName('invites')
        .setDescription("Show a member's active invite links and total uses")
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Whose invite stats to show (defaults to yourself)')
                .setRequired(false)),

    // --- Public: HELP ---
    // [NEW] help.js - أمر معلوماتي مفتوح للجميع (Everyone) عمداً، بدون
    // setDefaultMemberPermissions(0) - نفس فلسفة serverinfo/poll/avatar
    // بالأسفل، راجع تعليق help.js نفسه لتفاصيل أكثر.
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Displays every available command, its usage, and required permission'),

    // --- System: SETTINGS ---
    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View current server configurations from the database')
        .setDefaultMemberPermissions(0),

    // --- System: DASHBOARD ---
    new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('Get the direct link to the server management dashboard')

].map(command => command.toJSON());

// ----------------------------------------------------------------------------
// DEPLOYMENT EXECUTION
// ----------------------------------------------------------------------------
module.exports = async function deployCommands() {
    const TOKEN = process.env.DISCORD_TOKEN;
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
    const GUILD_ID = process.env.DISCORD_GUILD_ID; // Leave empty in Render for Global deployment

    if (!TOKEN || !CLIENT_ID) {
        console.error('**************************************************');
        console.error('[CRITICAL ERROR] DISCORD_TOKEN or CLIENT_ID missing!');
        console.error('Check your Render Environment Variables.');
        console.error('**************************************************');
        return; // نستخدم return بدلاً من process.exit لكي لا يتوقف الخادم
    }

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.log('--------------------------------------------------');
        console.log(`[OmniGuard Deploy] Registering ${commands.length} commands...`);

        // Determine if deploying to a single guild (fast) or globally (slow)
        const targetRoute = GUILD_ID 
            ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) 
            : Routes.applicationCommands(CLIENT_ID);

        const data = await rest.put(targetRoute, { body: commands });

        console.log(`[OmniGuard Deploy] SUCCESS: Registered ${data.length} commands.`);
        if (!GUILD_ID) {
            console.log('[OmniGuard Deploy] NOTE: Global changes may take up to 1 hour to propagate.');
        }
        console.log('--------------------------------------------------');
    } catch (error) {
        console.error('**************************************************');
        console.error('[OmniGuard Deploy Error] Failed to register commands:');
        console.error(error);
        console.error('**************************************************');
    }
};