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