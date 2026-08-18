// =====================================================================
// RoleManagement.js  (v7.0 - Role Delay نظام أُلغي بالكامل)
// ---------------------------------------------------------------------
// المسؤوليات:
//   1) عند انضمام عضو جديد (بشري) -> يعطيه new_user_auto_roles، بس لو
//      enable_new_user_auto_roles = true.
//   2) عند انضمام بوت جديد -> يعطيه new_bot_auto_roles، بس لو
//      enable_new_bot_auto_roles = true. (مستقل تماماً عن الفلاق أعلاه).
//   3) معالجة ضغطات أزرار Reaction/Button Roles (interactionCreate):
//      كل زر custom_id بصيغة "rr_toggle_<roleId>" -> toggle الرتبة على
//      العضو الضاغط (يعطيها لو ما عنده، يشيلها لو عنده).
//
// [v7.0 CHANGES]
//   - حُذف بالكامل: role_delay_config, role_removal_schedule, السكجولر
//     (setInterval)، parseDurationToMs، وكل منطق "مدة الإزالة" - قرار
//     صريح من المطور بإلغاء الميزة نهائياً (مو تعطيل، حذف).
//   - جديد: التفريق بين عضو بشري/بوت (member.user.bot) بدل معاملتهم
//     كمجموعة واحدة، مع عمودي تفعيل مستقلين لكل نوع.
//   - جديد: معالج ضغطات أزرار Reaction Roles (لم يكن موجوداً إطلاقاً
//     بالنسخة السابقة).
//
// ⚠️ هذا الملف "مو أمر شات حقيقي" — لازم يُستثنى بالاسم من commandhandler.js
//    (نفس طريقة استثناء AutoMod.js)
//
// طريقة الاستخدام (تسويها انت بـ index.js):
//    require('./commands/Rolemanagement.js')(client);
//
// ملاحظة عن دخول الداشبورد (dashboard_access_roles):
//    هذا العمود يُستخدم من طرف الموقع/الـ auth middleware مباشرة عشان
//    يتحقق مين يقدر يدخل لوحة التحكم — البوت نفسه ما يحتاج يتعامل معه،
//    فما ذكرته هنا بالكود.
// =====================================================================

const supabase = require('../supabase/db.js');
const { extractRoleIdFromCustomId } = require('../events/reactionRolePanel.js');

const TABLE_ROLE_SETTINGS = 'setting_management_role';
// new_user_auto_roles TEXT[], new_bot_auto_roles TEXT[],
// enable_new_user_auto_roles BOOLEAN, enable_new_bot_auto_roles BOOLEAN

// =====================================================================
// جلب إعدادات الرتب التلقائية لسيرفر معيّن (الفلاقين + مصفوفتي الرتب)
// =====================================================================
async function getAutoRoleSettings(guildId) {
  const { data, error } = await supabase
    .from(TABLE_ROLE_SETTINGS)
    .select('new_user_auto_roles, new_bot_auto_roles, enable_new_user_auto_roles, enable_new_bot_auto_roles')
    .eq('id_guild', guildId)
    .single();

  if (error) {
    console.error(
      `[RoleManagement] Failed to fetch auto-role settings for server ${guildId}:`,
      error.message
    );
    return null;
  }

  return data;
}

// =====================================================================
// إعطاء مجموعة رتب لعضو (بعد فلترة: موجودة فعلياً + أقل من أعلى رتبة
// عند البوت). مشتركة بين مسار العضو البشري والبوت.
// =====================================================================
async function assignRoleList(member, roleIds, contextLabel) {
  if (!roleIds || roleIds.length === 0) return;

  const guild = member.guild;
  const botMember = guild.members.me;

  if (!botMember?.permissions.has('ManageRoles')) {
    console.warn(
      `[RoleManagement] Failed to assign ${contextLabel}: Bot is missing the 'Manage Roles' permission in server ${guild.name}, Skipped.`
    );
    return;
  }

  const botHighestPosition = botMember.roles.highest.position;

  const validRoleIds = roleIds.filter((roleId) => {
    const role = guild.roles.cache.get(roleId);
    return role && role.position < botHighestPosition;
  });

  if (validRoleIds.length === 0) return;

  try {
    await member.roles.add(validRoleIds, `RoleManagement: ${contextLabel}`);
    console.log(
      `[RoleManagement] Assigned ${validRoleIds.length} ${contextLabel} to ${member.user?.tag || member.id} (${guild.name})`
    );
  } catch (err) {
    console.error(
      `[RoleManagement] Failed to assign ${contextLabel} to ${member.id} in server ${guild.id}:`,
      err.message
    );
  }
}

// =====================================================================
// عضو جديد ينضم (بشري أو بوت) -> يعطيه الرتب المناسبة حسب نوعه، بس لو
// التفعيل المقابل شغال.
// =====================================================================
async function assignAutoRoles(member) {
  const settings = await getAutoRoleSettings(member.guild.id);
  if (!settings) return;

  const isBot = !!member.user?.bot;

  if (isBot) {
    if (!settings.enable_new_bot_auto_roles) return;
    await assignRoleList(member, settings.new_bot_auto_roles || [], 'auto-role(s) for new bot');
  } else {
    if (!settings.enable_new_user_auto_roles) return;
    await assignRoleList(member, settings.new_user_auto_roles || [], 'auto-role(s) for new member');
  }
}

// =====================================================================
// Reaction / Button Roles: معالجة ضغطة زر - toggle الرتبة على العضو.
// =====================================================================
async function handleReactionRoleButton(interaction) {
  const roleId = extractRoleIdFromCustomId(interaction.customId);
  if (!roleId) return; // مو زر Reaction Role - نخرج بصمت، أزرار ثانية بالمشروع تتعامل مع باقي الـ custom_id

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This button only works inside a server.', ephemeral: true }).catch(() => {});
    return;
  }

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    await interaction.reply({ content: 'This role no longer exists. Please contact a server admin.', ephemeral: true }).catch(() => {});
    return;
  }

  const botMember = guild.members.me;
  if (
    !botMember?.permissions.has('ManageRoles') ||
    role.position >= botMember.roles.highest.position
  ) {
    await interaction.reply({ content: 'I cannot manage this role (missing permission or role hierarchy issue). Please contact a server admin.', ephemeral: true }).catch(() => {});
    return;
  }

  const member = interaction.member;

  try {
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, 'RoleManagement: Reaction/Button role toggle');
      await interaction.reply({ content: `Removed the **${role.name}** role.`, ephemeral: true });
    } else {
      await member.roles.add(roleId, 'RoleManagement: Reaction/Button role toggle');
      await interaction.reply({ content: `Assigned the **${role.name}** role.`, ephemeral: true });
    }
  } catch (err) {
    console.error(
      `[RoleManagement] Failed to toggle reaction-role ${roleId} for ${member.id} in server ${guild.id}:`,
      err.message
    );
    await interaction.reply({ content: 'Something went wrong while updating your role. Please try again later.', ephemeral: true }).catch(() => {});
  }
}

// =====================================================================
// التصدير الرئيسي: ربط الأحداث بالـ client
// =====================================================================
module.exports = (client) => {
  // عضو جديد (بشري أو بوت) -> إعطاء الرتب التلقائية المناسبة
  client.on('guildMemberAdd', async (member) => {
    try {
      await assignAutoRoles(member);
    } catch (err) {
      console.error('[RoleManagement] Error in guildMemberAdd handler:', err);
    }
  });

  // ضغطات أزرار Reaction/Button Roles
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith('rr_toggle_')) return;

    try {
      await handleReactionRoleButton(interaction);
    } catch (err) {
      console.error('[RoleManagement] Error in interactionCreate handler:', err);
    }
  });

  console.log('[RoleManagement] Event listeners initialized (guildMemberAdd, interactionCreate).');
};

// تصدير الدوال الداخلية لو احتجتها بمكان ثاني (مثلاً أمر يدوي أو API)
module.exports.assignAutoRoles = assignAutoRoles;
module.exports.handleReactionRoleButton = handleReactionRoleButton;