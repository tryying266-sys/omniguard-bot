// ============================================================================
// commandhandler.js - Dynamic Module Loader & Router (v3.2 - Aliases + Exclusions)
// ============================================================================
// This module implements the "Universal Engine": it automatically scans the
// folder it lives in for command files, without needing any new manual
// require() added elsewhere.
//
// [v3.2 CHANGES - what was fixed in this version]
//
// [FIX 1] Alias support (missing "unban" / "unmute" / "unwarn" / "clear"):
//         The loader used to register every command file under a single key
//         only: either command.name, or the filename itself (e.g. ban.js was
//         only reachable as "ban"). Related actions that live inside the
//         same file (unban inside ban.js, unmute inside mute.js, unwarn
//         inside warn.js, clear inside delete.js) had no entry in the
//         Collection at all, so typing "!unban", "!unmute", "!unwarn" or
//         "!clear" resolved to "command not found" and the bot silently
//         ignored the message.
//
//         Fix: after loading a command module, the loader now also reads an
//         optional `aliases` array exported by that file, e.g.:
//             module.exports.aliases = ['unban'];
//         and registers every alias in the same Collection, pointing to the
//         exact same module as the primary name. This does NOT change how
//         the module itself parses message.content - each command file is
//         still responsible for detecting which action was typed
//         (ban vs unban, mute vs unmute, warn vs unwarn, delete vs clear)
//         and branching internally once it's called.
//
//         ⚠️ IMPORTANT: this only takes effect if ban.js / mute.js / warn.js
//         / delete.js actually export that `aliases` array. I have not seen
//         the current content of those files (mute.js came through empty),
//         so I can't confirm they already do. If they don't yet, add the
//         `aliases` line shown above at the bottom of each file and this
//         loader will start recognizing them automatically. Send me those
//         files if you want me to add/verify this property directly instead.
//
// [FIX 2] Exclusion list expanded:
//         Non-command background/support files must never be auto-registered
//         as chat commands (the loader would otherwise expect a
//         run(message, dbUtils) signature they don't have, and just log a
//         load error for each one instead of working).
//         Added to the exclusion list: AutoRole.js, welcome.js,
//         Rolemanagement.js, getroles.js (in addition to the already-excluded
//         AutoMod.js, AntiAlt.js, GRS.js, custom.js).
//
// Note on the slash-command bug (e.g. slashCommandsHandler.js calling a
// "handleBan" export while ban.js actually exports "executeBan"): that lives
// in slashCommandsHandler.js, a different file that hasn't been shared yet.
// This file (commandhandler.js) only powers prefix ("!command") routing and
// is not affected by that bug - send slashCommandsHandler.js over to fix
// that one too.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');
const { isChannelAllowed, isMemberCommandExempt } = require('./GRS');

// Collection used to store commands in memory for fast lookup
const commands = new Collection();

/**
 * AUTO-LOADER INITIALIZATION
 * Scans the folder this file actually lives in for command files.
 */
const commandsPath = __dirname;

// Files that are NOT real chat commands - background engines, helpers, or
// dashboard-only configuration files. These must be excluded by name so the
// auto-loader doesn't try to register them as commands.
const EXCLUDED_FILES = [
    'commandhandler.js',
    'AutoMod.js',
    'AntiAlt.js',
    'GRS.js',
    'custom.js',
    'AutoRole.js',
    'welcome.js',
    'Rolemanagement.js',
    'getroles.js',
    'roleSync.js'
];

const commandFiles = fs.readdirSync(commandsPath).filter(file =>
    file.endsWith('.js') && !EXCLUDED_FILES.includes(file)
);

console.log('--------------------------------------------------');
console.log(`[CommandHandler] Initializing Auto-Loader...`);

for (const file of commandFiles) {
    try {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);

        /**
         * Smart Mapping:
         * Use the 'name' property defined inside the file, or fall back to
         * the filename (without .js) as the default trigger name.
         */
        const commandName = (command.name || file.split('.')[0]).toLowerCase();
        commands.set(commandName, command);
        console.log(`[CommandHandler] Registered Command: ${commandName} (${file})`);

        /**
         * [NEW] Alias registration:
         * If the command file exports an `aliases` array (e.g. ['unban']
         * inside ban.js), register every alias under the same Collection,
         * pointing to the exact same module. This is what makes "!unban",
         * "!unmute", "!unwarn", "!clear" resolvable even though they live
         * inside ban.js / mute.js / warn.js / delete.js.
         */
        if (Array.isArray(command.aliases)) {
            for (const alias of command.aliases) {
                const aliasName = String(alias).toLowerCase();

                if (commands.has(aliasName)) {
                    console.warn(`[CommandHandler] Alias conflict: "${aliasName}" (from ${file}) is already registered - skipped.`);
                    continue;
                }

                commands.set(aliasName, command);
                console.log(`[CommandHandler] Registered Alias: ${aliasName} -> ${commandName} (${file})`);
            }
        }

    } catch (error) {
        console.error(`[CommandHandler Error] Failed to load ${file}:`, error.message);
    }
}
console.log('--------------------------------------------------');

/**
 * MAIN EXECUTION ROUTER
 * Intercepts the message (after prefix removal) and routes it to the
 * correct command file.
 * @param {import('discord.js').Message} message - Discord Message Object.
 * @param {Object} dbUtils - Universal Database Wrapper.
 * @param {Object} guildSettings - Guild settings row fetched in index.js.
 */
async function handleMessage(message, dbUtils, guildSettings) {
    // Basic safety checks first
    if (message.author.bot || !message.guild) return false;

    // We only need the command name here to pick the right file
    // (each command file re-parses message.content by itself to get args).
    const firstWordArgs = message.content.trim().split(/\s+/);
    const commandName = firstWordArgs.shift().toLowerCase();

    // Look up the command (or alias) in the dynamic map
    const command = commands.get(commandName);
    if (!command) return false;

    // [GRS] Channel check - guildSettings comes from index.js (the same
    // fetch already used for prefix/access_dashboard - no extra DB query).
    if (!isChannelAllowed(guildSettings, message.channel.id)) {
        return false; // Silent ignore - no error message
    }

    // [v5.3 NEW] Command Spam Protection - checked here specifically (not
    // inside AutoMod.js's handleMessage, which runs on every message
    // regardless of whether it's a real command) because this is the only
    // place that already knows "this message IS a matched command" before
    // any execution happens. Uses the new cmd_* columns (setting_moderation_
    // security), fully independent from the existing chat-spam settings
    // (spam_*/cooldown_spam) used by AutoMod.js's own checkSpam().
    // AutoMod.js is required lazily here (not at the top of the file) to
    // avoid a circular require, since AutoMod.js/GRS.js don't require this
    // file back - same lazy-require pattern already used elsewhere in this
    // codebase (e.g. AutoMod.js <-> warn.js).
    try {
        const AutoMod = require('./AutoMod');
        if (await AutoMod.checkCommandSpam(message, dbUtils)) {
            return false; // عقوبة اتطبقت (أو الأكشن 'none') - ما نكمل تنفيذ الأمر
        }
    } catch (spamErr) {
        console.error('[CommandHandler] Command spam check failed (command still allowed to run):', spamErr.message);
    }

    try {
        /**
         * Permission Check:
         * If the command file defines a required permission via the
         * `permissions` property, check it.
         */
        if (command.permissions && !message.member.permissions.has(command.permissions)) {
            return await message.reply({
                content: "❌ You do not have the required permissions to use this command."
            });
        }

        // [GRS] Target exemption check - generic extraction (mention or raw
        // ID as the first argument).
        // ⚠️ Not yet verified against every command file's own args-parsing
        // order (ban.js/kick.js/mute.js/warn.js/roleadd.js content hasn't
        // been shared) - if any of them expects a different argument order
        // (e.g. roleadd.js expecting the role first, not the member), flag
        // it so this can be adjusted precisely.
        const targetMember = message.mentions.members?.first()
            || message.guild.members.cache.get(firstWordArgs[0]);

        if (targetMember && isMemberCommandExempt(guildSettings, targetMember)) {
            return await message.reply({
                content: "❌ This member's role is exempt from bot commands."
            });
        }

        /**
         * Universal Execution:
         * Every command file is defined with the signature
         * run(message, dbUtils) and re-parses message.content itself to
         * extract the command name and args. So we call it here with two
         * arguments only (not three), so the real dbUtils lands in the
         * right place instead of being overwritten by an args array.
         */
        await command.run(message, dbUtils);
        return true;

    } catch (error) {
        console.error(`[Execution Error] Command: ${commandName} |`, error);

        // Unified English error message for the user
        const errorMessage = "❌ An internal error occurred while executing this command.";
        if (message.replied || message.deferred) {
            await message.followUp({ content: errorMessage });
        } else {
            await message.reply({ content: errorMessage });
        }
    }

    return false;
}

module.exports = {
    handleMessage,
    commands // Export the Collection for later use (e.g. slash command sync)
};