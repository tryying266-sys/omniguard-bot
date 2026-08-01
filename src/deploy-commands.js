// ============================================================================
// deploy-commands.js - Slash Command Registration Engine (v3.0)
// ============================================================================
// This script registers all Slash Commands with the Discord API.
// It supports both Global and Guild-specific deployment.
// Note: 'setDefaultMemberPermissions(0)' is used for moderation commands 
// to ensure only authorized staff can see/use them by default.
// ============================================================================

const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // Leave empty in .env for Global deployment

// Validate essential environment variables before proceeding
if (!TOKEN || !CLIENT_ID) {
    console.error('**************************************************');
    console.error('[CRITICAL ERROR] DISCORD_TOKEN or CLIENT_ID missing!');
    console.error('Check your .env file to ensure credentials are set.');
    console.error('**************************************************');
    process.exit(1);
}

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
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
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
        
        process.exit(0);
    } catch (error) {
        console.error('**************************************************');
        console.error('[OmniGuard Deploy Error] Failed to register commands:');
        console.error(error);
        console.error('**************************************************');
        process.exit(1);
    }
})();