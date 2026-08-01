// =====================================================================
// getroles.js (v1.1 - Fixed Path + Scheduled 12h Sync)
// ---------------------------------------------------------------------
// الفكرة: البوت يزامن هيكل السيرفر (الرتب مرتبة + القنوات مرتبة ومجمّعة
// حسب الأقسام + مين هو المالك) مع قاعدة البيانات، عشان الداشبورد يقرأ
// هذي البيانات مباشرة من Supabase بدون ما يطلب من البوت مباشرة كل مرة.
//
// يشتغل عند:
//   - ready (أول تشغيل للبوت -> يزامن كل السيرفرات)
//   - guildCreate (لما البوت ينضم لسيرفر جديد)
//   - roleCreate / roleUpdate / roleDelete
//   - channelCreate / channelUpdate / channelDelete
//   - guildUpdate (لو تغيّر مالك السيرفر أو اسمه)
//   - [NEW v1.1] Job مجدول كل 12 ساعة - إعادة مزامنة كاملة لكل سيرفر حتى
//     لو ما وصل أي حدث خلال هالمدة (ضمان زمني إضافي فوق الأحداث اللحظية)
//
// [FIX v1.1] المسار الحقيقي لملف الاتصال بقاعدة البيانات تم تصحيحه.
// كان مكتوب '../../supabase/db.js' (يفترض وجود مجلد AutoMod)، لكن حسب
// تعليق FIX موثّق داخل index.js نفسه: "commandhandler.js موجود مباشرة
// داخل src/commands/ وليس داخل مجلد فرعي AutoMod". بما إن getroles.js
// يوضع بنفس المستوى (src/commands/getroles.js، جنب commandhandler.js
// وcustom.js مباشرة)، المسار الصحيح مستوى واحد فوق فقط (../supabase/db.js).
//
// ⚠️ هذا الملف "مو أمر شات حقيقي" — لازم يُستثنى بالاسم من commandhandler.js
//    (نفس طريقة استثناء AutoMod.js / AntiAlt.js / GRS.js / custom.js).
//
// طريقة الاستخدام بـ index.js (استدعاء واحد فقط، قبل client.login()،
// وليس داخل client.once('ready', ...) الخارجية - لأن هذا الملف نفسه يسجّل
// client.once('ready', ...) داخلياً، ولو استُدعي بعد ما حدث ready يكون
// فات فعلاً، لن يُلتقط أبداً):
//    const initRolesSync = require('./commands/getroles');
//    initRolesSync(client);
// =====================================================================

const { ChannelType } = require('discord.js');

// [FIXED] getroles.js موجود مباشرة بـ src/commands/ - مستوى واحد فوق (../)
// يوصل src/ ثم supabase/db.js (بدل المسار القديم الخاطئ ../../supabase/db.js)
const supabase = require('../supabase/db.js');

// ---------------------------------------------------------------------
// أسماء الجداول/الأعمدة (عدّلها إذا مختلفة عندك بالسكيما)
// ---------------------------------------------------------------------
const TABLE_STRUCTURE = 'guild_structure_cache'; // id_guild, roles (jsonb), channels (jsonb), synced_at
const TABLE_SETTING = 'setting_guild';           // ... , owner_id_discord, owner_username

// مدة الـ debounce (بالميلي ثانية) عشان لو صار كذا تغيير سريع ورا بعض
// (مثلاً تعديل جماعي بالرتب) ما نضرب قاعدة البيانات كذا مرة بثانية وحدة
const DEBOUNCE_MS = 2000;

// [NEW v1.1] مدة الـ Job المجدول: يعيد المزامنة الكاملة كل 12 ساعة، حتى
// لو ما وصل أي حدث خلال هالمدة - نفس مبدأ "حد أقصى" المتفق عليه.
const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 ساعة

// [CHANGED] كان فاصل بسيط بين كل سيرفر وثاني (تسلسلي بالكامل). الآن
// نعالج السيرفرات على شكل دفعات متوازية (Promise.allSettled)، والفاصل
// صار بين كل دفعة والتالية بدل كل سيرفر - نفس هدف تقليل rate limit،
// لكن بسرعة إقلاع أعلى بكثير.
const GUILD_STAGGER_MS = 200;

// [NEW] عدد السيرفرات المعالجة بالتوازي بكل دفعة واحدة.
const GUILD_BATCH_SIZE = 5;

// خزّن هنا مؤقتات الـ debounce لكل سيرفر (guildId -> timeoutId)
const debounceTimers = new Map();

// =====================================================================
// بناء بيانات الرتب مرتبة حسب التسلسل الهرمي (الأعلى أولاً)
// =====================================================================
function buildRolesPayload(guild) {
  return guild.roles.cache
    .filter((role) => role.id !== guild.id) // نستثني @everyone
    .sort((a, b) => b.position - a.position) // الأعلى أولاً
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      color: role.hexColor,
      hoisted: role.hoist,
      mentionable: role.mentionable,
      managed: role.managed,
    }));
}

// =====================================================================
// بناء بيانات القنوات مرتبة ومجمّعة حسب الأقسام (Categories)
// =====================================================================
function buildChannelsPayload(guild) {
  // كل الأقسام مرتبة حسب الموقع
  const categories = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  const groups = [];

  categories.forEach((category) => {
    const children = guild.channels.cache
      .filter((c) => c.parentId === category.id)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        position: c.position,
      }));

    groups.push({
      categoryId: category.id,
      categoryName: category.name,
      categoryPosition: category.position,
      channels: children,
    });
  });

  // القنوات اللي ما تتبع لأي قسم (بدون تصنيف)
  const uncategorized = guild.channels.cache
    .filter(
      (c) =>
        c.type !== ChannelType.GuildCategory &&
        !c.parentId
    )
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      position: c.position,
    }));

  if (uncategorized.length > 0) {
    groups.push({
      categoryId: null,
      categoryName: 'Uncategorized',
      categoryPosition: -1,
      channels: uncategorized,
    });
  }

  return groups;
}

// =====================================================================
// مزامنة كاملة لسيرفر واحد: رتب + قنوات + مالك
// =====================================================================
async function syncGuildStructure(guild) {
  try {
    const rolesPayload = buildRolesPayload(guild);
    const channelsPayload = buildChannelsPayload(guild);

    // --- تحديث/إدخال جدول الكاش (guild_structure_cache) ---
    const { error: structureError } = await supabase
      .from(TABLE_STRUCTURE)
      .upsert(
        {
          id_guild: guild.id,
          roles: rolesPayload,
          channels: channelsPayload,
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'id_guild' } // لازم UNIQUE constraint على id_guild
      );

    if (structureError) {
      console.error(
       `[getroles] Failed to update guild_structure_cache for server ${guild.id}:`,
        structureError.message
      );
    }

    // --- تحديث بيانات المالك بجدول setting_guild ---
    let ownerUsername = null;
    try {
      const ownerMember = await guild.fetchOwner();
      ownerUsername = ownerMember.user.tag; // مثال: Name#0001 أو username الجديد
    } catch (ownerErr) {
      console.warn(
       `[getroles] Could not fetch owner for server ${guild.id}:`,
        ownerErr.message
      );
    }

    // نستخدم update بدل upsert عشان ما نصفّر بقية أعمدة setting_guild
    // (لازم يكون فيه صف موجود مسبقاً بـ setting_guild لهذا id_guild)
    const { data: updatedRows, error: settingError } = await supabase
      .from(TABLE_SETTING)
      .update({
        owner_id_discord: guild.ownerId,
        owner_username: ownerUsername,
      })
      .eq('id_guild', guild.id)
      .select('id_guild');

    if (settingError) {
      console.error(
       `[getroles] Failed to update owner data in setting_guild for server ${guild.id}:`,
        settingError.message
      );
    } else if (!updatedRows || updatedRows.length === 0) {
      // ما فيه صف موجود لهذا السيرفر بعد -> ننشئ صف جديد بالحد الأدنى
      const { error: insertError } = await supabase.from(TABLE_SETTING).insert({
        id_guild: guild.id,
        owner_id_discord: guild.ownerId,
        owner_username: ownerUsername,
      });
if (insertError) {
        console.error(
          `[getroles] Failed to create new row in setting_guild for server ${guild.id}:`,
          insertError.message
        );
      }
    }

    console.log(
      `[getroles] Synced structure for server "${guild.name}" (${guild.id}) — ${rolesPayload.length} roles, ${channelsPayload.reduce((sum, g) => sum + g.channels.length, 0)} channels.`
    );
  } catch (err) {
    console.error(`[getroles] Unexpected error during sync for server ${guild.id}:`, err);
  }
}

// =====================================================================
// نسخة مؤجّلة (debounced) من المزامنة — عشان الأحداث المتتالية السريعة
// =====================================================================
function scheduleSyncGuildStructure(guild) {
  const existingTimer = debounceTimers.get(guild.id);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    debounceTimers.delete(guild.id);
    syncGuildStructure(guild);
  }, DEBOUNCE_MS);

  debounceTimers.set(guild.id, timer);
}

// =====================================================================
// [NEW v1.1] مزامنة دورية كاملة لكل السيرفرات - تُستدعى أول مرة عند ready
// وبعدها كل SYNC_INTERVAL_MS (12 ساعة). منفصلة كدالة مستقلة عشان تقدر
// تستدعيها يدوياً لاحقاً لو حبيت تضيف زر "Sync Now" بالداشبورد.
// =====================================================================
async function syncAllGuilds(client, { label = 'دورية' } = {}) {
  const guilds = Array.from(client.guilds.cache.values());
  console.log(`[getroles] Starting ${label} sync for ${guilds.length} servers (batches of ${GUILD_BATCH_SIZE})...`);

  for (let i = 0; i < guilds.length; i += GUILD_BATCH_SIZE) {
    const batch = guilds.slice(i, i + GUILD_BATCH_SIZE);

    // كل سيرفرات الدفعة الواحدة تتزامن بالتوازي - allSettled يضمن إن فشل
    // سيرفر واحد (مثلاً خطأ شبكة مؤقت) ما يوقف بقية الدفعة أو الدفعات الجاية.
    await Promise.allSettled(
      batch.map((guild) =>
        syncGuildStructure(guild).catch((err) => {
          console.error(`[getroles] Failed to sync server ${guild.id} during ${label} sync:`, err);
        })
      )
    );

    // فاصل بين كل دفعة والتالية (مو بين كل سيرفر وثاني كما كان سابقاً)
    if (i + GUILD_BATCH_SIZE < guilds.length) {
      await new Promise((resolve) => setTimeout(resolve, GUILD_STAGGER_MS));
    }
  }

  console.log(`[getroles] ${label} sync completed for all servers.`);
}

// =====================================================================
// التصدير الرئيسي: ربط الأحداث بالـ client
// =====================================================================
module.exports = (client) => {
  // عند تشغيل البوت -> نزامن كل السيرفرات اللي البوت فيها، وبعدها نبدأ
  // الـ Job المجدول (كل 12 ساعة)
  client.once('ready', async () => {
    await syncAllGuilds(client, { label: 'Periodic' });

    // [NEW v1.1] Job مجدول: يعيد مزامنة كل سيرفر كل 12 ساعة كحد أقصى،
    // حتى لو ما وصل أي حدث (roleCreate/channelUpdate/...) خلال هالمدة -
    // ضمان زمني إضافي فوق الأحداث اللحظية، بدون أي تعديل على قاعدة
    // البيانات (لا عمود جديد ولا جدول جديد).
    setInterval(() => {
     syncAllGuilds(client, { label: 'Periodic (12h)' });
    }, SYNC_INTERVAL_MS);

    console.log('[getroles] Scheduled Sync: STARTED (every 12h)');
  });

  // انضمام البوت لسيرفر جديد -> مزامنة فورية
  client.on('guildCreate', (guild) => {
    syncGuildStructure(guild);
  });

  // ---------------- أحداث الرتب ----------------
  client.on('roleCreate', (role) => scheduleSyncGuildStructure(role.guild));
  client.on('roleUpdate', (oldRole, newRole) => scheduleSyncGuildStructure(newRole.guild));
  client.on('roleDelete', (role) => scheduleSyncGuildStructure(role.guild));

  // ---------------- أحداث القنوات ----------------
  client.on('channelCreate', (channel) => {
    if (channel.guild) scheduleSyncGuildStructure(channel.guild);
  });
  client.on('channelUpdate', (oldChannel, newChannel) => {
    if (newChannel.guild) scheduleSyncGuildStructure(newChannel.guild);
  });
  client.on('channelDelete', (channel) => {
    if (channel.guild) scheduleSyncGuildStructure(channel.guild);
  });

  // ---------------- تغيّر بيانات السيرفر (زي المالك) ----------------
  client.on('guildUpdate', (oldGuild, newGuild) => {
    // نزامن دايماً لو تغيّر المالك، أو حتى لو تغيّر أي شي ثاني بالسيرفر
    // (تكلفة المزامنة بسيطة والـ debounce يمنع التكرار الزائد)
    scheduleSyncGuildStructure(newGuild);
  });

  console.log(
    '[getroles] تم تفعيل مستمعي الأحداث (ready / guildCreate / roles / channels / guildUpdate).'
  );
};

// نصدّر الدوال الداخلية أيضاً لو احتجتها بمكان ثاني (مثلاً أمر يدوي "/syncroles")
module.exports.syncGuildStructure = syncGuildStructure;
module.exports.syncAllGuilds = syncAllGuilds;
module.exports.buildRolesPayload = buildRolesPayload;
module.exports.buildChannelsPayload = buildChannelsPayload;