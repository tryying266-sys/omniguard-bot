// ============================================================================
// delete.js - Universal Bulk Delete System (v4.0 - Smart Binding)
// ============================================================================
// Supports: Prefix & Slash (via Bridge).
// Database: Integrated with log_command_bot and log_index_message.
// ============================================================================

const { PermissionsBitField } = require('discord.js');

/**
 * 1. CORE LOGIC: executeDelete
 * Performs the bulk delete and handles Discord API limitations.
 */
async function executeDelete(channel, amount, moderator, dbUtils, messageObject = null) {
    try {
        // Discord limit: bulkDelete only works for messages up to 100 at a time
        // and not older than 14 days.
        const deleteCount = Math.min(amount, 100);

        // Execute Bulk Delete
        const deleted = await channel.bulkDelete(deleteCount, true);
        const actualCount = deleted.size;

        // --- DATABASE LOGGING (Smart Binding) ---
        
        // 1. Log Command Usage (Who, When, Where)
        if (dbUtils?.logCommand) {
            await dbUtils.logCommand({
                guildId: channel.guild.id,
                userId: moderator.id,
                username: moderator.tag,
                commandName: 'delete',
                channelId: channel.id,
                rawMessage: `Deleted ${actualCount} messages`
            });
        }

        // 2. Index the action (If a message object exists)
        if (messageObject && dbUtils?.addLogIndex) {
            await dbUtils.addLogIndex(
                channel.guild.id, 
                messageObject.id, 
                channel.id, 
                "N/A", // No specific target user for bulk delete
                'delete'
            );
        }

        return { success: true, count: actualCount };

    } catch (err) {
        console.error('[Delete Engine Error]:', err);
        if (err.message.includes('14 days old')) {
            return { success: false, error: "I cannot delete messages older than 14 days." };
        }
        return { success: false, error: "Internal error during deletion." };
    }
}

/**
 * 2. ENTRY POINT: run (Auto-Loading Support)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    // Permission Check: ManageMessages
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return message.reply("❌ You lack 'Manage Messages' permission.");
}
    // Bot Permission Check in the specific channel
    if (!message.guild.members.me.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageMessages)) {
        return message.reply("❌ I don't have 'Manage Messages' permission in this channel.");
    }

    if (command === 'delete' || command === 'clear') {
        const amountArg = args[0];
        if (!amountArg) return message.reply("⚠️ Usage: `delete <amount>` (1-100)");

        const amount = parseInt(amountArg);
        if (isNaN(amount) || amount < 1 || amount > 100) {
            return message.reply("❌ Please provide a valid number between 1 and 100.");
        }

        // Delete the command message itself first to keep logs clean
        await message.delete().catch(() => {});

        const result = await executeDelete(message.channel, amount, message.author, dbUtils, message);

        if (result.success) {
            const reply = await message.channel.send(`✅ Successfully deleted **${result.count}** messages.`);
            
            // Auto-delete the confirmation message after 5 seconds
            setTimeout(() => {
                reply.delete().catch(() => {});
            }, 5000);
        } else {
            return message.channel.send(`❌ Error: ${result.error}`);
        }
    }
}

// delete.js

module.exports = {
    name: 'delete',
    description: 'Bulk delete messages in a channel',
    aliases: ['clear'], // <-- تضاف هنا داخل الكائن
    permissions: [PermissionsBitField.Flags.ManageMessages],
    executeDelete,
    run
};