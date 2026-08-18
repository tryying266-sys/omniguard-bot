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
 * يدعم: ID الرتبة - منشن الرتبة (@role) - الاسم الكامل - جزء من الاسم -
 * اسم مكتوب بالخطأ (Typo Tolerance)
 */

/**
 * [NEW] تطبيع نص اسم الرتبة قبل أي مقارنة - يشيل الأحرف المخفية غير
 * المرئية (علامات اتجاه RTL/LTR، مسافات صفرية Zero-Width) اللي ديسكورد/
 * المتصفح ممكن يضيفها تلقائياً وقت كتابة نص عربي، ويوحّد أي تكرار مسافات
 * لمسافة وحدة. بدون هذا، اسمين متطابقين بالعين تماماً كانوا يفشلوا
 * بالمطابقة التامة (===) بسبب فرق حرف غير مرئي، وتنزل الخوارزمية غلط
 * لمرحلة المطابقة الجزئية (وتقص اسم الرتبة عند أول كلمتين مثلاً).
 */
function normalizeRoleText(str) {
    if (!str) return '';
    return str
        .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '') // مسافات صفرية + علامات اتجاه مخفية
        .replace(/\s+/g, ' ') // أي تكرار/نوع مسافات -> مسافة وحدة موحدة
        .trim();
}

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
    const cleanQuery = normalizeRoleText(query.replace(/[<@&>]/g, ''));
    if (!cleanQuery) return null;

    const roleById = guild.roles.cache.get(cleanQuery);
    if (roleById) return roleById;

    const lowerQuery = cleanQuery.toLowerCase();

    const exactMatches = guild.roles.cache.filter(r => normalizeRoleText(r.name).toLowerCase() === lowerQuery);
    if (exactMatches.size > 0) {
        return exactMatches.sort((a, b) => b.position - a.position).first();
    }

    const containsMatches = guild.roles.cache.filter(r => {
        const roleNameLower = normalizeRoleText(r.name).toLowerCase();
        return roleNameLower.includes(lowerQuery) || lowerQuery.includes(roleNameLower);
    });

    if (containsMatches.size > 0) {
        // [FIX] الترتيب الآن بالتشابه الفعلي (Levenshtein) مش بفرق الطول بس -
        // فرق الطول ممكن يخطئ لو فيه رتبتين بنفس الطول تقريباً لكن تشابه
        // مختلف فعلياً بالحروف (مثلاً "Moderator" مقابل "Moderatorx")
        const sorted = [...containsMatches.values()].sort((a, b) => {
            const simA = calculateSimilarity(lowerQuery, a.name.trim().toLowerCase());
            const simB = calculateSimilarity(lowerQuery, b.name.trim().toLowerCase());
            return simB - simA; // الأعلى تشابهاً أولاً
        });
        return sorted[0];
    }

    // 4. البحث بالذكاء التقريبي (Typo Tolerance) - آخر خيار
    let bestMatch = null;
    let highestSimilarity = 0;

    guild.roles.cache.forEach(role => {
        const roleNameLower = normalizeRoleText(role.name).toLowerCase();
        const sim = calculateSimilarity(lowerQuery, roleNameLower);
        if (sim > highestSimilarity) {
            highestSimilarity = sim;
            bestMatch = role;
        }
    });

    if (bestMatch && highestSimilarity >= 0.6) {
        return bestMatch;
    }

    return null;
}

/**
 * [NEW] نسخة "صارمة" من البحث - ID الرتبة أو مطابقة تامة للاسم فقط، بدون
 * أي بحث جزئي أو تقريبي (Typo). تُستخدم كتمريرة أولى بحلقة handleDemote
 * عشان لو المشرف كتب اسم الرتبة كاملاً وبالضبط، يُلتقط بثقة 100% فوراً -
 * قبل حتى ما نعطي فرصة للتخمين التقريبي إنه يلخبط بين رتبتين متشابهتين.
 */
function findRoleExact(guild, query) {
    if (!guild || !query) return null;
    const cleanQuery = normalizeRoleText(query.replace(/[<@&>]/g, ''));
    if (!cleanQuery) return null;

    const roleById = guild.roles.cache.get(cleanQuery);
    if (roleById) return roleById;

    const lowerQuery = cleanQuery.toLowerCase();
    const exactMatches = guild.roles.cache.filter(r => normalizeRoleText(r.name).toLowerCase() === lowerQuery);
    if (exactMatches.size > 0) {
        return exactMatches.sort((a, b) => b.position - a.position).first();
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

    // البحث الذكي عن الرتبة (ID / منشن / اسم كامل / جزء من الاسم / خطأ إملائي)
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

        // إرسال إشعار الـ Embed فقط - حقل السبب منفصل تماماً عن حقل اسم الرتبة المضافة
        if (commandNotifications?.notifyCommandExecution) {
            await commandNotifications.notifyCommandExecution({
                guild: message.guild,
                targetMember: target,
                moderator: message.author,
                channel: message.channel,
                action: 'roleadd',
                reason: 'No reason provided',
                roleName: role.name,
                duration: null
            });
        }
        // ملاحظة: تم إزالة رسالة التأكيد النصية بعد الـ Embed بناءً على الطلب -
        // الإشعار الوحيد المرسل الآن هو الـ Embed عبر notifyCommandExecution
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

    // استخراج الرتبة والسبب بدقة عالية مع دعم Mentions و Multi-Word Names و Role ID و البحث الجزئي/التقريبي
    let targetRole = message.mentions.roles.first() || null;
    let reasonParts = [];

    if (targetRole) {
        reasonParts = args.slice(1).filter(arg => !arg.includes(targetRole.id));
    } else if (args.length > 1) {
        // [FIX] تمريرتان منفصلتان بدل تمريرة وحدة تخلط "المطابقة التامة"
        // بـ"التخمين التقريبي" مع بعض:
        //
        // التمريرة 1 (صارمة): نفحص كل الاحتمالات من الأطول للأقصر، بحثاً
        // عن مطابقة تامة فقط (findRoleExact - بدون تخمين إطلاقاً). لو
        // المشرف كتب اسم الرتبة كاملاً وبالضبط بأي مكان بالجملة، هذي
        // التمريرة تلقطه بثقة تامة قبل ما نعطي فرصة لأي تخمين يلخبط بينه
        // وبين رتبة ثانية مشابهة بالاسم.
        for (let i = args.length - 1; i >= 1; i--) {
            const possibleRoleQuery = args.slice(1, i + 1).join(' ');
            const exactRole = findRoleExact(message.guild, possibleRoleQuery);
            if (exactRole) {
                targetRole = exactRole;
                reasonParts = args.slice(i + 1);
                break;
            }
        }

        // التمريرة 2 (ذكية/تقريبية) - تشتغل فقط لو ما فيه ولا مطابقة تامة
        // بأي احتمال إطلاقاً. نفس البحث الذكي القديم (جزئي + Typo) كخطة
        // احتياطية بس، بدون ما يزاحم المطابقة التامة أو يسبقها بالأولوية.
        if (!targetRole) {
            for (let i = args.length - 1; i >= 1; i--) {
                const possibleRoleQuery = args.slice(1, i + 1).join(' ');
                const foundRole = findRoleSmart(message.guild, possibleRoleQuery);
                if (foundRole) {
                    targetRole = foundRole;
                    reasonParts = args.slice(i + 1);
                    break;
                }
            }
        }

        if (!targetRole) {
            reasonParts = args.slice(1);
        }
    }

    const reason = reasonParts.join(' ').trim() || 'No reason provided';

    try {
        const activeAutoMod = autoMod || require('./AutoMod');
        const demoteResult = await activeAutoMod.demoteMember(target, reason, targetRole);

        if (!demoteResult.success) {
            // [FIX] رسالة واضحة ومحددة لكل سبب فشل، بدل رسالة عامة وحدة كانت
            // تذكر "Hierarchy" حتى لما السبب الحقيقي شي ثاني تماماً.
            switch (demoteResult.error) {
                case 'MEMBER_LACKS_ROLE':
                    return message.reply(`❌ <@${target.id}> does not currently have the role **${demoteResult.roleQueried || targetRole?.name}**.`);
                case 'NO_DEMOTABLE_ROLES':
                    return message.reply(`❌ <@${target.id}> has no roles that can be demoted.`);
                case 'BOT_HIERARCHY_TOO_LOW':
                    return message.reply(`❌ My highest role is not above **${demoteResult.roleQueried}** - I cannot remove it (role hierarchy).`);
                default:
                    return message.reply('❌ Something went wrong while demoting this member.');
            }
        }

        const finalRoleName = targetRole?.name || demoteResult.roleName || 'No Role Assigned';
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

        // إرسال إشعار الـ Embed فقط - حقل السبب (reason) منفصل تماماً عن حقل اسم الرتبة
        // المُزالة (roleName)، بدون دمجهما بنفس النص كما كان سابقاً
        if (commandNotifications?.notifyCommandExecution) {
            await commandNotifications.notifyCommandExecution({
                guild: message.guild,
                targetMember: target,
                moderator: message.author,
                channel: message.channel,
                action: 'demote',
                reason: reason,
                roleName: finalRoleName,
                duration: null
            });
        }
        // ملاحظة: تم إزالة رسالة التأكيد النصية بعد الـ Embed بناءً على الطلب -
        // الإشعار الوحيد المرسل الآن هو الـ Embed عبر notifyCommandExecution
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
    findRoleSmart,
    findRoleExact,
    normalizeRoleText // [NEW]
};