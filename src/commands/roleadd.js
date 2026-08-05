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

    // 2. المطابقة التامة المباشرة (Exact Match) - لها الأولوية القاطعة
    const exactMatch = guild.roles.cache.find(r => r.name.toLowerCase() === lowerQuery);
    if (exactMatch) return exactMatch;

    // 3. إذا لم توجد مطابقة تامة، يتم البحث بالذكاء التقريبي دون استعجال على البدايات فقط
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

    // يشترط تشابه عالٍ جداً (75% فأكثر) لتجنب الوقوع في رتبة أخرى متقاربة
    if (bestMatch && highestSimilarity >= 0.75) {
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

       // إرسال الإشعار التلقائي بحسب إعدادات الداشبورد مع تضمين اسم الرتبة المضافة
        if (commandNotifications?.notifyCommandExecution) {
            await commandNotifications.notifyCommandExecution({
                guild: message.guild,
                targetMember: target,
                moderator: message.author,
                channel: message.channel,
                action: 'roleadd',
                reason: `Added Role: ${role.name}`,
                roleName: role.name,
                duration: null
            });
        }

        return message.reply(`✅ Successfully added role **${role.name}** to **${target.user.username}**.`);
    } catch (error) {
        console.error('[Role Add Error]', error);
        return message.reply('❌ Something went wrong while adding the role.');
    }
}

async function handleDemote(message, args, dbUtils = null) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply('❌ You do not have permission to manage roles.');
    }

    if (args.length < 1) {
        return message.reply('⚠️ Usage: `demote <@member> [@role / roleName / RoleID] [reason]`');
    }

    const targetArg = args[0];
    const target = message.mentions.members?.first() || await message.guild.members.fetch(targetArg.replace(/[<@!>]/g, '')).catch(() => null);
    
    if (!target) {
        return message.reply('❌ I could not find that member.');
    }

    if (target.id === message.author.id) return message.reply('❌ You cannot demote yourself.');
    if (target.id === message.guild.ownerId) return message.reply('❌ You cannot demote the server owner.');
    if (message.author.id !== message.guild.ownerId && message.member.roles.highest.position <= target.roles.highest.position) {
        return message.reply('❌ Your role is not high enough to demote this member.');
    }

    // استخراج الرتبة والسبب بدقة عالية مع دعم Mentions و Multi-Word Names و Role ID
    let targetRole = message.mentions.roles.first() || null;
    let reasonParts = [];

    if (targetRole) {
        reasonParts = args.slice(1).filter(arg => !arg.includes(targetRole.id));
    } else if (args.length > 1) {
        for (let i = args.length - 1; i >= 1; i--) {
            const possibleRoleQuery = args.slice(1, i + 1).join(' ');
            const foundRole = findRoleSmart(message.guild, possibleRoleQuery);
            if (foundRole) {
                targetRole = foundRole;
                reasonParts = args.slice(i + 1);
                break;
            }
        }
        if (!targetRole) {
            reasonParts = args.slice(1);
        }
    }

    const reason = reasonParts.join(' ').trim() || 'No reason provided';

    try {
        const activeAutoMod = autoMod || require('./AutoMod');
        const demoted = await activeAutoMod.demoteMember(target, reason, targetRole);

        if (!demoted) {
            return message.reply('❌ Could not demote this member. Check role hierarchy or specified target role.');
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

        const roleInfo = targetRole ? ` | Role: ${targetRole.name}` : '';

        if (commandNotifications?.notifyCommandExecution) {
            await commandNotifications.notifyCommandExecution({
                guild: message.guild,
                targetMember: target,
                moderator: message.author,
                channel: message.channel,
                action: 'demote',
                reason: `${reason}${roleInfo}`,
                roleName: targetRole?.name || 'Auto/Highest Role',
                duration: null
            });
        }

        return message.reply(`✅ Successfully demoted **${target.user.username}**${targetRole ? ` from **${targetRole.name}**` : ''}.`);
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