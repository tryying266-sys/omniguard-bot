// ============================================================================
// slashCommandsHandler.js - Universal Interaction Gateway (v5.1 - Verified Bridge)
// ============================================================================
// This file intercepts slash commands and bridges them into the same logic
// used by the prefix ("!command") flow (src/commands/*.js) via a "Fake
// Message Bridge", without rewriting those files.
//
// [v5.1 CHANGES]
//
// [FIX 3 - roleadd argument order] Confirmed against the real roleadd.js
// (now reviewed in full): handleRoleAdd() reads member FIRST, then role
// name/ID second. The previous version built `roleadd ${role.name}
// ${target.id}` - reversed - which silently failed every single time
// (roleadd.js would try to resolve the role's name as if it were a member
// ID). Corrected below.
//
// [VERIFIED, no changes needed] ban.js and checkpermissions.js were also
// reviewed in full this round - both already matched exactly what the old
// file built for them. Comments on those two cases updated from
// "unverified" to "verified" accordingly.
//
// [NEW] Added slash support for the 8 commands bundled in Anothercommands.js
// (module name: 'slowmode') - slowmode, unslow, nick, removenick, poll,
// endpoll, avatar, invites - none of these had any slash case before, and
// none were registered in deploy-commands.js either (both are now updated
// together). See each case below and deploy-commands.js's own comments for
// the specific design choices (especially 'poll', which reconstructs the
// exact quote-delimited format its real parser already expects instead of
// reimplementing that parsing logic here).
//
// [v5.0 CHANGES - rewritten from scratch after reviewing every real command
// file involved]
//
// [FIX 1 - Whitelist/Blacklist contradiction]
//         The old version enforced BOTH `whitelisted_channels` AND
//         `blacklisted_channels` for slash commands. But GRS.js's own
//         isChannelAllowed() (the single source of truth used by the prefix
//         path in commandhandler.js) explicitly treats blacklist as the ONLY
//         source of restriction - whitelisted_channels is intentionally
//         unused there. That meant a slash command could be rejected in a
//         channel where the exact same prefix command worked fine.
//         Fixed by requiring GRS.js's isChannelAllowed() directly instead of
//         re-implementing channel-restriction logic here - one source of
//         truth, shared by both command paths.
//
// [FIX 2 - Unified cooldown between !command and /command]
//         commandhandler.js now exports checkCommandCooldown(userId), backed
//         by a single shared in-memory Map/Set. This file calls the exact
//         same function (same Map instance, via require('./commandhandler'))
//         so a person can't bypass the 3-second cooldown by switching
//         between prefix and slash - same person, same cooldown window,
//         regardless of which interface they used. This is intentionally
//         separate from the dashboard's own cooldown (authMiddleware.js's
//         dashboardCooldown) - two different "buckets" as agreed.
//
//         [Discord API constraint - cannot be avoided] Unlike the prefix
//         path (where staying fully silent after the first warning is
//         trivial - message.reply() is just skipped), a slash interaction
//         MUST receive an initial response (reply or deferReply) within 3
//         seconds or Discord's own client shows a generic "This interaction
//         failed" message to the user automatically - that is Discord's own
//         behavior, not something this bot sends. So the cooldown check runs
//         BEFORE deferReply(): on the first hit within a cooldown window we
//         send an explicit ephemeral warning; on every hit after that (same
//         window) we deliberately send nothing at all (matching the "warn
//         once, then stay silent" requirement as closely as technically
//         possible) - Discord's own timeout UI is what the user sees after
//         that, not a message from this bot.
//
// [STILL UNVERIFIED] roleadd.js's 'demote' branch itself (order confirmed
// correct - see FIX 3 above, this is about a separate detail): its usage
// string mentions an optional role argument (`demote <@member> [@role]
// [reason]`), but deploy-commands.js's registered '/demote' only exposes
// user + reason (no role option) - so targetRole always resolves to null
// via the slash path, falling into roleadd.js's own "auto-select the
// highest demotable role" behavior. This is a scope choice already baked
// into the current deploy-commands.js definition, not a bug - flagged in
// case manual role selection via slash is wanted later.
//
// [STILL DEAD CODE - not registered in deploy-commands.js at all, so these
// switch-cases below never actually fire from a real Discord interaction]
//         lock, unlock, serverinfo, checkpermissions - all four are fully
//         implemented and verified in this file's switch statement, but
//         Discord has no matching slash command definition to send them.
//         Also missing entirely: userinfo (no case AND no registration).
//         Add SlashCommandBuilder entries for these in deploy-commands.js
//         to actually enable them - say the word and I'll add them.
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

    // [FIX 2] كولداون موحّد - نفس Map المشترك مع البريفكس (commandhandler.js).
    // *قبل* deferReply عمداً - راجع الشرح الكامل بأعلى الملف عن قيد ديسكورد
    // التقني (رد أول خلال 3 ثواني وإلا "This interaction failed" تلقائي).
    const { checkCommandCooldown } = require('./commandhandler');
    const cooldown = checkCommandCooldown(interaction.user.id);
    if (cooldown.onCooldown) {
        if (cooldown.shouldWarn) {
            return interaction.reply({
                content: '⏳ Please wait a few seconds before using another command.',
                ephemeral: true
            }).catch(() => {});
        }
        // سكوت متعمد - لا reply ولا deferReply. ديسكورد نفسه بيعرض حالة
        // فشل التفاعل تلقائياً بعد المهلة القياسية (3 ثواني) بدون أي رد
        // من طرفنا - هذا سلوك ديسكورد نفسه، مو رسالة نرسلها نحن.
        return;
    }

    try {
        // 1. Acknowledge the interaction immediately (3-second window)
        await interaction.deferReply({ ephemeral: true });

        /**
         * SMART BINDING: Fetch guild settings using the Universal Engine.
         */
        const settings = await dbUtils.universalGet('setting_guild', guild.id);

        // [FIX 1] Channel restriction - نفس isChannelAllowed() المستخدمة
        // بمسار البريفكس بالضبط (commandhandler.js -> GRS.js). blacklist هي
        // المصدر الوحيد للمنع - whitelisted_channels متعمد ما يُستخدم هنا،
        // نفس قرار GRS.js. هذا يزيل التناقض القديم بين !command و/command.
        const { isChannelAllowed } = require('./GRS');
        if (!isChannelAllowed(settings, channel.id)) {
            return await interaction.editReply({
                content: "❌ Prohibited: Management commands are disabled in this channel."
            });
        }

        /**
         * COMMAND ROUTING LOGIC
         * Every case builds a fake, text-command-shaped message and calls
         * the module's real export: run(message, dbUtils).
         */
        switch (commandName) {
            // ----------------------------------------------------------
            // ✅ [VERIFIED v5.1] ban.js reviewed - run()'s 'ban' branch
            // expects exactly `<@ID> <duration> <reason>` (parseDuration()
            // on args[1], falling back to 'permanent' if invalid), matching
            // below exactly. deploy-commands.js registers 'duration' as
            // REQUIRED for /ban, so it's always present in practice.
            // ----------------------------------------------------------
            case 'ban': {
                const target = options.getUser('user') || options.getUser('target');
                const duration = options.getString('duration');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `ban <@${target.id}> ${duration || 'permanent'} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const banModule = require(path.join(COMMANDS_PATH, 'ban.js'));
                return await banModule.run(fakeMessage, dbUtils);
            }

            case 'unban': {
                const userId = options.getString('user_id') || options.getString('target_id');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `unban ${userId} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const banModule = require(path.join(COMMANDS_PATH, 'ban.js'));
                return await banModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ Verified against real kick.js: run() expects exactly
            // `kick <@ID> <reason>` (targetArg = args[0], reason = rest).
            // ----------------------------------------------------------
            case 'kick': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `kick <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const kickModule = require(path.join(COMMANDS_PATH, 'kick.js'));
                return await kickModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ Verified against real warn.js: run() branches on
            // command === 'warn' | 'unwarn', both `<@ID> <reason>` shaped.
            // ----------------------------------------------------------
            case 'warn': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `warn <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const warnModule = require(path.join(COMMANDS_PATH, 'warn.js'));
                return await warnModule.run(fakeMessage, dbUtils);
            }

            case 'unwarn': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'Warning removed by staff';
                const content = `unwarn <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const warnModule = require(path.join(COMMANDS_PATH, 'warn.js'));
                return await warnModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ Verified against real mute.js: run() dispatches to
            // handleMute/handleUnmute internally, both expecting
            // `<@ID> <duration?> <reason>` / `<@ID> <reason>` respectively.
            // mute.js's own handleMute requires BOTH targetArg AND
            // durationArg to be present (`if (!targetArg || !durationArg)`),
            // so the '28d' fallback below is required, not optional.
            // ----------------------------------------------------------
            case 'mute': {
                const target = options.getUser('user') || options.getUser('target');
                const duration = options.getString('duration');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `mute <@${target.id}> ${duration || '28d'} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const muteModule = require(path.join(COMMANDS_PATH, 'mute.js'));
                return await muteModule.run(fakeMessage, dbUtils);
            }

            case 'unmute': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `unmute <@${target.id}> ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const muteModule = require(path.join(COMMANDS_PATH, 'mute.js'));
                return await muteModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ Verified against real lock.js: module.exports.aliases =
            // ['unlock'] (single file for both), run() reads the channel
            // mention as an OPTIONAL first token then treats the rest as
            // the reason - exactly matched below.
            // ----------------------------------------------------------
            case 'lock':
            case 'unlock': {
                const targetChannel = options.getChannel('channel');
                const reason = options.getString('reason') || 'No reason provided';
                let content = `${commandName}`;
                if (targetChannel) content += ` <#${targetChannel.id}>`;
                content += ` ${reason}`;

                const fakeMessage = buildFakeMessage(interaction, content, null, targetChannel);
                const lockModule = require(path.join(COMMANDS_PATH, 'lock.js'));
                return await lockModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ Verified against real delete.js: run() accepts both
            // 'delete' and 'clear' as the command word, expects a single
            // numeric amount argument (1-100).
            // ----------------------------------------------------------
            case 'delete':
            case 'clear': {
                const amount = options.getInteger('amount');
                const content = `${commandName} ${amount}`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const deleteModule = require(path.join(COMMANDS_PATH, 'delete.js'));
                return await deleteModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ Verified against real serverinfo.js: run() takes no
            // arguments at all beyond the command word itself.
            // ----------------------------------------------------------
            case 'serverinfo': {
                const content = `serverinfo`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const serverInfoModule = require(path.join(COMMANDS_PATH, 'serverinfo.js'));
                return await serverInfoModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ [VERIFIED v5.1] checkpermissions.js reviewed - run()'s
            // arg-loop checks EACH token independently for a channel match
            // first, then a member match if one wasn't consumed yet - order
            // of the two mentions in the reconstructed content doesn't
            // matter, both get resolved correctly either way.
            // [⚠️ Still dead code - not registered in deploy-commands.js,
            // see file header. This case never actually fires today.]
            // ----------------------------------------------------------
            case 'checkpermissions': {
                const target = options.getUser('user') || options.getUser('target');
                const targetChannel = options.getChannel('channel');
                let content = `checkpermissions`;
                if (target) content += ` <@${target.id}>`;
                if (targetChannel) content += ` <#${targetChannel.id}>`;

                const fakeMessage = buildFakeMessage(interaction, content, target, targetChannel);
                const cpModule = require(path.join(COMMANDS_PATH, 'checkpermissions.js'));
                return await cpModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ [FIXED v5.1] Verified against real roleadd.js:
            // handleRoleAdd() reads args[0] = target member, then
            // args.slice(1).join(' ') = role name/ID (fuzzy-matched via
            // findRoleSmart). The PREVIOUS version of this file had these
            // swapped (`roleadd ${role.name} ${target.id}` - role first,
            // member second), which silently failed every time since
            // roleadd.js would try to resolve the role's name as a member
            // ID. Order corrected below: member first, then role name.
            // ----------------------------------------------------------
            case 'roleadd': {
                const target = options.getUser('user') || options.getUser('target');
                const role = options.getRole('role');
                const content = `roleadd <@${target.id}> ${role.name}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const roleModule = require(path.join(COMMANDS_PATH, 'roleadd.js'));
                return await roleModule.run(fakeMessage, dbUtils);
            }

            // ----------------------------------------------------------
            // ✅ Verified against real roleadd.js: handleDemote() reads
            // args[0] = target member, then optionally scans the rest for
            // a role mention/name (message.mentions.roles / findRoleExact /
            // findRoleSmart) before treating whatever's left as the reason.
            // deploy-commands.js's registered '/demote' intentionally has
            // no role option (user + reason only), so `targetRole` always
            // resolves to null here - matching the file's own "no role
            // specified" path (AutoMod.demoteMember auto-selects/removes
            // the member's highest demotable role). This is a scope choice
            // already baked into the current deploy-commands.js definition,
            // not something broken - flagging only as an FYI in case manual
            // role selection via slash is wanted later.
            // ----------------------------------------------------------
            case 'demote': {
                const target = options.getUser('user') || options.getUser('target');
                const reason = options.getString('reason') || 'No reason provided';
                const content = `demote ${target.id} ${reason}`;
                const fakeMessage = buildFakeMessage(interaction, content, target);
                const roleModule = require(path.join(COMMANDS_PATH, 'roleadd.js'));
                return await roleModule.run(fakeMessage, dbUtils);
            }

            // ============================================================
            // [NEW v5.1] Utility Bundle (Anothercommands.js, module name:
            // 'slowmode') - slowmode/unslow/nick/removenick/poll/endpoll/
            // avatar/invites. These 8 commands had ZERO slash support
            // before (never even had a switch-case here). All content
            // strings below were built by tracing Anothercommands.js's
            // run() dispatcher line-by-line for each branch - see that
            // file's comments for the exact parsing each one expects.
            // ============================================================

            // ✅ run(): 'slowmode' branch reads args[0] via
            // parseSlowmodeDuration() (accepts "30s"/"10m"/"2h" or a plain
            // number), then an OPTIONAL channel mention at args[1], then
            // the rest as the reason.
            case 'slowmode': {
                const durationInput = options.getString('duration');
                const targetChannel = options.getChannel('channel');
                const reason = options.getString('reason') || 'No reason provided';

                let content = `slowmode ${durationInput}`;
                if (targetChannel) content += ` <#${targetChannel.id}>`;
                content += ` ${reason}`;

                const fakeMessage = buildFakeMessage(interaction, content, null, targetChannel);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
            }

            // ✅ run(): 'unslow' branch - same shape as slowmode but with
            // no duration token at all (implied 0/disabled).
            case 'unslow': {
                const targetChannel = options.getChannel('channel');
                const reason = options.getString('reason') || 'Slowmode removed';

                let content = 'unslow';
                if (targetChannel) content += ` <#${targetChannel.id}>`;
                content += ` ${reason}`;

                const fakeMessage = buildFakeMessage(interaction, content, null, targetChannel);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
            }

            // ✅ run(): 'nick' branch reads the target mention/ID at
            // args[0], then joins everything after it as the new nickname
            // (empty = reset, same as removenick's forced-empty behavior).
            case 'nick': {
                const target = options.getUser('user');
                const newNickname = options.getString('nickname') || '';
                const content = `nick <@${target.id}> ${newNickname}`.trim();

                const fakeMessage = buildFakeMessage(interaction, content, target);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
            }

            // ✅ run(): 'removenick' branch always forces an empty
            // nickname regardless of any extra typed text - only the
            // target mention matters here.
            case 'removenick': {
                const target = options.getUser('user');
                const content = `removenick <@${target.id}>`;

                const fakeMessage = buildFakeMessage(interaction, content, target);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
            }

            // ✅ run(): 'poll' branch hands rawRest straight to
            // handlePollCommand(), which expects a quote-delimited token
            // list: `"Question" "Option1" "Option2" ... --time X --anon`.
            // Rather than reimplementing that parser here, we reconstruct
            // the exact same quoted format from the slash options and let
            // the real, already-validated prefix parser handle it - same
            // "Fake Message Bridge" philosophy as every other case in this
            // file. User-typed double-quotes are swapped for single quotes
            // first so they can't break the quote-delimited reconstruction.
            case 'poll': {
                const escapeForQuotes = (s) => String(s).replace(/"/g, "'");

                const question = options.getString('question');
                const optionInputs = [1, 2, 3, 4, 5]
                    .map(n => options.getString(`option${n}`))
                    .filter(Boolean);
                const timeStr = options.getString('time');
                const anonymous = options.getBoolean('anonymous');

                let rawRest = `"${escapeForQuotes(question)}"`;
                for (const opt of optionInputs) {
                    rawRest += ` "${escapeForQuotes(opt)}"`;
                }
                if (timeStr) rawRest += ` --time ${timeStr}`;
                if (anonymous) rawRest += ' --anon';

                const content = `poll ${rawRest}`;
                const fakeMessage = buildFakeMessage(interaction, content, null);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
            }

            // ✅ run(): 'endpoll' branch calls handleEndPollCommand(message,
            // args), which uses `message.reference?.messageId || args[0]`.
            // Slash interactions have no "replying to a message" concept,
            // so message_id is a required option here and always becomes
            // args[0].
            case 'endpoll': {
                const messageId = options.getString('message_id');
                const content = `endpoll ${messageId}`;

                const fakeMessage = buildFakeMessage(interaction, content, null);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
            }

            // ✅ run(): 'avatar' branch resolves target from a mention/ID
            // at args[0], defaulting to the sender themselves if omitted -
            // matched exactly by making the option optional.
            case 'avatar': {
                const target = options.getUser('user');
                const content = target ? `avatar <@${target.id}>` : 'avatar';

                const fakeMessage = buildFakeMessage(interaction, content, target || null);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
            }

            // ✅ run(): 'invites' branch - same optional-target/defaults-to-
            // self shape as avatar above.
            case 'invites': {
                const target = options.getUser('user');
                const content = target ? `invites <@${target.id}>` : 'invites';

                const fakeMessage = buildFakeMessage(interaction, content, target || null);
                const utilModule = require(path.join(COMMANDS_PATH, 'Anothercommands.js'));
                return await utilModule.run(fakeMessage, dbUtils);
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