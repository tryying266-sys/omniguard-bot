// =====================================================================
// welcome.js
// ---------------------------------------------------------------------
// الفكرة:
//   - عضو ينضم للسيرفر  -> لو enabled_welcome مفعّل: نرسل رسالة ترحيب
//     بالروم المحددة (channel_welcome)، مع أو بدون منشن حسب member_ping،
//     وبالنوع المحدد (نص/embed/كرت صورة/الاثنين). ولو send_welcome_dm
//     مفعّل نرسل له كمان رسالة خاصة.
//   - عضو يطلع من السيرفر -> لو enabled_leave مفعّل: نرسل رسالة مغادرة
//     نصية بسيطة بالروم المحددة (channel_leave).
//
// ⚠️ هذا الملف "مو أمر شات حقيقي" — لازم يُستثنى بالاسم من commandhandler.js
//    (نفس طريقة استثناء AutoMod.js)
//
// طريقة الاستخدام (تسويها انت بـ index.js):
//    require('./commands/welcome.js')(client);
//
// المتغيرات المدعومة داخل نصوص الرسائل (custom_welcome_text /
// text_dm_welcome / text_msg_leave):
//   {user}        -> منشن العضو لو member_ping مفعّل، وإلا اسمه فقط
//   {mention}     -> منشن صريح دايماً <@id>
//   {username}    -> اسم المستخدم (بدون منشن)
//   {tag}         -> اسم المستخدم الكامل (Tag)
//   {server}      -> اسم السيرفر
//   {membercount} -> عدد أعضاء السيرفر الحالي
// =====================================================================

const {
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');

const supabase = require('../supabase/db.js');

const TABLE_SETTING = 'setting_leave_welcome';

// =====================================================================
// جلب إعدادات الترحيب/المغادرة لسيرفر معيّن
// =====================================================================
async function getWelcomeSettings(guildId) {
  const { data, error } = await supabase
    .from(TABLE_SETTING)
    .select('*')
    .eq('id_guild', guildId)
    .single();

 if (error) {
    console.error(`[welcome] Failed to fetch welcome settings for server ${guildId}:`, error.message);
    return null;
  }
  return data;
}

// =====================================================================
// استبدال المتغيرات داخل نص الرسالة
// =====================================================================
function replacePlaceholders(template, member, { forceMention = false } = {}) {
  const guild = member.guild;
  const username = member.user?.username || 'Unknown';
  const tag = member.user?.tag || username;
  const mention = `<@${member.id}>`;

  return String(template || '')
    .replaceAll('{user}', forceMention ? mention : username)
    .replaceAll('{mention}', mention)
    .replaceAll('{username}', username)
    .replaceAll('{tag}', tag)
    .replaceAll('{server}', guild.name)
    .replaceAll('{membercount}', String(guild.memberCount));
}

// =====================================================================
// التحقق من صلاحيات البوت بالروم قبل الإرسال
// =====================================================================
function canSendInChannel(channel, botMember) {
  if (!channel || channel.type === ChannelType.GuildCategory) return false;
  const perms = channel.permissionsFor(botMember);
  if (!perms) return false;
  return (
    perms.has(PermissionsBitField.Flags.ViewChannel) &&
    perms.has(PermissionsBitField.Flags.SendMessages)
  );
}

// =====================================================================
// بناء كرت ترحيب مصوّر (Canvas) — يرجع Buffer أو null لو فشل/غير متوفر
// =====================================================================
let canvasWarningShown = false;

async function buildWelcomeCardImage(member, settings) {
  let canvasLib;
  try {
    // lazy require عشان لو الباكج مو مثبت ما يوقف تشغيل البوت كامل
    canvasLib = require('@napi-rs/canvas');
  } catch (err) {
    if (!canvasWarningShown) {
      console.warn(
        '[welcome] Package @napi-rs/canvas is not installed. Run: npm install @napi-rs/canvas — ' +
          'Falling back to "text" mode instead of image card.'
      );
      canvasWarningShown = true;
    }
    return null;
  }

  try {
    const { createCanvas, loadImage } = canvasLib;
    const width = 900;
    const height = 300;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const bgColor = settings.color_bg_card || '#111115';
    const accentColor = settings.card_accent_color || '#ff3344';
    const rounded = settings.card_border_radius === 'rounded';

    // مسار بحواف دائرية (اختياري) عشان نقص الكرت كامل
    function roundedRectPath(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    if (rounded) {
      roundedRectPath(ctx, 0, 0, width, height, 24);
      ctx.clip();
    }

    // الخلفية
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    // شريط اللون المميز أسفل الكرت
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, height - 10, width, 10);

    // صورة العضو (أفاتار) بشكل دائري
    const avatarSize = 180;
    const avatarX = 60;
    const avatarY = (height - avatarSize) / 2 - 5;

    try {
      const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
      const avatarImage = await loadImage(avatarUrl);

      ctx.save();
      ctx.beginPath();
      ctx.arc(
        avatarX + avatarSize / 2,
        avatarY + avatarSize / 2,
        avatarSize / 2,
        0,
        Math.PI * 2
      );
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatarImage, avatarX, avatarY, avatarSize, avatarSize);
      ctx.restore();

      // حلقة بلون accent حول الأفاتار
      ctx.beginPath();
      ctx.arc(
        avatarX + avatarSize / 2,
        avatarY + avatarSize / 2,
        avatarSize / 2 + 4,
        0,
        Math.PI * 2
      );
      ctx.lineWidth = 6;
      ctx.strokeStyle = accentColor;
      ctx.stroke();
    } catch (avatarErr) {
     console.warn('[welcome] Failed to load avatar image for card:', avatarErr.message);
    }
    // النصوص
   const textX = avatarX + avatarSize + 40;

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText('Welcome!', textX, 110);

    ctx.fillStyle = accentColor;
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(member.user.username, textX, 165);

    ctx.fillStyle = '#cfcfcf';
    ctx.font = '24px sans-serif';
    ctx.fillText(
      `Member #${member.guild.memberCount} in ${member.guild.name}`,
      textX,
      210
    );

    return canvas.toBuffer('image/png');
  } catch (err) {
    console.error('[welcome] Failed to generate welcome image card:', err);
    return null;
  }
}

// =====================================================================
// إرسال رسالة الترحيب بالروم + رسالة الخاص (لو مفعّلة)
// =====================================================================
async function sendWelcomeMessage(member) {
  const guild = member.guild;
  const settings = await getWelcomeSettings(guild.id);
  if (!settings || !settings.enabled_welcome) return;

  // [FIX] Race Condition: guildMemberAdd مسجّل بأكثر من مكان (AntiAlt/AutoRole
  // بـ server.js، وهذا الملف) وتشتغل بالتوازي بدون ترتيب مضمون بينها. لو
  // AntiAlt.js طرد/حظر العضو للتو (Alt مشبوه)، لازم نتأكد إنه لسا موجود
  // فعلياً بالسيرفر قبل ما نرسل له ترحيب بالروم أو رسالة خاصة - نفس فحص
  // "stillInGuild" الموجود أصلاً بـ server.js لنفس السبب بالضبط.
  const stillInGuild = await guild.members.fetch(member.id).catch(() => null);
  if (!stillInGuild) return;

  const botMember = guild.members.me;
  const channel = settings.channel_welcome
    ? guild.channels.cache.get(settings.channel_welcome)
    : null;

 if (!channel) {
    console.warn(`[welcome] Welcome channel not found/unspecified for server ${guild.id}.`);
  } else if (!canSendInChannel(channel, botMember)) {
    console.warn(
      `[welcome] Bot lacks permission to send welcome messages in channel ${channel.id} (server ${guild.id}).`
    );
  } else {
    const rawTemplate = settings.custom_welcome_text || 'أهلاً بك {user} في {server}! 🎉';
    const hasMentionToken = /\{user\}|\{mention\}/.test(rawTemplate);
    const text = replacePlaceholders(rawTemplate, member, {
      forceMention: settings.member_ping === true,
    });

    // منشن إضافي مضمون لو مفعّل ومافي توكن منشن أصلاً بالنص (يضمن التنبيه الفعلي)
    const mentionPrefix =
      settings.member_ping && !hasMentionToken ? `<@${member.id}> ` : '';

    const msgType = settings.welcome_msg_type || 'text';
    const payload = { content: undefined, embeds: [], files: [] };

    let imageBuffer = null;
    if (msgType === 'image' || msgType === 'both') {
      imageBuffer = await buildWelcomeCardImage(member, settings);
    }

    if (msgType === 'text' || (!imageBuffer && msgType === 'image')) {
      // لو طلب "image" لكن فشل التوليد، نرجع لنص عادي بدل ما نفشل الإرسال كامل
      payload.content = `${mentionPrefix}${text}`;
    } else if (msgType === 'embed') {
      payload.content = mentionPrefix || undefined;
      payload.embeds = [
        new EmbedBuilder()
          .setDescription(text)
          .setColor(settings.card_accent_color || '#ff3344')
          .setTimestamp(new Date()),
      ];
    } else if (msgType === 'image' || msgType === 'both') {
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'welcome-card.png' });
      payload.content = mentionPrefix || undefined;
      payload.files = [attachment];

      if (msgType === 'both') {
        payload.embeds = [
          new EmbedBuilder()
            .setDescription(text)
            .setColor(settings.card_accent_color || '#ff3344')
            .setImage('attachment://welcome-card.png')
            .setTimestamp(new Date()),
        ];
      }
    }

    try {
      await channel.send(payload);
    } catch (sendErr) {
     console.error(`[welcome] Failed to send welcome message in server ${guild.id}:`, sendErr.message);
    }
  }

  // Optional DM message
  if (settings.send_welcome_dm && settings.text_dm_welcome) {
    try {
      const dmText = replacePlaceholders(settings.text_dm_welcome, member, {
        forceMention: false, // In DMs, mentions are unnecessary
      });
      await member.send(dmText);
    } catch (dmErr) {
      // Usually caused by: member has DMs closed for server members (normal and expected)
      console.warn(
        `[welcome] Could not send direct message to member ${member.id} (server ${guild.id}): ${dmErr.message}`
      );
    }
  }
}

// =====================================================================
// إرسال رسالة المغادرة بالروم
// =====================================================================
async function sendLeaveMessage(member) {
  const guild = member.guild;
  const settings = await getWelcomeSettings(guild.id);
  if (!settings || !settings.enabled_leave) return;

  const botMember = guild.members.me;
  const channel = settings.channel_leave
    ? guild.channels.cache.get(settings.channel_leave)
    : null;

 if (!channel) {
    console.warn(`[welcome] Leave channel not found/unspecified for server ${guild.id}.`);
    return;
  }

  if (!canSendInChannel(channel, botMember)) {
    console.warn(
     `[welcome] Bot lacks permission to send leave messages in channel ${channel.id} (server ${guild.id}).`
    );
    return;
  }

  const rawTemplate = settings.text_msg_leave || '{username} left the server. 👋';
  // During leave, we never do an actual mention (the member already left) -
  // Mention Departing Member feature has been fully removed per request.
  const text = replacePlaceholders(rawTemplate, member, { forceMention: false });

  try {
    await channel.send({ content: text });
  } catch (sendErr) {
    console.error(`[welcome] Failed to send leave message in server ${guild.id}:`, sendErr.message);
  }

  // [NEW] Optional DM message on leave (mirrors sendWelcomeMessage's DM
  // block below). Sent via member.send() which routes through the cached
  // User object - still works even though the member has already left the
  // guild, as long as Discord allows the bot to DM them (independent of
  // shared-guild status at send time since we already had the member
  // object cached from the guildMemberRemove event itself).
  if (settings.send_leave_dm && settings.text_dm_leave) {
    try {
      const dmText = replacePlaceholders(settings.text_dm_leave, member, {
        forceMention: false, // In DMs, mentions are unnecessary
      });
      await member.send(dmText);
    } catch (dmErr) {
      // Usually caused by: member has DMs closed for server members, or
      // left too long ago for Discord to still resolve the shared context
      // (normal and expected in either case).
      console.warn(
        `[welcome] Could not send leave direct message to member ${member.id} (server ${guild.id}): ${dmErr.message}`
      );
    }
  }
}
// =====================================================================
// التصدير الرئيسي: ربط الأحداث بالـ client
// =====================================================================
module.exports = (client) => {
  client.on('guildMemberAdd', async (member) => {
    try {
      await sendWelcomeMessage(member);
    } catch (err) {
     console.error('[welcome] Error in guildMemberAdd handler:', err);
    }
  });
  client.on('guildMemberRemove', async (member) => {
    try {
      // العضو قد يكون partial (بيانات ناقصة) لو ما كان بالكاش
      if (member.partial) {
        try {
          await member.fetch();
        } catch {
          // نكمل حتى لو فشل fetch — بنعتمد على البيانات المتوفرة بس
        }
      }
      await sendLeaveMessage(member);
    } catch (err) {
     console.error('[welcome] Error in guildMemberRemove handler:', err);
    }
  });

  console.log('[welcome] Event listeners enabled (guildMemberAdd / guildMemberRemove).');
};

// تصدير الدوال الداخلية لو احتجتها بمكان ثاني (مثلاً أمر "/testwelcome")
module.exports.sendWelcomeMessage = sendWelcomeMessage;
module.exports.sendLeaveMessage = sendLeaveMessage;
module.exports.getWelcomeSettings = getWelcomeSettings;