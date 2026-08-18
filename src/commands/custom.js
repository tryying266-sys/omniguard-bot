// ============================================================================
// custom.js - Dashboard Custom Embed Builder (v1.1 - REST-based Publish)
// ============================================================================
// ⚠️⚠️⚠️ تنويه معماري مهم - اقرأه قبل أي دمج (Integration) ⚠️⚠️⚠️
//
// [المسار الصحيح المؤكَّد من index.js]: هذا الملف يوضع مباشرة بـ
// src/commands/custom.js (جنب ban.js/kick.js/mute.js/warn.js/commandhandler.js
// مباشرة) - ما فيه مجلد AutoMod يحتويهم. هذا تصحيح لافتراض سابق خاطئ.
//
// هذا الملف ليس "أمر شات" (Chat Command) رغم إنه يقع بنفس مجلد الأوامر.
// وظيفته الحقيقية: يُستدعى من apiRouter.js فقط، لخدمة صفحة الداشبورد
// custom-messages.html (بناء Embed مخصص ونشره بقناة).
//
// commandhandler.js الحالي يمسح مجلده تلقائياً (Auto Loading) ويستثني
// بالاسم فقط: commandhandler.js, AutoMod.js, AntiAlt.js. "custom.js"
// **غير مستثنى حالياً**. لو حد كتب "!custom" بالشات قبل ما تضيف الاستثناء،
// الـ run() المؤقت بالأسفل (قسم 3) يمنع رسالة الخطأ العامة المزعجة فقط.
//
// [مطلوب لاحقاً منك]:
//   1) commandhandler.js -> إضافة استثناء 'custom.js' بمصفوفة الفلترة.
//   2) apiRouter.js       -> بالفعل مربوط بهذا الملف (راجع الرد المرفق).
//
// ============================================================================
// [لماذا لا يوجد discord.js Client هنا - تصحيح لتصميم سابق خاطئ]:
// index.js (عملية البوت) و apiServer.js (عملية الداشبورد) عمليتان منفصلتان
// تماماً - apiServer.js لا يستدعي client.js ولا index.js إطلاقاً، ويستخدم
// بالفعل Discord REST API مباشرة بالتوكن (discordFetch, تحديث nickname)
// بدل gateway client. لذلك publishDraft() هنا يرسل الرسالة عبر REST API
// مباشرة (POST /channels/:id/messages) بنفس أسلوب apiServer.js تماماً -
// بدون أي حاجة لتمرير client ولا خطر Circular Require.
// ============================================================================
// [التصميم المتفق عليه بالمحادثة]:
//   - صف واحد لكل سيرفر بجدول custom_embed_draft (id_guild PK) - نفس نمط
//     Smart Binding المستخدم بجداول setting_*.
//   - "تروح خلال يوم": لا expires_at ولا Job مجدول. الفحص يصير هنا فقط
//     داخل getDraft() بمقارنة updated_at (حل بسيط، مقصود ومؤكَّد).
//   - القناة لا تُحفظ بالمسودة أبداً - تصل فقط كـ channelId لـ publishDraft().
//   - حد "3 حقول بالصف" هو سلوك Discord التلقائي لـ inline:true، لا يُفرض هنا.
//   - حدود Discord الحقيقية (طول العنوان/الوصف/الحقول) تُفحص هنا كحد أدنى
//     ضروري، لكن نصوص رسائل الخطأ نفسها تُركت لك (Error Codes وليس نصوص).
// ============================================================================

const dbUtils = require('../supabase/dbUtils');
const supabase = require('../supabase/db');

const TABLE_NAME = 'custom_embed_draft';

// نفس الـ Base URL المستخدم بالفعل بـ apiServer.js (DISCORD_API) - مكرر
// هنا عمداً بدل استيراده من apiServer.js لتجنّب أي ترابط بين ملف داخل
// commands/ وملف السيرفر نفسه (فصل واضح للمسؤوليات).
const DISCORD_API_BASE = 'https://discord.com/api/v10';

// مدة "صلاحية" المسودة قبل ما تُعتبر منتهية (بالمنطق فقط، بدون حذف فعلي
// حتى أول Save/Publish جديد) = 24 ساعة، كما اتفقنا.
const DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_COLOR = '#5865F2';

// حدود Discord الرسمية الحقيقية - مُصدَّرة تحت عشان تقدر تعيد استخدام نفس
// الأرقام بالداشبورد (frontend) لتحقق فوري بدون تكرارها بمكانين.
const DISCORD_LIMITS = Object.freeze({
    MESSAGE_CONTENT: 2000,   // outside_text (يُرسل كرسالة عادية)
    EMBED_TITLE: 256,
    EMBED_DESCRIPTION: 4096,
    EMBED_FIELDS_MAX: 25,
    EMBED_FIELD_NAME: 256,
    EMBED_FIELD_VALUE: 1024,
    EMBED_TOTAL: 6000        // مجموع كل نصوص الـ embed مع بعض
});

// ============================================================================
// 1. HELPERS (داخلية فقط - غير مُصدَّرة)
// ============================================================================

/**
 * فراغ افتراضي يُرجَّع للداشبورد لو ما فيه مسودة أصلاً أو انتهت صلاحيتها.
 */
function emptyDraft(guildId) {
    return {
        id_guild: guildId,
        outside_text: '',
        embed_title: '',
        embed_description: '',
        embed_color: DEFAULT_COLOR,
        embed_fields: [],
        id_user_editor: null,
        updated_at: null,
        expired: false,
        isNew: true
    };
}

function isHexColor(value) {
    return typeof value === 'string' && /^#?[0-9A-Fa-f]{6}$/.test(value);
}

function normalizeHexColor(value) {
    const clean = value.startsWith('#') ? value : `#${value}`;
    return clean.toUpperCase();
}

/**
 * يحوّل '#RRGGBB' -> رقم صحيح، وهو الشكل اللي يطلبه Discord REST API
 * لحقل embed.color (integer مو string).
 */
function hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
}

/**
 * يتحقق من صحة payload المسودة مقابل حدود Discord الحقيقية فقط
 * (مو منطق عرض الداشبورد زي حد الـ 3 حقول بالصف - هذا مسؤولية الواجهة).
 * @returns {string[]} مصفوفة Error Codes (فاضية = كله سليم)
 */
function validateDraftPayload(payload) {
    const errors = [];

    const outsideText = payload.outsideText ?? '';
    const title = payload.embedTitle ?? '';
    const description = payload.embedDescription ?? '';
    const color = payload.embedColor ?? DEFAULT_COLOR;
    const fields = Array.isArray(payload.embedFields) ? payload.embedFields : [];

    if (outsideText.length > DISCORD_LIMITS.MESSAGE_CONTENT) {
        errors.push('OUTSIDE_TEXT_TOO_LONG');
    }

    if (title.length > DISCORD_LIMITS.EMBED_TITLE) {
        errors.push('EMBED_TITLE_TOO_LONG');
    }

    if (description.length > DISCORD_LIMITS.EMBED_DESCRIPTION) {
        errors.push('EMBED_DESCRIPTION_TOO_LONG');
    }

    if (!isHexColor(color)) {
        errors.push('INVALID_COLOR');
    }

    if (fields.length > DISCORD_LIMITS.EMBED_FIELDS_MAX) {
        errors.push('TOO_MANY_FIELDS');
    }

    let totalFieldsLength = 0;
    for (const field of fields) {
        const name = field?.name ?? '';
        const value = field?.value ?? '';

        if (name.length > DISCORD_LIMITS.EMBED_FIELD_NAME) {
            errors.push('FIELD_NAME_TOO_LONG');
        }
        if (value.length > DISCORD_LIMITS.EMBED_FIELD_VALUE) {
            errors.push('FIELD_VALUE_TOO_LONG');
        }
        totalFieldsLength += name.length + value.length;
    }

    const totalEmbedLength = title.length + description.length + totalFieldsLength;
    if (totalEmbedLength > DISCORD_LIMITS.EMBED_TOTAL) {
        errors.push('EMBED_TOTAL_TOO_LONG');
    }

    // إزالة التكرار (لو نفس الخطأ تكرر بأكثر من حقل، نرجعه مرة وحدة بالكود)
    return [...new Set(errors)];
}

/**
 * ينظّف مصفوفة embed_fields قبل الحفظ: يشيل العناصر الفاضية تماماً،
 * ويتأكد إن name/value/inline موجودين بأنواعهم الصحيحة فقط.
 */
function sanitizeFields(fields) {
    if (!Array.isArray(fields)) return [];

    return fields
        .map((f) => ({
            name: typeof f?.name === 'string' ? f.name.trim() : '',
            value: typeof f?.value === 'string' ? f.value.trim() : '',
            inline: f?.inline !== false // افتراضياً true (نفس سلوك Discord
                                         // التلقائي لتجميع 3 بالصف)
        }))
        .filter((f) => f.name.length > 0 || f.value.length > 0);
}

/**
 * يرسل رسالة فعلية لقناة ديسكورد عبر REST API مباشرة بالتوكن - نفس أسلوب
 * discordFetch() الموجود بـ apiServer.js بالضبط (GET)، لكن هذا POST لإنشاء
 * رسالة. مكرر هنا عمداً (بدل استيراده) لإبقاء custom.js مستقل تماماً عن
 * apiServer.js.
 *
 * @param {string} channelId
 * @param {{content?: string, embeds?: object[]}} messagePayload
 * @returns {Promise<{ok:boolean, status:number, data?:object, error?:string}>}
 */
async function sendDiscordMessage(channelId, messagePayload) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        console.error('[custom.js] DISCORD_TOKEN missing from environment.');
        return { ok: false, status: 0, error: 'MISSING_TOKEN' };
    }

    let res;
    try {
        res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(messagePayload)
        });
    } catch (err) {
        console.error('[custom.js] sendDiscordMessage network error:', err.message);
        return { ok: false, status: 0, error: 'NETWORK_ERROR' };
    }

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[custom.js] Discord send failed (${res.status}):`, errBody);
        return { ok: false, status: res.status, error: errBody };
    }

    const data = await res.json();
    return { ok: true, status: res.status, data };
}

// ============================================================================
// 2. CORE FUNCTIONS (مُصدَّرة - تُستدعى من apiRouter.js)
// ============================================================================

/**
 * يجيب مسودة الـ Embed الحالية لسيرفر معيّن.
 * يستخدم universalGet (Smart Binding) لأن الجدول صف واحد لكل guild -
 * نفس نمط باقي جداول setting_*.
 *
 * لو ما فيه مسودة، أو موجودة لكن مرّ عليها أكثر من 24 ساعة (updated_at)،
 * يرجّع فورم فاضي بدل بيانات قديمة - بدون ما يمسح الصف الفعلي بقاعدة
 * البيانات (حسب الاتفاق).
 *
 * @param {string} guildId
 * @returns {Promise<Object>} شكل موحّد دايماً (never null/undefined)
 */
async function getDraft(guildId) {
    let row;
    try {
        row = await dbUtils.universalGet(TABLE_NAME, guildId);
    } catch (err) {
        console.error('[custom.js] getDraft error:', err.message);
        return emptyDraft(guildId);
    }

    if (!row) {
        return emptyDraft(guildId);
    }

    const updatedAt = row.updated_at ? new Date(row.updated_at) : null;
    const expired = !updatedAt || (Date.now() - updatedAt.getTime() > DRAFT_EXPIRY_MS);

    if (expired) {
        return { ...emptyDraft(guildId), expired: true, isNew: false };
    }

    return {
        id_guild: row.id_guild,
        outside_text: row.outside_text ?? '',
        embed_title: row.embed_title ?? '',
        embed_description: row.embed_description ?? '',
        embed_color: row.embed_color ?? DEFAULT_COLOR,
        embed_fields: Array.isArray(row.embed_fields) ? row.embed_fields : [],
        id_user_editor: row.id_user_editor ?? null,
        updated_at: row.updated_at,
        expired: false,
        isNew: false
    };
}

/**
 * يحفظ (Upsert) مسودة الـ Embed لسيرفر معيّن.
 *
 * [ليش ما استخدمنا dbUtils.universalUpdate هنا]: universalUpdate تسوي
 * UPDATE فقط (تفترض الصف موجود مسبقاً). custom_embed_draft ليست جزء من
 * init_guild_settings()، فأول Save لأي سيرفر ما فيه صف أصلاً، فـ UPDATE
 * وقتها يفشل بصمت. لذلك نستخدم upsert مباشر عبر عميل supabase الخام هنا
 * (نفس أسلوب addLogIndex() بـ dbUtils.js).
 *
 * @param {string} guildId
 * @param {Object} payload - { outsideText, embedTitle, embedDescription, embedColor, embedFields }
 * @param {string|null} editorUserId - Discord ID لمن يعدّل (اختياري، للعرض فقط)
 * @returns {Promise<{success:boolean, draft?:Object, errors?:string[]}>}
 */
async function saveDraft(guildId, payload, editorUserId = null) {
    const errors = validateDraftPayload(payload);
    if (errors.length > 0) {
        return { success: false, errors };
    }

    const cleanColor = normalizeHexColor(payload.embedColor ?? DEFAULT_COLOR);

    const row = {
        id_guild: guildId,
        outside_text: (payload.outsideText ?? '').trim(),
        embed_title: (payload.embedTitle ?? '').trim(),
        embed_description: (payload.embedDescription ?? '').trim(),
        embed_color: cleanColor,
        embed_fields: sanitizeFields(payload.embedFields),
        id_user_editor: editorUserId,
        updated_at: new Date().toISOString()
    };

    try {
        const { data, error } = await supabase
            .from(TABLE_NAME)
            .upsert(row, { onConflict: 'id_guild' })
            .select()
            .single();

        if (error) {
            console.error('[custom.js] saveDraft error:', error.message);
            return { success: false, errors: ['DATABASE_ERROR'] };
        }

        return { success: true, draft: { ...data, expired: false, isNew: false } };
    } catch (err) {
        console.error('[custom.js] saveDraft exception:', err.message);
        return { success: false, errors: ['DATABASE_ERROR'] };
    }
}

/**
 * يبني payload خام (plain JSON) جاهز لإرسال REST API مباشرة (content +
 * embeds) من شكل مسودة (سواء جاية من getDraft أو مباشرة من saveDraft).
 * مُصدَّرة لوحدها أيضاً عشان الداشبورد يقدر يستخدمها لعرض "معاينة حية"
 * قبل الضغط على Publish لو حبيت تضيفها لاحقاً بدون تكرار منطق البناء.
 *
 * @param {Object} draft - نفس شكل رجوع getDraft()
 * @returns {{content: string|undefined, embeds: object[]}}
 */
function buildEmbedPayload(draft) {
    const outsideText = (draft.outside_text ?? '').trim();
    const title = (draft.embed_title ?? '').trim();
    const description = (draft.embed_description ?? '').trim();
    const fields = Array.isArray(draft.embed_fields) ? draft.embed_fields : [];
    const color = isHexColor(draft.embed_color) ? normalizeHexColor(draft.embed_color) : DEFAULT_COLOR;

    const hasEmbedContent = title.length > 0 || description.length > 0 || fields.length > 0;

    const embeds = [];
    if (hasEmbedContent) {
        const validFields = fields
            .filter((f) => f?.name && f?.value)
            .map((f) => ({
                name: String(f.name).slice(0, DISCORD_LIMITS.EMBED_FIELD_NAME),
                value: String(f.value).slice(0, DISCORD_LIMITS.EMBED_FIELD_VALUE),
                inline: f.inline !== false
            }));

        // نبني object خام يطابق شكل Discord REST API لحقل embeds مباشرة
        // (بدون discord.js EmbedBuilder - غير مطلوب لأننا REST فقط هنا)
        const embed = { color: hexToInt(color) };
        if (title.length > 0) embed.title = title;
        if (description.length > 0) embed.description = description;
        if (validFields.length > 0) embed.fields = validFields;

        embeds.push(embed);
    }

    return {
        content: outsideText.length > 0 ? outsideText : undefined,
        embeds
    };
}

/**
 * ينشر المسودة الحالية لسيرفر معيّن بقناة محدّدة عبر Discord REST API
 * مباشرة (بدون discord.js Client - راجع التنويه المعماري بأعلى الملف)،
 * ثم يمسح المسودة (تُعتبر "مُستهلَكة" بعد النشر - أول Save جاي بعدها
 * يبدأ صف جديد من الصفر).
 *
 * @param {Object} params
 * @param {string} params.guildId
 * @param {string} params.channelId
 * @param {string|null} params.publisherUserId - Discord ID لمن ضغط Publish (للـ audit log)
 * @returns {Promise<{success:boolean, error?:string, messageId?:string}>}
 */
async function publishDraft({ guildId, channelId, publisherUserId = null }) {
    const draft = await getDraft(guildId);
    const payload = buildEmbedPayload(draft);

    if (!payload.content && payload.embeds.length === 0) {
        return { success: false, error: 'EMPTY_DRAFT' };
    }

    const result = await sendDiscordMessage(channelId, payload);

    if (!result.ok) {
        if (result.status === 404) return { success: false, error: 'CHANNEL_NOT_FOUND' };
        if (result.status === 403) return { success: false, error: 'FORBIDDEN' };
        return { success: false, error: 'SEND_FAILED' };
    }

    // Audit log (لا يوقف عملية النشر لو فشل - النشر نجح فعلاً بديسكورد،
    // تسجيل الحدث ثانوي، نفس فلسفة بقية دوال اللوق بالمشروع)
    try {
        await dbUtils.logDashboardAction(
            guildId,
            publisherUserId,
            'PUBLISH_EMBED',
            `Published custom embed to channel ${channelId}`,
            draft,
            null
        );
    } catch (err) {
        console.error('[custom.js] publishDraft audit log error:', err.message);
    }

    // تنظيف المسودة بعد الاستهلاك (نفس مبدأ "تروح" لكن فوري بدل انتظار يوم)
    try {
        await supabase.from(TABLE_NAME).delete().eq('id_guild', guildId);
    } catch (err) {
        console.error('[custom.js] publishDraft cleanup error:', err.message);
    }

    return { success: true, messageId: result.data.id, channelId };
}

// ============================================================================
// 3. CHAT-COMMAND SAFETY NET (مؤقت - احذفه لما تستثني الملف بـ commandhandler.js)
// ============================================================================
// هذا الملف بالأصل مو أمر شات. لكن بما إن Auto Loading بـ commandhandler.js
// لسه ما تم تحديثه، حطيت run() آمن هنا فقط لمنع رسالة الخطأ العامة المزعجة
// لو حد كتب "!custom" بالغلط بالشات قبل ما تضيف الاستثناء. احذف هذا الجزء
// بالكامل (name + run) بعد ما تضيف 'custom.js' لمصفوفة الاستثناء
// بـ commandhandler.js.
const name = 'custom';
async function run(message) {
    return message.reply({
        content: '❌ This feature is managed from the dashboard only.'
    });
}

module.exports = {
    name,
    run, // ⚠️ مؤقت - راجع القسم 3 بالأعلى

    // الدوال الحقيقية اللي يستخدمها apiRouter.js
    getDraft,
    saveDraft,
    buildEmbedPayload,
    publishDraft,

    // مُصدَّرة للاستخدام الاختياري (تحقق فوري بالفرونت اند، إلخ)
    DISCORD_LIMITS
};