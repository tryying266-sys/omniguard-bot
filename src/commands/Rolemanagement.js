// =====================================================================
// RoleManagement.js
// ---------------------------------------------------------------------
// المسؤوليات:
//   1) عند انضمام عضو جديد -> نعطيه الرتب المحددة بـ new_user_auto_roles
//      (من جدول setting_management_role).
//   2) أي رتبة من هذي معرّف لها مدة إزالة بجدول role_delay_config ->
//      نجدول إزالتها تلقائياً بعد المدة المحددة (1s, 30m, 2h, 1d...).
//   3) سكجولر (setInterval) يفحص جدول role_removal_schedule كل فترة
//      ويشيل أي رتبة وصل وقتها، حتى لو البوت كان متوقف وقت انتهاء المدة
//      (catch-up عند تشغيل البوت من جديد).
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

const TABLE_ROLE_SETTINGS = 'setting_management_role'; // new_user_auto_roles TEXT[]
const TABLE_DELAY_CONFIG = 'role_delay_config';        // id_guild, id_role, delay_duration
const TABLE_REMOVAL_SCHEDULE = 'role_removal_schedule'; // id_guild, id_user, id_role, ends_at, processed

// كل كم ثانية يفحص السكجولر جدول الإزالة المؤجلة
const SCHEDULER_INTERVAL_MS = 30 * 1000; // 30 ثانية

// =====================================================================
// تحويل نص مدة زمني (زي '30s', '10m', '2h', '1d') إلى ميلي ثانية
// نفس النمط المستخدم بباقي المشروع (spam_action_duration, warn_trigger_duration)
// =====================================================================
function parseDurationToMs(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return null;

  const match = durationStr.trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  const unitToMs = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return value * unitToMs[unit];
}

// =====================================================================
// جلب إعدادات الرتب التلقائية لسيرفر معيّن
// =====================================================================
async function getAutoRoleSettings(guildId) {
  const { data, error } = await supabase
    .from(TABLE_ROLE_SETTINGS)
    .select('new_user_auto_roles')
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
// جلب مدد الإزالة المعرّفة لمجموعة رتب معينة بسيرفر معيّن
// يرجع Map: roleId -> delay_duration (نص)
// =====================================================================
async function getDelayConfigForRoles(guildId, roleIds) {
  if (!roleIds || roleIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from(TABLE_DELAY_CONFIG)
    .select('id_role, delay_duration')
    .eq('id_guild', guildId)
    .in('id_role', roleIds);

  if (error) {
    console.error(
      `[RoleManagement] فشل جلب role_delay_config للسيرفر ${guildId}:`,
      error.message
    );
    return new Map();
  }

  const map = new Map();
  for (const row of data || []) {
    map.set(row.id_role, row.delay_duration);
  }
  return map;
}

// =====================================================================
// إعطاء الرتب التلقائية للعضو الجديد + جدولة إزالة أي رتبة منها لها مدة
// =====================================================================
async function assignAutoRoles(member) {
  const guild = member.guild;

  const settings = await getAutoRoleSettings(guild.id);
  const configuredRoleIds = settings?.new_user_auto_roles || [];

  if (configuredRoleIds.length === 0) return;

  const botMember = guild.members.me;
  if (!botMember?.permissions.has('ManageRoles')) {
    console.warn(
      `[RoleManagement] Failed to assign auto-role: Bot is missing the 'Manage Roles' permission in server ${guild.name}, Skipped assigning auto-roles`
    );
    return;
  }

  const botHighestPosition = botMember.roles.highest.position;

  // نفلتر: الرتبة لازم تكون موجودة فعلياً وأقل من أعلى رتبة عند البوت
  const validRoleIds = configuredRoleIds.filter((roleId) => {
    const role = guild.roles.cache.get(roleId);
    return role && role.position < botHighestPosition;
  });

  if (validRoleIds.length === 0) return;

  try {
    await member.roles.add(validRoleIds, 'RoleManagement: Auto-roles for new member');
    console.log(
      `[RoleManagement] Assigned ${validRoleIds.length} auto-role(s) to member ${member.user?.tag || member.id} (${guild.name})`
    );
  } catch (err) {
    console.error(
      `[RoleManagement] Failed to assign auto-roles to member ${member.id} in server ${guild.id}:`,
  err.message
);
return;
}

  // نجدول إزالة أي رتبة منها معرّف لها مدة إزالة
  const delayMap = await getDelayConfigForRoles(guild.id, validRoleIds);
  if (delayMap.size === 0) return;

  const rowsToInsert = [];
  for (const [roleId, durationStr] of delayMap.entries()) {
    const ms = parseDurationToMs(durationStr);
    if (!ms) {
      console.warn(
       `[RoleManagement] Invalid duration format "${durationStr}" for role ${roleId} in server ${guild.id}, skipping.`,
);
continue;
}

    rowsToInsert.push({
      id_guild: guild.id,
      id_user: member.id,
      id_role: roleId,
      ends_at: new Date(Date.now() + ms).toISOString(),
      processed: false,
    });
  }

  if (rowsToInsert.length === 0) return;

  const { error: insertError } = await supabase
    .from(TABLE_REMOVAL_SCHEDULE)
    .insert(rowsToInsert);

  if (insertError) {
    console.error(
     `[RoleManagement] Failed to schedule temporary role removal for member ${member.id}:`,
  insertError.message
);
  } else {
    console.log(
      `[RoleManagement] تم جدولة إزالة ${rowsToInsert.length} رتبة مؤقتة للعضو ${member.user?.tag || member.id}.`
    );
  }
}

// =====================================================================
// السكجولر: يفحص الرتب اللي وصل وقت إزالتها ويشيلها فعلياً
// =====================================================================
async function processDueRoleRemovals(client) {
  try {
    const now = new Date().toISOString();

    const { data: dueRows, error } = await supabase
      .from(TABLE_REMOVAL_SCHEDULE)
      .select('*')
      .eq('processed', false)
      .lte('ends_at', now)
      .limit(100); // نعالج بدفعات عشان ما نحمّل الذاكرة لو تراكمت صفوف كثيرة

   if (error) {
  console.error('[RoleManagement] Failed to fetch due removal schedule:', error.message);
  return;
}

    if (!dueRows || dueRows.length === 0) return;

    for (const row of dueRows) {
      await handleSingleRoleRemoval(client, row);
    }
  } catch (err) {
  console.error('[RoleManagement] Unexpected error in scheduler:', err);
}
}

async function handleSingleRoleRemoval(client, row) {
  try {
    const guild = client.guilds.cache.get(row.id_guild);

    // السيرفر ما عاد البوت فيه -> نعلّم الصف كمُعالَج ونطلع
    if (!guild) {
      await markRowProcessed(row.id);
      return;
    }

    let member;
    try {
      member = await guild.members.fetch(row.id_user);
    } catch {
      // العضو طلع من السيرفر قبل ما توصل مدة الإزالة -> ما فيه داعي نكمل
      await markRowProcessed(row.id);
      return;
    }

    const botMember = guild.members.me;
    const role = guild.roles.cache.get(row.id_role);

    if (
      role &&
      member.roles.cache.has(role.id) &&
      botMember?.permissions.has('ManageRoles') &&
      role.position < botMember.roles.highest.position
    ) {
      await member.roles.remove(role.id, 'RoleManagement: Temporary role expired');
      console.log(
       `[RoleManagement] Removed role "${role.name}" from ${member.user?.tag || member.id} (${guild.name}) after duration expired.`
);
}

    await markRowProcessed(row.id);
  } catch (err) {
   console.error(`[RoleManagement] Failed to execute removal for row ${row.id}:`, err.message);
    // Keep processed=false so it retries in the next cycle instead of getting lost
  }
}

async function markRowProcessed(rowId) {
  const { error } = await supabase
    .from(TABLE_REMOVAL_SCHEDULE)
    .update({ processed: true })
    .eq('id', rowId);

  if (error) {
    console.error(`[RoleManagement] Failed to update processed status for row ${rowId}:`, error.message);
  }
}

// =====================================================================
// التصدير الرئيسي: ربط الأحداث بالـ client + تشغيل السكجولر
// =====================================================================
module.exports = (client) => {
  // عضو جديد -> إعطاء الرتب التلقائية (+ جدولة الإزالة لو فيه مدة)
  client.on('guildMemberAdd', async (member) => {
    try {
      await assignAutoRoles(member);
    } catch (err) {
     console.error('[RoleManagement] Error in guildMemberAdd handler:', err);
    }
  });

  // فحص فوري عند تشغيل البوت (catch-up لأي رتب فاتها وقتها وقت التوقف)
  client.once('ready', () => {
    processDueRoleRemovals(client);

    // ثم فحص دوري كل SCHEDULER_INTERVAL_MS
    setInterval(() => processDueRoleRemovals(client), SCHEDULER_INTERVAL_MS);

    console.log(
     `[RoleManagement] Temporary role removal scheduler started (every ${SCHEDULER_INTERVAL_MS / 1000} seconds).`
    );
  });

 console.log('[RoleManagement] Event listeners initialized (guildMemberAdd).');
};

// تصدير الدوال الداخلية لو احتجتها بمكان ثاني (مثلاً أمر يدوي أو API)
module.exports.assignAutoRoles = assignAutoRoles;
module.exports.processDueRoleRemovals = processDueRoleRemovals;
module.exports.parseDurationToMs = parseDurationToMs;