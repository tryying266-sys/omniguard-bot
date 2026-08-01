// ============================================================================
// client.js - Centralized Discord Client Initialization (v3.0 - Universal Ready)
// ============================================================================
// This file initializes the Discord.js Client instance with all necessary
// intents and partials required for OmniGuard's core systems:
// (Moderation, Anti-Alt, Auto-Roles, and Smart Dashboard Sync).
// ============================================================================

const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');

/**
 * CLIENT CONFIGURATION:
 * We enable specific intents to allow the bot to read messages (for prefixes),
 * manage members (for auto-roles/anti-alt), and execute moderation actions.
 */
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,           // Required for basic guild functionality
        GatewayIntentBits.GuildMessages,    // Required to receive message events
        GatewayIntentBits.MessageContent,   // CRITICAL for prefix-based commands
        GatewayIntentBits.GuildMembers,     // CRITICAL for anti-alt, welcome, and auto-roles
        GatewayIntentBits.GuildModeration,  // Required for ban, kick, and timeout actions
        GatewayIntentBits.GuildPresences    // Optional: useful for advanced user tracking
    ],
    partials: [
        Partials.Message,      // Allows the bot to handle reactions/actions on old messages
        Partials.Channel,      // Required for DM handling and uncached channels
        Partials.Reaction,     // Required for reaction-based systems
        Partials.GuildMember,  // Essential for join/leave events on uncached members
        Partials.User          // Ensures user data is accessible even if not in cache
    ]
});

/**
 * SMART COMMAND COLLECTION:
 * This collection stores all loaded command modules (Slash and Prefix).
 * It is populated by the Dynamic Module Loader (commandhandler.js).
 */
client.commands = new Collection();

/**
 * UTILITY COLLECTIONS:
 * (Optional) Can be used for cooldowns or temporary session tracking.
 */
client.cooldowns = new Collection();

// Export the client instance as a singleton
module.exports = client;