// ============================================================================
// index.js - OmniGuard Core Bot Engine (v3.2 - FIXED GRS Path)
// ============================================================================
// This file is the heart of the bot. It supports Smart Binding (reading
// settings directly from SQL and applying rules dynamically) plus
// Auto-Loading of commands via commandhandler.js.
//
// [FIX v3.1 - kept from before] commandhandler require path was wrong
//       (was pointing at commands/AutoMod/commandhandler); the file
//       actually lives directly at src/commands/commandhandler.js (no
//       AutoMod subfolder). Already corrected below.
//
// [FIX v3.2 - kept] setupNicknameGuard/GRS require path bug:
//       const { setupNicknameGuard } = require(path.join(__dirname,
//           'commands', 'AutoMod', 'GRS'));
//       This treats "AutoMod" as a SUBFOLDER containing GRS.js - but there
//       is no such subfolder anywhere in this project (confirmed
//       repeatedly, and commandhandler.js itself already requires GRS
//       correctly with `require('./GRS')` from the same commands/ folder
//       it lives in). This line would throw MODULE_NOT_FOUND
//       ("Cannot find module '.../commands/AutoMod/GRS'") the instant the
//       bot starts, before it ever reaches client.login() - a guaranteed
//       boot crash. Fixed to require(path.join(__dirname, 'commands',
//       'GRS')), matching GRS.js's real location directly under
//       src/commands/, exactly like commandhandler.js already does.
//
// [CLEANUP] Removed a redundant re-require of AutoMod.js inside the
//       messageCreate handler - it shadowed the already-imported top-level
//       `autoMod` constant with a second `const autoMod = require(...)`.
//       require() is cached by Node either way so this made no functional
//       difference, but it's dead weight and confusing to read; the
//       top-level import is reused instead. No behavior change.
//
// [FIX v3.3 - new, this pass] checkExpiredActions(): the "mark as processed"
//       update was nested inside the same try block as the Discord-side
//       unban()/timeout() call. If a moderator manually unbanned/unmuted the
//       user before the scheduled expiry ran, the Discord API call would
//       throw (target no longer banned/muted) and jump straight to catch -
//       skipping the processed=true update entirely. The record stayed
//       processed=false forever, so the bot retried the same failing action
//       every 60 seconds indefinitely, spamming the console with errors.
//       Fixed by splitting this into two independent try/catch blocks: one
//       around the Discord call (still just logs on failure, same as
//       before), and a second, unconditional one around the processed=true
//       update that always runs regardless of whether the Discord call
//       succeeded or failed above.
// ============================================================================

const path = require('path');
// Load environment variables precisely from the parent folder
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Import the shared client from client.js to avoid double-initialization
const client = require('./client');

// Import helper modules and engines
const dbUtils = require(path.join(__dirname, 'supabase', 'dbUtils'));
const autoMod = require(path.join(__dirname, 'commands', 'AutoMod'));
const antiAlt = require(path.join(__dirname, 'commands', 'AntiAlt'));
// [FIXED v3.2] Was: path.join(__dirname, 'commands', 'AutoMod', 'GRS')
const { setupNicknameGuard } = require(path.join(__dirname, 'commands', 'GRS'));

// [FIXED v3.1] Correct path: commandhandler.js lives directly under src/commands/
const commandHandler = require(path.join(__dirname, 'commands', 'commandhandler'));

const { registerServerEvents } = require(path.join(__dirname, 'events', 'server'));
const { handleSlashCommand } = require(path.join(__dirname, 'slashCommandsHandler'));

// [NEW] هذين يصدّران `(client) => {...}` لكن ما كانوا مربوطين بأي require() بالمشروع:
// - Rolemanagement.js: تعيين new_user_auto_roles + سكجولر إزالة الرتب المؤقتة
// - welcome.js: الإرسال الفعلي لرسائل الترحيب/المغادرة (النسخة الأغنى)
const roleManagement = require(path.join(__dirname, 'commands', 'Rolemanagement'));
const welcome = require(path.join(__dirname, 'commands', 'welcome'));
const initRolesSync = require(path.join(__dirname, 'commands', 'getroles'));

// Export the client immediately to avoid a Circular Dependency issue
module.exports = client;

// ============================================
// 1. READY EVENT
// ============================================
client.once('ready', async () => {
    console.log('--------------------------------------------------');
    console.log(`[OmniGuard] Status: ONLINE`);
    console.log(`[OmniGuard] Bot User: ${client.user.tag}`);
    console.log(`[OmniGuard] Connected Guilds: ${client.guilds.cache.size}`);
    console.log('--------------------------------------------------');

    try {
        // Verify the Supabase connection is stable on startup
        const dbCheck = await dbUtils.pingDatabase();
        if (dbCheck) {
            console.log('[OmniGuard] Database Status: CONNECTED & READY');
        }

        } catch (dbError) {
        console.error('[OmniGuard] Database Connection Error:', dbError.message);
    }
});

// ============================================
// 2. SLASH COMMAND HANDLING
// ============================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        // Hand the interaction off to the smart handler (Auto-Loading Bridge)
        await handleSlashCommand(interaction, dbUtils);
    } catch (error) {
        console.error(`[Interaction Error]: ${interaction.commandName}`, error);

        const errorResponse = { content: '❌ An internal error occurred while executing this command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorResponse);
        } else {
            await interaction.reply(errorResponse);
        }
    }
});

// ============================================
// 3. PREFIX COMMAND HANDLING
// ============================================
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    try {
        // Run the automated moderation engines
        // [AutoMod Engine]: spam, bad words, and link filtering
        await autoMod.handleMessage(message);

        // [AntiAlt Engine]: writing-behavior/spam checks for recent accounts
        await antiAlt.handleMessage(message);

        /**
         * [Smart Binding Logic]:
         * Fetch guild settings. Keys here match the setting_guild table
         * columns in SQL.
         */
        const settings = await dbUtils.universalGet('setting_guild', message.guild.id);

        // No settings found (new guild) -> fall back to defaults
        const prefix = settings?.prefix_bot || '!';
        const accessLevel = settings?.access_dashboard || 'staff';

        // 1. Access level check
        if (accessLevel === 'owner-only' && message.author.id !== message.guild.ownerId) {
            return; // Ignore the message if the bot is restricted to the owner only
        }

        // 2. Check the dynamic prefix coming from the database
        if (!message.content.startsWith(prefix)) return;

        /**
         * Prepare the message for processing:
         * strip the prefix and pass only the command "body" onward.
         */
        const originalContent = message.content;
        message.content = message.content.slice(prefix.length).trim();

        // Hand the message off to the "Auto-Loader Dispatcher" (CommandHandler)
        // It will search the folder automatically for the right command file
        const commandExecuted = await commandHandler.handleMessage(message, dbUtils, settings);

        // If a command actually ran, restore the original content so logs stay accurate
        if (commandExecuted) {
            message.content = originalContent;
        }

    } catch (commandError) {
        console.error('[OmniGuard] Message Execution Error:', commandError);
    }
});

// ============================================
// 4. EVENT REGISTRATION & AUTOMATED SYSTEMS
// ============================================

// [FIX] كان هنا listener مستقل لـ guildMemberAdd يستدعي antiAlt.handleMemberJoin
// بالتوازي مع listener ثاني لنفس الحدث بالضبط جوه registerServerEvents() (عبر
// server.js) - يعني AntiAlt.js كان يشتغل مرتين متوازيتين على كل عضو ينضم، مع
// احتمال Race Condition مع رسالة الترحيب/الرتب التلقائية (ما فيه ضمان أي واحد
// ينفذ أول). بعد تعديل server.js ليستدعي antiAlt.handleMemberJoin() بالتسلسل
// الصحيح بنفسه (ويتأكد العضو لسه موجود قبل ما يكمل لرسالة الترحيب)، صار هذا
// الـ listener المنفصل هنا زيادة ومصدر تضارب - تم حذفه.

// Bind member-join/leave events, AntiAlt detection, and role restore
registerServerEvents(client, dbUtils);

// [NEW] لازم يتسجلوا هنا قبل client.login() بالأسفل - نفس سبب
// setupNicknameGuard/antiAlt.init جنبهم: Rolemanagement.js يسجل
// client.once('ready', ...) داخلي خاص فيه لتشغيل السكجولر كل 30 ثانية،
// ولو تسجل بعد ما 'ready' الحقيقي يكون انطلق فعلياً، هذا الـ once() ما رح ينفذ إطلاقاً.
roleManagement(client);
welcome(client);
// [NEW] getroles.js يسجل client.once('ready', ...) داخلي خاص فيه (أول
// مزامنة كاملة + بدء الـ Job كل 12 ساعة) - لازم يُستدعى هنا قبل
// client.login()، نفس سبب الثلاثة اللي فوقه بالضبط.
initRolesSync(client);

// [GRS] Enable nickname enforcement - must be registered here (before
// client.login() below) and NOT inside the client.once('ready', ...) block
// above, because setupNicknameGuard registers its own internal
// client.once('ready', ...) listener - if we registered it after the
// ready event already fired, it would never trigger (once() can't catch
// an event that already happenend)
setupNicknameGuard(client, dbUtils);

// [FIX] نفس مشكلة GRS بالأعلى بالضبط - antiAlt.init() يسجل client.once('ready', ...)
// داخلي خاص فيه (لتخزين دعوات كل سيرفر بالكاش عند الإقلاع). كان يُستدعى من جوه
// ready-handler الرئيسي بالأعلى، أي بعد ما 'ready' يكون انطلق فعلياً - فالـonce()
// الداخلي ما كان ينفذ إطلاقاً. نفس الحل بالضبط: نسجله هنا قبل client.login().
antiAlt.init(client);
console.log('[OmniGuard] AntiAlt System: INITIALIZED');

// ============================================
// 5. AUTO-UNPUNISH ENGINE (scheduled temp action expiry)
// ============================================
const supabase = require('./supabase/db');

async function checkExpiredActions() {
    const now = new Date().toISOString();

    // 1. Fetch punishments whose time has expired and haven't been processed yet
    const { data: expiredActions, error } = await supabase
        .from('temp_actions')
        .select('*')
        .eq('processed', false)
        .lte('ends_at', now);

    if (error || !expiredActions) return;

    for (const action of expiredActions) {
        const guild = client.guilds.cache.get(action.id_guild);
        if (!guild) continue;

        // [FIX v3.3] Discord-side call isolated in its own try/catch. If it
        // fails (e.g. the user was already manually unbanned/unmuted), we
        // only log it here - we do NOT let that failure skip the
        // processed=true update below.
        try {
            if (action.action_type === 'ban') {
                await guild.members.unban(action.id_user, 'Temporary ban expired');
                console.log(`[Auto-Unban] Unbanned user ${action.id_user} in guild ${guild.id}`);
            } else if (action.action_type === 'mute') {
                const member = await guild.members.fetch(action.id_user).catch(() => null);
                if (member && member.communicationDisabledUntil) {
                    await member.timeout(null, 'Temporary mute expired');
                    console.log(`[Auto-Unmute] Unmuted user ${action.id_user} in guild ${guild.id}`);
                }
            }
        } catch (err) {
            console.error(`[Auto-Unpunish Error] Action ID ${action.id}:`, err.message);
        }

        // 2. Always mark the record as processed, regardless of whether the
        // Discord-side unban/unmute call above succeeded or failed - once
        // the scheduled time has passed, this record's job is done either
        // way, and it must never be retried again.
        try {
            await supabase
                .from('temp_actions')
                .update({ processed: true })
                .eq('id', action.id);
        } catch (updateErr) {
            console.error(`[Auto-Unpunish Error] Failed to mark Action ID ${action.id} as processed:`, updateErr.message);
        }
    }
}

// Run the check every 60 seconds
client.once('ready', () => {
    setInterval(checkExpiredActions, 60000);
    console.log('[OmniGuard] Punishment Scheduler: STARTED (Checking every 60s)');
});

// ============================================
// 6. LOGIN
// ============================================
client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('[OmniGuard] Critical Login Failure:', err.message);
});