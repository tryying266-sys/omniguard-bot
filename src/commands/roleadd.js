const { PermissionsBitField } = require('discord.js');

// استيراد آمن للملفات المساعدة لتجنب خطأ المجلدات الفرعية
function safeRequire(relativePath) {
    try {
        return require(relativePath);
    } catch (e1) {
        try {
            return require(`.${relativePath}`);
        } catch (e2) {
            try {
                return require(`..${relativePath.replace('.', '')}`);
            } catch (e3) {
                return null;
            }
        }
    }
}

const autoMod = safeRequire('./AutoMod');
const commandNotifications = safeRequire('./commandNotifications');

/**
 * خوارزمية البحث الذكي والتقريبي عن الرتب (Fuzzy Match & Smart Search)
 */
function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function calculateSimilarity(str1, str2) {
    const longer = str1.length < str2.length ? str2 : str1;
    const shorter = str1.length < str2.length ? str1 : str2;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / parseFloat(longer.length);
}

function findRoleSmart(guild, query) {
    if (!guild || !query) return null;
    const cleanQuery = query.trim().replace(/[<@&>]/g, '');

    // 1. البحث بواسطة ID الرتبة
    const roleById = guild.roles.cache.get(cleanQuery);
    if (roleById) return roleById;

    const lowerQuery = cleanQuery.toLowerCase();

    // 2. مطابقة تامة لاسم الرتبة
    const exactMatch = guild.roles.cache.find(r => r.name.toLowerCase() === lowerQuery);
    if (exactMatch) return exactMatch;

    // 3. مطابقة بداية اسم الرتبة
    const startsWithMatch = guild.roles.cache.find(r => r.name.toLowerCase().startsWith(lowerQuery));
    if (startsWithMatch) return startsWithMatch;

    // 4. مطابقة جزء من اسم الرتبة
    const includesMatch = guild.roles.cache.find(r => r.name.toLowerCase().includes(lowerQuery));
    if (includesMatch) return includesMatch;

    // 5. البحث التقريبي الذكي (Fuzzy Matching)
    let bestMatch = null;
    let highestSimilarity = 0;

    guild.roles.cache.forEach(role => {
        const roleNameLower = role.name.toLowerCase();
        const sim = calculateSimilarity(lowerQuery, roleNameLower);
        if (sim > highestSimilarity) {
            highestSimilarity = sim;
            bestMatch = role;
        }
    });

    // حد أدنى للقبول (50% تشابه على الأقل)
    if (bestMatch && highestSimilarity >= 0.5) {
        return bestMatch;
    }

    return null;
}

async function handleRoleAdd(message, args, dbUtils = null) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply('❌ You do not have permission to manage roles.');
    }

    if (args.length < 2) {
        return message.reply('⚠️ Usage: `roleadd <@member> <roleName/ID>`');
    }

    const targetArg = args[0];
    const roleQuery = args.slice(1).join(' ');

    if (!targetArg || !roleQuery) {
        return message.reply('⚠️ Usage: `roleadd <@member> <roleName/ID>`');
    }

    const target = message.mentions.members?.first() || await message.guild.members.fetch(targetArg.replace(/[<@!>]/g, '')).catch(() => null);
    if (!target) {
        return message.reply('❌ I could not find that member.');
    }

    // البحث الذكي عن الرتبة
    const role = findRoleSmart(message.guild, roleQuery);
    if (!role) {
        return message.reply('❌ I could not find any role matching that input.');
    }

    if (message.guild.ownerId !== message.author.id && message.member.roles.highest.position <= role.position) {
        return message.reply('❌ You cannot manage a role higher than or equal to your highest role.');
    }

    if (!role.editable) {
        return message.reply('❌ I cannot assign this role (Role hierarchy constraint).');
    }

    try {
        await target.roles.add(role);

        if (dbUtils?.logCommand) {
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag || message.author.username,
                commandName: 'roleadd',
                channelId: message.channel.id,
                rawMessage: message.content
            });
        }

        // إرسال الإشعار التلقائي بحسب إعدادات الداشبورد
        if (commandNotifications?.notifyCommandExecution) {
            await commandNotifications.notifyCommandExecution({
                guild: message.guild,
                targetMember: target,
                moderator: message.author,
                channel: message.channel,
                action: 'roleadd',
                reason: `Assigned Role: ${role.name}`,
                duration: null
            });
        }

        return;
    } catch (error) {
        console.error('[Role Add Error]', error);
        return message.reply('❌ Something went wrong while adding the role.');
    }
}

async function handleDemote(message, args, dbUtils = null) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply('❌ You do not have permission to manage roles.');
    }

    const [targetArg, ...reasonParts] = args;
    const reason = reasonParts.join(' ').trim() || 'No reason provided';

    if (!targetArg) {
        return message.reply('⚠️ Usage: `demote <@member> <reason>`');
    }

    const target = message.mentions.members?.first() || await message.guild.members.fetch(targetArg.replace(/[<@!>]/g, '')).catch(() => null);
    if (!target) {
        return message.reply('❌ I could not find that member.');
    }

    if (target.id === message.author.id) {
        return message.reply('❌ You cannot demote yourself.');
    }
    if (target.id === message.guild.ownerId) {
        return message.reply('❌ You cannot demote the server owner.');
    }
    if (message.author.id !== message.guild.ownerId && message.member.roles.highest.position <= target.roles.highest.position) {
        return message.reply('❌ Your role is not high enough to demote this member.');
    }

    try {
        const activeAutoMod = autoMod || require('./AutoMod');
        const demoted = await activeAutoMod.demoteMember(target, reason);

        if (!demoted) {
            return message.reply('❌ Could not demote this member. Check the bot\'s role hierarchy or the demote configuration in the dashboard.');
        }

        const userTag = target.user?.tag || target.user?.username || target.id;

        if (dbUtils?.addInfraction) {
            await dbUtils.addInfraction(message.guild.id, target.id, message.author.id, 'demote', reason, null, userTag);
        }
        if (dbUtils?.addLogIndex) {
            await dbUtils.addLogIndex(message.guild.id, message.id, message.channel.id, target.id, 'demote');
        }
        if (dbUtils?.logCommand) {
            await dbUtils.logCommand({
                guildId: message.guild.id,
                userId: message.author.id,
                username: message.author.tag || message.author.username,
                commandName: 'demote',
                channelId: message.channel.id,
                rawMessage: message.content
            });
        }

        // إرسال الإشعار عبر commandNotifications
        if (commandNotifications?.notifyCommandExecution) {
            await commandNotifications.notifyCommandExecution({
                guild: message.guild,
                targetMember: target,
                moderator: message.author,
                channel: message.channel,
                action: 'demote',
                reason: reason,
                duration: null
            });
        }

        return;
    } catch (error) {
        console.error('[Demote Command Error]', error);
        return message.reply('❌ Something went wrong while demoting this member.');
    }
}

async function run(message, dbUtils = null) {
    if (message.author.bot || !message.guild) return false;

    const content = message.content.trim();
    if (!content) return false;

    const args = content.split(/\s+/);
    const cmd = args.shift().toLowerCase();

    if (cmd === 'roleadd') {
        await handleRoleAdd(message, args, dbUtils);
        return true;
    }

    if (cmd === 'demote') {
        await handleDemote(message, args, dbUtils);
        return true;
    }

    return false;
}

module.exports = {
    name: 'roleadd',
    description: 'Manages member roles and demotions',
    aliases: ['demote'],
    run,
    handleRoleAdd,
    handleDemote,
    findRoleSmart
};