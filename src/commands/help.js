// ============================================================================
// help.js - Command Reference (v1.0)
// ============================================================================
// عرض بس - أمر معلوماتي مفتوح للجميع (Everyone)، بدون أي تحقق صلاحية داخل
// run() وبدون setDefaultMemberPermissions(0) بالسلاش (راجع deploy-commands.js)
// - نفس فلسفة serverinfo.js/avatar.js/poll.js: أوامر استعلام عامة لا تنفّذ
// أي إجراء إشرافي فعلي، فمنطقي يشوفها الكل.
//
// [IMPORTANT] كل سطر بالجدول تحت (usage + permission) مبني من مراجعة فعلية
// موثّقة بـ slashCommandsHandler.js (كل case فيه اتفحص واتأكد ضد الملف
// الحقيقي قبل ما يُبنى) و deploy-commands.js (لمعرفة أي أمر مسجّل بصلاحية
// setDefaultMemberPermissions(0) ضد أي أمر عام) - مو تخمين ولا نسخ متماثل
// لكل الأوامر. مثال: kick ما فيه duration إطلاقاً (بعكس ban/mute) لأنه فعلاً
// كذا بالملف الحقيقي، مو خطأ نسخ-لصق.
//
// [PERMISSION LABELS] "Staff" = مسجّل بصلاحية setDefaultMemberPermissions(0)
// بالسلاش (مخفي افتراضياً لين الأدمن يفعّله من Integrations) - وصف عام،
// مو ادّعاء بصلاحية Discord محددة لملفات ما تمت مراجعتها بالكامل بعد.
// "Moderate Members" / "Ticket Staff" مكتوبة بس للأوامر اللي تم التأكد من
// صلاحيتها الفعلية بمراجعة الملف نفسه (userinfo.js، ticketsystem.js).
// "Everyone" = غير مقيّد إطلاقاً بالسلاش (بدون setDefaultMemberPermissions).
//
// إذا تحب تضيف أمر جديد لاحقاً، أضفه هنا بنفس الشكل (usage + permission)
// داخل الفئة المناسبة - هذا الملف لا يقرأ أي شي ديناميكياً من deploy-
// commands.js أو الملفات الثانية، فلازم يُحدَّث يدوياً كل ما يُضاف أمر جديد.
// ============================================================================

const { EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0x5865f2; // Discord Blurple - نفس لون الأوامر غير العقابية بالمشروع (راجع تعليق userinfo.js)

/**
 * COMMAND REFERENCE DATA
 * كل عنصر: usage بصيغة البريفكس بالضبط كما يتوقعها run() الحقيقي لكل ملف،
 * و permission وصف مختصر لمن يقدر يستخدمه.
 * `<>` = مطلوب، `[]` = اختياري - نفس اتفاقية توثيق الأوامر بديسكورد عموماً.
 */
function buildCommandCategories(prefix) {
    return [
        {
            title: '🔨 Moderation',
            lines: [
                `\`${prefix}ban <@user> <duration> <reason>\` — Staff`,
                `\`${prefix}unban <user_id> <reason>\` — Staff`,
                `\`${prefix}kick <@user> <reason>\` — Staff`, // ملاحظة: بدون duration عمداً - kick ما فيه مدة إطلاقاً
                `\`${prefix}warn <@user> <reason>\` — Staff`,
                `\`${prefix}unwarn <@user> <reason>\` — Staff`,
                `\`${prefix}mute <@user> <duration> <reason>\` — Staff`,
                `\`${prefix}unmute <@user> <reason>\` — Staff`,
                `\`${prefix}roleadd <@user> <role>\` — Staff`,
                `\`${prefix}demote <@user> [reason]\` — Staff`,
                `\`${prefix}delete <amount>\` — Staff`,
                `\`${prefix}lock [#channel] [reason]\` — Staff`,
                `\`${prefix}unlock [#channel] [reason]\` — Staff`
            ]
        },
        {
            title: '🛡️ Staff Utility',
            lines: [
                `\`${prefix}checkpermissions [@user] [#channel]\` — Staff`,
                `\`${prefix}userinfo [@user]\` — Moderate Members`,
                `\`${prefix}slowmode <duration> [#channel] [reason]\` — Staff`,
                `\`${prefix}unslow [#channel] [reason]\` — Staff`,
                `\`${prefix}nick <@user> [nickname]\` — Staff`,
                `\`${prefix}removenick <@user>\` — Staff`,
                `\`${prefix}settings\` — Staff`
            ]
        },
        {
            title: '🎫 Ticket System',
            lines: [
                `\`${prefix}claim\` — Ticket Staff`,
                `\`${prefix}unclaim\` — Ticket Staff`,
                `\`${prefix}transfer <@staff_member>\` — Ticket Staff`,
                `\`${prefix}add <@user|@role>\` — Ticket Staff`,
                `\`${prefix}remove <@user|@role>\` — Ticket Staff`,
                `\`${prefix}bump\` — Ticket Staff`,
                `\`${prefix}close [reason]\` — Ticket Staff`,
                `\`${prefix}ticket-blacklist <@user> [duration] [reason]\` — Moderate Members`,
                `\`${prefix}ticket-unblacklist <@user>\` — Moderate Members`,
                `\`${prefix}rename <new_name>\` — Ticket Staff`
            ]
        },
        {
            title: '🌐 Public',
            lines: [
                `\`${prefix}serverinfo\` — Everyone`,
                `\`${prefix}poll "question" ["option1"]... [--time 10m] [--anon]\` — Everyone`,
                `\`${prefix}endpoll <message_id>\` — Everyone`,
                `\`${prefix}avatar [@user]\` — Everyone`,
                `\`${prefix}invites [@user]\` — Everyone`,
                `\`${prefix}dashboard\` — Everyone`
            ]
        }
    ];
}

/**
 * CORE LOGIC: buildHelpEmbed
 * message-independent (guild + prefix فقط) - قابل لإعادة الاستخدام من
 * Slash Command بدون تعديل، نفس نمط userinfo.js's buildUserInfoEmbed.
 */
function buildHelpEmbed(guild, prefix) {
    const categories = buildCommandCategories(prefix);

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`📖 Command Reference — ${guild.name}`)
        .setDescription(
            `Current prefix: \`${prefix}\` — every command below also works as a slash command (\`/command\`) with the same options.\n` +
            `\`<>\` = required argument, \`[]\` = optional argument.`
        )
        .setFooter({ text: 'OmniGuard Universal Engine' })
        .setTimestamp();

    for (const category of categories) {
        embed.addFields({ name: category.title, value: category.lines.join('\n') });
    }

    return embed;
}

/**
 * PREFIX HANDLER (Auto-Loading Entry Point)
 */
async function run(message, dbUtils) {
    const args = message.content.trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command !== 'help') return;

    // بدون أي تحقق صلاحية عمداً - أمر عام مفتوح للجميع.
    const settings = await dbUtils.universalGet('setting_guild', message.guild.id);
    const prefix = settings?.prefix_bot || '!';

    const embed = buildHelpEmbed(message.guild, prefix);
    return message.channel.send({ embeds: [embed] });
}

module.exports = {
    name: 'help',
    description: 'Displays every available command, its usage, and required permission',
    buildHelpEmbed,
    run
};