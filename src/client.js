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

/**
 * [NEW] FULL SHUTDOWN GATE - نقطة اختناق واحدة لكل أحداث ديسكورد
 * ----------------------------------------------------------------------
 * discord.js يستدعي داخلياً client.emit('messageCreate', ...) / ('guildMemberAdd', ...)
 * / ('interactionCreate', ...) إلخ لكل حدث حي يوصل من الـ Gateway - وكل
 * الأنظمة (ترحيب، تذاكر، ردود تلقائية، أوامر، AntiAlt...) مسجّلة كـ .on()
 * على هذي الأحداث بملفات منفصلة. بدل ما نروح نضيف فحص بكل ملف منها (خطر
 * ونشر تغييرات بكل مكان)، نغلّف .emit() نفسه هنا - قبل أي ملف ثاني يسجل
 * أي listener - فلو Full Shutdown مفعّل، الحدث يُبتلع بصمت من هنا ولا توصل
 * ولا وحدة من الأنظمة تشتغل إطلاقاً. البوت "ميت" فعلياً بكل وظائفه، تمامًا
 * حسب الطلب - بدون أي لمسة على welcome.js/ticketAutomation.js/autoRespond.js/
 * AutoMod.js/AntiAlt.js.
 *
 * [استثناء وحيد] 'ready' يمر دايماً - البوت لازم يبقى متصل بالـ Gateway
 * (عشان الداشبورد يقدر يطفي الإغلاق لاحقاً عبر require('./index') بدون
 * الحاجة لإعادة تشغيل العملية كاملة)، فقط ردوده/أفعاله تتوقف، مو اتصاله.
 *
 * [ملاحظة معمارية] getBotState() هنا Sync بالكامل (كاش بالذاكرة يتحدّث دوري
 * من botState.js) - عمداً، عشان ما نبطئ ولا حدث واحد بـ await فعلي.
 */
const { getBotState } = require('./supabase/botState');

const originalEmit = client.emit.bind(client);
client.emit = function (event, ...args) {
    if (event !== 'ready' && getBotState().fullShutdownEnabled) {
        return false; // ابتلاع صامت - ولا listener هيشوف هذا الحدث إطلاقاً
    }
    return originalEmit(event, ...args);
};

// Export the client instance as a singleton
module.exports = client;