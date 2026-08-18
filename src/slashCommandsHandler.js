// ============================================================================
// slashCommandsHandler.js - Universal Interaction Gateway (v4.0 - Precision Bridge)
// ============================================================================
// This file intercepts slash commands and bridges them into the same logic
// used by the prefix ("!command") flow (src/commands/*.js) via a "Fake Message
// Bridge", without rewriting those files.
//
// [v4.0 Updates]:
// - Preserved the highly effective "Fake Message Bridge" architecture.
// - Updated require() paths to dynamically point to 'src/commands' from the root.
// - Reconstructed `message.content` strings to perfectly match the regex and 
//   parsing logic of the provided command files (e.g., using <@ID> and <#ID>).
// - Added support for new commands: lock, unlock, serverinfo, checkpermissions, clear.
// - Enhanced `buildFakeMessage` to support channel mentions.
// ============================================================================

const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const path = require('path');

// Define the absolute path to the commands folder (src/commands)
const COMMANDS_PATH = path.join(process.cwd(), 'src', 'commands');

/**
 * Builds a fake Message-like object for a given interaction so it can be
 * passed straight into a command file's run(message, dbUtils).
 * 
 * @param {Object} interaction - The Discord Interaction object.
 * @param {string} content - Reconstructed "text command" line.
 * @param {Object|null} targetUser - The resolved discord.js User for this action.
 * @param {Object|null} targetChannel - The resolved discord.js Channel for this action.
 */
function buildFakeMessage(interaction, content, targetUser = null, targetChannel = null) {
    const { guild, channel, member, user } = interaction;

    // Resolve the real GuildMember if the target is still in the guild
    const resolvedMember = targetUser ? (guild.members.cache.get(targetUser.id) || null) : null;

    return {
        guild,
        channel,
        member,
        author: user,
        id: interaction.id,
        content,
        // Bridge reply to editReply for Slash Commands
        reply: async (replyContent) => await interaction.editReply(replyContent),
        edit: async (replyContent) => await interaction.editReply(replyContent),
        // Stub delete() to prevent crashes in commands like delete.js
        delete: async () => {},
        mentions: {
            members: { first: () => resolvedMember },
            users: { first: () => targetUser || null },
            channels: { first: () => targetChannel || null }
        }
    };
}

/**
 * MAIN INTERACTION HANDLER
 * @param {Object} interaction - The Discord Interaction object.
 * @param {Object} dbUtils - Universal Database Wrapper.
 */
async function handleSlashCommand(interaction, dbUtils) {
    const { commandName, guild, channel, options } = interaction;

    try {
        // 1. Acknowledge the interaction immediately (3-second window)
        await interaction.deferReply({ ephemeral: true });

        /**
         * SMART BINDING: Fetch guild settings using the Universal Engine.
         */
        const settings = await dbUtils.universalGet('setting_guild', guild.id);

        if (settings) {
            // 2. WHITELIST CHECK
            if (settings.whitelisted_channels?.length > 0) {
                if (!settings.whitelisted_channels.includes(channel.id)) {
                    const allowed = settings.whitelisted_channels.map(id => `<#${id}>`).join(', ');
                    return await interaction.editReply({
                        content: `❌ Restricted: This command can only be used in: ${allowed}`
                    });
                }
            }

            // 3. BLACKLIST CHECK
            if (settings.blacklisted_channels?.includes(channel.id)) {
                return await interaction.editReply({
                    content: "❌ Prohibited: Management commands are disabled in this channel."
                });
            }
        }

        /**
         * COMMAND ROUTING LOGIC
         * Every case builds a fake, text-command-shaped message and calls
         * the module's real export: run(message, dbUtils).
         */
        switch (commandName) {
            case 'ban': {
                // Fallback to 'target' if 'user' is not used in deploy-commands
                const target = options.getUser('user') || options.getUser('target');
                const duration = options.getString('duration');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: ban <@ID> [duration] <reason>
                const content = `ban <@${target.id}> ${duration || 'permanent'} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const banModule = require(path.join(COMMANDS_PATH, 'ban.js'));
                return await banModule.run(fakeMessage, dbUtils);
            }

            case 'unban': {
                const userId = options.getString('user_id') || options.getString('target_id');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: unban <ID> <reason>
                const content = `unban ${userId} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const banModule = require(path.join(COMMANDS_PATH, 'ban.js'));
                return await banModule.run(fakeMessage, dbUtils);
            }

            case 'kick': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: kick <@ID> <reason>
                const content = `kick <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const kickModule = require(path.join(COMMANDS_PATH, 'kick.js'));
                return await kickModule.run(fakeMessage, dbUtils);
            }

            case 'warn': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: warn <@ID> <reason>
                const content = `warn <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const warnModule = require(path.join(COMMANDS_PATH, 'warn.js'));
                return await warnModule.run(fakeMessage, dbUtils);
            }

            case 'unwarn': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'Warning removed by staff';
                // Format: unwarn <@ID> <reason>
                const content = `unwarn <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const warnModule = require(path.join(COMMANDS_PATH, 'warn.js'));
                return await warnModule.run(fakeMessage, dbUtils);
            }

            case 'mute': {
                const target = options.getUser('user') || options.getUser('target');
                const duration = options.getString('duration');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: mute <@ID> <duration> <reason>
                // If duration is missing, pass '28d' so the prefix wrapper doesn't confuse reason with duration
                const content = `mute <@${target.id}> ${duration || '28d'} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const muteModule = require(path.join(COMMANDS_PATH, 'mute.js'));
                return await muteModule.run(fakeMessage, dbUtils);
            }

            case 'unmute': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: unmute <@ID> <reason>
                const content = `unmute <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const muteModule = require(path.join(COMMANDS_PATH, 'mute.js'));
                return await muteModule.run(fakeMessage, dbUtils);
            }

            case 'lock':
            case 'unlock': {
                const targetChannel = options.getChannel('channel');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: lock/unlock [<#ID>] <reason>
                let content = `${commandName}`;
                if (targetChannel) content += ` <#${targetChannel.id}>`;
                content += ` ${reason}`;
                
                const fakeMessage = buildFakeMessage(interaction, content, null, targetChannel);
                const lockModule = require(path.join(COMMANDS_PATH, 'lock.js'));
                return await lockModule.run(fakeMessage, dbUtils);
            }

            case 'delete':
            case 'clear': {
                const amount = options.getInteger('amount');
                // Format: delete/clear <amount>
                const content = `${commandName} ${amount}`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const deleteModule = require(path.join(COMMANDS_PATH, 'delete.js'));
                return await deleteModule.run(fakeMessage, dbUtils);
            }

            case 'serverinfo': {
                // Format: serverinfo
                const content = `serverinfo`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const serverInfoModule = require(path.join(COMMANDS_PATH, 'serverinfo.js'));
                return await serverInfoModule.run(fakeMessage, dbUtils);
            }

            case 'checkpermissions': {
                const target = options.getUser('user') || options.getUser('target');
                const targetChannel = options.getChannel('channel');
                // Format: checkpermissions [@user] [#channel]
                let content = `checkpermissions`;
                if (target) content += ` <@${target.id}>`;
                if (targetChannel) content += ` <#${targetChannel.id}>`;
                
                const fakeMessage = buildFakeMessage(interaction, content, target, targetChannel);
                const cpModule = require(path.join(COMMANDS_PATH, 'checkpermissions.js'));
                return await cpModule.run(fakeMessage, dbUtils);
            }

            case 'roleadd': {
                const role = options.getRole('role');
                const target = options.getUser('user') || options.getUser('target');
                // Format: roleadd <RoleName> <ID>
                const content = `roleadd ${role.name} ${target.id}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const roleModule = require(path.join(COMMANDS_PATH, 'roleadd.js'));
                return await roleModule.run(fakeMessage, dbUtils);
            }

            case 'demote': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                // Format: demote <ID> <reason>
                const content = `demote ${target.id} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const roleModule = require(path.join(COMMANDS_PATH, 'roleadd.js'));
                return await roleModule.run(fakeMessage, dbUtils);
            }

            case 'settings':
                return await handleSettingsSlash(interaction, dbUtils);

            case 'dashboard':
                return await handleDashboardSlash(interaction);

            default:
                return await interaction.editReply("❌ Unknown command interface.");
        }

    } catch (error) {
        console.error(`[SlashHandler Error] Command: ${commandName} |`, error);
        const errContent = "❌ An internal error occurred while processing this interaction.";
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errContent);
        } else {
            await interaction.reply({ content: errContent, ephemeral: true });
        }
    }
}

/**
 * Specialized: Display current settings using SQL-matching keys.
 */
async function handleSettingsSlash(interaction, dbUtils) {
    try {
        const settings = await dbUtils.universalGet('setting_guild', interaction.guildId);
        if (!settings) return interaction.editReply("❌ Settings not found. Initialize the bot first.");

        const embed = new EmbedBuilder()
            .setTitle(`⚙️ Configurations: ${interaction.guild.name}`)
            .setColor(0x00AAFF)
            .addFields(
                { name: 'Prefix', value: `\`${settings.prefix_bot || '!'}\``, inline: true },
                { name: 'Nickname', value: `\`${settings.nickname_server || 'OmniGuard'}\``, inline: true },
                { name: 'Access', value: `\`${settings.access_dashboard || 'staff'}\``, inline: true }
            )
            .setFooter({ text: 'OmniGuard Universal Engine' });

        return await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        return await interaction.editReply("❌ Failed to fetch database records.");
    }
}

/**
 * Specialized: Return the dynamic Dashboard URL.
 */
async function handleDashboardSlash(interaction) {
    const url = `${process.env.DASHBOARD_URL || 'http://localhost:4000'}?guildId=${interaction.guildId}`;
    return await interaction.editReply({
        content: `🔗 **Management Dashboard:**\n${url}`
    });
}

module.exports = { handleSlashCommand };