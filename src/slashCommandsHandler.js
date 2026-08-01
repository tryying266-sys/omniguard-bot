// ============================================================================
// slashCommandsHandler.js - Universal Interaction Gateway (v3.2 - FIXED Signature)
// ============================================================================
// This file intercepts slash commands and bridges them into the same logic
// used by the prefix ("!command") flow (commands/*.js) via a "Fake Message
// Bridge", without rewriting those files.
//
// [FIX v3.1 - kept] require() paths corrected from 'commands/AutoMod/xxx' to
//       'commands/xxx' (there is no AutoMod subfolder - confirmed repeatedly
//       across this project).
//
// [FIX v3.2 - new, this pass] Wrong function names (chosen approach: fix the
//       handler, not the command files):
//       Every case in the old switch statement called a made-up function
//       name that doesn't exist in the actual command files - e.g.
//       banModule.handleBan(...), kickModule.handleKick(...),
//       warnModule.handleWarn(...), muteModule.handleMute(...) /
//       handleUnmute(...), banModule.handleUnban(...),
//       roleModule.handleRoleAdd(...).
//
//       commandhandler.js (the prefix router, confirmed in an earlier pass)
//       proves what these files actually export: every command file is
//       defined as `async function run(message, dbUtils = null)` and
//       re-parses message.content itself to figure out the action and args
//       - there is no handleBan/handleKick/handleWarn/handleMute/
//       handleUnmute/handleUnban/handleRoleAdd export anywhere. Calling one
//       of those threw "TypeError: banModule.handleBan is not a function"
//       (or the kick/warn/mute/unban/roleadd equivalent) for every single
//       slash command, while "!ban" kept working fine through
//       commandhandler.js because IT was already calling the right name
//       (run).
//
//       Fix: every case now calls `command.run(fakeMessage, dbUtils)`
//       instead. Since run() re-parses message.content itself rather than
//       accepting a separate args array, fakeMessage.content is rebuilt
//       below as a realistic space-separated "text command" line (command
//       name, then the same argument order the old [array] version already
//       assumed), and fakeMessage.mentions is now wired to actually resolve
//       the real target GuildMember/User instead of being hardcoded to
//       always return null - this matters if run() checks
//       message.mentions.members.first() first (the same pattern
//       commandhandler.js itself uses for its exemption check) before
//       falling back to parsing a raw ID out of the text.
//
//       ⚠️ ASSUMPTION FLAG: I have not seen the actual contents of ban.js /
//       kick.js / warn.js / mute.js / roleadd.js, so I can't guarantee the
//       exact token order or duration keyword (e.g. "permanent" vs "0" vs
//       omitted entirely) each run() expects out of message.content. I kept
//       the same argument order the previous (broken) version already
//       assumed - target first, then duration (if any), then reason last -
//       just reformatted into a text string instead of an array, since
//       guessing a different order blind would be a bigger risk than
//       preserving what was already there. Send me those 5 files if you
//       want this locked down with certainty instead of a best-effort
//       reconstruction.
//
// [IMPROVEMENT - kept from v3.1] fakeMessage.content is populated (was
//       missing entirely before) so logCommand() can log a real rawMessage
//       instead of undefined for every command executed via slash - useful
//       for the log_command_bot table once it exists in Supabase.
// ============================================================================

const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const path = require('path');

/**
 * Builds a fake Message-like object for a given interaction so it can be
 * passed straight into a command file's run(message, dbUtils).
 * @param {Object} interaction - The Discord Interaction object.
 * @param {string} content - Reconstructed "text command" line, e.g. "ban 123456789012345678 1d spam".
 * @param {Object|null} targetUser - The resolved discord.js User for this action, if any.
 */
function buildFakeMessage(interaction, content, targetUser) {
    const { guild, channel, member, user } = interaction;

    // [FIXED v3.2] Previously hardcoded to always return null regardless of
    // the actual target. Now resolves the real GuildMember (if the target is
    // still in the guild - e.g. not the case for /unban, where the user has
    // left/is banned) so any internal logic that checks message.mentions
    // first works correctly, same as the prefix flow.
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
        // [FIX] delete.js's run() calls `await message.delete()` to remove the
        // invoking command message before doing the bulk delete - makes sense
        // for the prefix flow ("!delete 10" is itself a real channel message)
        // but a slash interaction is never a channel message to begin with.
        // Without this stub, message.delete() throws "not a function"
        // synchronously - the .catch(() => {}) chained onto it in delete.js
        // never gets a chance to run because the crash happens on the call
        // itself, not on the promise it would have returned.
        delete: async () => {},
        mentions: {
            members: { first: () => resolvedMember },
            users: { first: () => targetUser || null }
        }
    };
}

/**
 * MAIN INTERACTION HANDLER
 * @param {Object} interaction - The Discord Interaction object.
 * @param {Object} dbUtils - Universal Database Wrapper.
 */
async function handleSlashCommand(interaction, dbUtils) {
    const { commandName, guild, channel, member, user, options, client } = interaction;

    try {
        // 1. Acknowledge the interaction immediately (3-second window)
        await interaction.deferReply({ ephemeral: true });

        /**
         * SMART BINDING: Fetch guild settings using the Universal Engine.
         * We target 'setting_guild' table which contains access and channel rules.
         */
        const settings = await dbUtils.universalGet('setting_guild', guild.id);

        if (settings) {
            // 2. WHITELIST CHECK (Table Column: whitelisted_channels)
            if (settings.whitelisted_channels?.length > 0) {
                if (!settings.whitelisted_channels.includes(channel.id)) {
                    const allowed = settings.whitelisted_channels.map(id => `<#${id}>`).join(', ');
                    return await interaction.editReply({
                        content: `❌ Restricted: This command can only be used in: ${allowed}`
                    });
                }
            }

            // 3. BLACKLIST CHECK (Table Column: blacklisted_channels)
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
                const target = options.getUser('user');
                const duration = options.getString('duration');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `ban ${target.id} ${duration || 'permanent'} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const banModule = require(path.join(__dirname, 'commands', 'ban'));
                return await banModule.run(fakeMessage, dbUtils);
            }

            case 'kick': {
                const target = options.getUser('user');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `kick ${target.id} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const kickModule = require(path.join(__dirname, 'commands', 'kick'));
                return await kickModule.run(fakeMessage, dbUtils);
            }

            case 'warn': {
                const target = options.getUser('user');
                const reason = options.getString('reason');
                const content = `warn ${target.id}${reason ? ' ' + reason : ''}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const warnModule = require(path.join(__dirname, 'commands', 'warn'));
                return await warnModule.run(fakeMessage, dbUtils);
            }

            case 'unwarn': {
                const target = options.getUser('user');
                const reason = options.getString('reason');
                const content = `unwarn ${target.id}${reason ? ' ' + reason : ''}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const warnModule = require(path.join(__dirname, 'commands', 'warn'));
                return await warnModule.run(fakeMessage, dbUtils);
            }

            case 'mute': {
                const target = options.getUser('user');
                const duration = options.getString('duration');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `mute ${target.id} ${duration || 'permanent'} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                // unmute also lives inside mute.js (same file, same run()) -
                // confirmed via the alias-registration fix in commandhandler.js.
                const muteModule = require(path.join(__dirname, 'commands', 'mute'));
                return await muteModule.run(fakeMessage, dbUtils);
            }

            case 'unmute': {
                const target = options.getUser('user');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `unmute ${target.id} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const muteModule = require(path.join(__dirname, 'commands', 'mute'));
                return await muteModule.run(fakeMessage, dbUtils);
            }

            case 'unban': {
                const userId = options.getString('user_id'); // Matches deploy-commands.js
                const reason = options.getString('reason') || 'No reason provided';
                const content = `unban ${userId} ${reason}`;
                // No discord.js User object available for a raw banned-user
                // ID without an extra fetch - target stays null, which is
                // fine since a banned user isn't a guild member anyway.
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const banModule = require(path.join(__dirname, 'commands', 'ban'));
                return await banModule.run(fakeMessage, dbUtils);
            }

            case 'roleadd': {
                const role = options.getRole('role');
                const target = options.getUser('user');
                /**
                 * [FIX v3.1 - kept] roleadd.js looks up the role by NAME
                 * (role.name), not by ID - sending role.id would always
                 * fail to find the role.
                 * ⚠️ If the role name contains spaces, a naive
                 * message.content.split(/\s+/) inside roleadd.js's own
                 * run() would break this positional format - that is a
                 * pre-existing limitation of the underlying command file's
                 * own parsing (applies equally to the "!roleadd" text
                 * command), not something introduced here.
                 */
                const content = `roleadd ${role.name} ${target.id}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const roleModule = require(path.join(__dirname, 'commands', 'roleadd'));
                return await roleModule.run(fakeMessage, dbUtils);
            }

            case 'demote': {
                const target = options.getUser('user');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `demote ${target.id} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                // handleDemote يعيش بنفس ملف roleadd.js - نفس نمط unmute
                // العايش بملف mute.js.
                const roleModule = require(path.join(__dirname, 'commands', 'roleadd'));
                return await roleModule.run(fakeMessage, dbUtils);
            }

            case 'delete': {
                // [CONFIRMED] اسم الخيار 'amount' متحقق منه ومطابق لتعريف
                // أمر السلاش بـ deploy-commands.js (كان افتراضاً غير مؤكد
                // وقت كتابة هذا السطر أول مرة، قبل ما نشوف deploy-commands.js).
                const amount = options.getInteger('amount');
                const content = `delete ${amount}`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const deleteModule = require(path.join(__dirname, 'commands', 'delete'));
                return await deleteModule.run(fakeMessage, dbUtils);
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