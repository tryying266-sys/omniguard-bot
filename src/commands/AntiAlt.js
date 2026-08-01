/**
 * ============================================================================
 * OmniGuard - AntiAlt Module (v1.0)
 * نظام كشف الحسابات البديلة والغارات - نظام نقاط تراكمي وموزون
 * ============================================================================
 *
 * -----------------------------------------------------------------------------
 * 📋 ملخص الخطة الكاملة (موثّق هنا بالكامل حتى لا تُفقد أي تفاصيل بمرور الوقت)
 * -----------------------------------------------------------------------------
 *
 * [مفتاح التشغيل الرئيسي] النظام بالكامل معطل افتراضياً. أول شيء يتحقق منه أي
 * دخول لهذا الملف هو `settings.enabled` من جدول setting_alt_anti. لو false أو
 * الإعدادات غير موجودة، لا يُحتسب أي شيء ولا يُفحص أي عضو إطلاقاً - صفر تكلفة.
 *
 * [لا يوجد سلم إجراءات ثابت] بعكس AutoMod.js، هذا النظام لا يملك تصنيفات
 * (مراقبة/كتم/طرد/حظر) مبرمجة بالكود. يوجد عتبة واحدة فقط (threshold_action).
 * لو النقاط التراكمية وصلت أو تجاوزت هذه العتبة، يرجع الكود لقاعدة البيانات
 * فوراً ليقرأ `action_to_take` (kick/ban/mute/none) الذي حدده صاحب السيرفر
 * بنفسه من لوحة التحكم، وينفذه مباشرة. القيمة الرقمية للعتبة نفسها + كل الأوزان
 * قابلة للتعديل من قاعدة البيانات لاحقاً، لكن الافتراضي الذي اخترته بعد موازنة
 * دقيقة بين "عدم إفلات المذنب" و"عدم ظلم البريء" هو 65 نقطة.
 *
 * [شرط التنوع - الحماية الرياضية الأهم من الظلم] حتى لو تجاوزت النقاط العتبة،
 * لا يُنفَّذ أي إجراء عقابي فعلي (طرد/حظر/كتم) إلا إذا ساهمت **بُعدان مستقلان
 * على الأقل** بنقاط موجبة. لو كل النقاط جاءت من بُعد واحد بس (مهما كان قوياً،
 * مثل تطابق كتابي عالي جداً)، يُسجَّل الحدث للمراجعة البشرية فقط بدون أي عقوبة
 * تلقائية. هذا يمنع أي إشارة احتمالية واحدة - مهما بدت قوية - من إيقاع ظلم.
 *
 * [معامل مصداقية عمر الحساب] كل النقاط (ما عدا زناد الـ Honeypot) تُضرب بمعامل
 * يعتمد على عمر الحساب: أقل من 7 أيام = ×1.00، 7-30 يوم = ×0.70، 30-180 يوم =
 * ×0.40، أكبر من 180 يوم = ×0.15. هذا يحمي الحسابات القديمة رياضياً من أي
 * تراكم نقاط عرَضي (تشابه كتابي صدفة، صفر سيرفرات مشتركة، إلخ).
 *
 * [الأبعاد المحسوبة - كل بُعد = دليل مستقل واحد لغرض "شرط التنوع"]:
 *   1. metadata            → عمر الحساب + الصورة الافتراضية + نمط الاسم العشوائي
 *                           (مجمّعة كبُعد واحد عمداً لأنها كلها "نظرة سطحية أولى"
 *                           غير مستقلة فعلياً عن بعضها إحصائياً)
 *   2. account_depth      → عكسي (حمائي فقط): نيترو (أفتار متحرك/بانر)، بوست
 *                           السيرفر، شارات الحساب (Staff/BugHunter/...)، حالة
 *                           مخصصة (Custom Status) - كل مؤشر "استثمار حقيقي
 *                           بالحساب" يخصم نقاط
 *   3. invite_freshness    → عمر رابط الدعوة نفسه وقت الاستخدام
 *   4. inviter_graph        → شجرة علاقات الداعي-المدعو الدائمة بقاعدة البيانات:
 *                           هل الداعي نفسه مشبوه سابقاً؟ كم عدد المدعوين الآخرين
 *                           لنفس الداعي انتهى بهم الحال مُشتبهين؟
 *   5. mutual_servers       → صفر سيرفرات مشتركة مع البوت (يُهمَل تلقائياً لو
 *                           عدد سيرفرات البوت أقل من الحد الأدنى المُعتبر موثوق)
 *   6. raid_cluster         → دخول عدة حسابات بنمط اسم متشابه خلال نافذة زمنية
 *                           قصيرة - يُعاد تقييم كل أعضاء العنقود عند اكتشافه،
 *                           حتى من انضم قبل لحظات وهو لسه بنافذة المراقبة
 *   7. first_message_speed → سرعة إرسال أول رسالة بعد الانضمام
 *   8. spam_rate            → معدل رسائل مرتفع بأول دقائق من الانضمام (نافذة
 *                           مستقلة تماماً عن AutoMod.js العادي - أشد حساسية
 *                           لأنها مخصصة لحديثي الانضمام فقط)
 *   9. stylometric          → البصمة الكتابية (تحليل ثنائيات الحروف/الأنماط)
 *                           مقارنة بحسابات سبق أن وصلت لعتبة الإجراء بنفس
 *                           السيرفر خلال نافذة زمنية معينة (lookback_days)
 *  10. temporal_heatmap     → نمط ساعات النشاط اليومي (UTC) مقارنة بنفس بنك
 *                           الحسابات المشبوهة السابقة
 *
 * [زناد فوري مستقل - Honeypot] الاستثناء الوحيد الذي يتجاوز نظام النقاط بالكامل.
 * أي عضو (غير أدمن) يتفاعل مع قناة مخفية بالصلاحيات (لا يقدر عضو حقيقي يراها
 * أصلاً) يُحظر فوراً - هذا دليل شبه قاطع (سكربت/بوت يفحص كل القنوات)، لا يحتاج
 * نظام نقاط. يبقى مربوطاً بمفتاح التشغيل الرئيسي مثل كل شيء آخر بهذا الملف.
 *
 * [ملاحظة صريحة] تم إلغاء أي مفهوم لـ"مراقبة صامتة/كتم مبدئي" كتصنيف أو حالة
 * سلوك منفصلة بناءً على طلب صريح - لا يوجد إلا: (لا شيء) أو (تنفيذ إجراء
 * صاحب السيرفر المحدد بقاعدة البيانات). كذلك تم إلغاء أي كتم تلقائي بسبب
 * منشنة الإدارة أو مراسلة البوت خاص من حساب حديث - هذا السلوك غير موجود هنا.
 *
 * [نافذة المراقبة] كل عضو ينضم يُفتح له "جلسة" مؤقتة بالذاكرة (72 ساعة
 * افتراضياً، قابلة للتعديل) تتراكم فيها النقاط من كل الأبعاد أعلاه مع كل رسالة
 * جديدة يرسلها، حتى تنتهي المدة (تُحذف الجلسة بلا أثر) أو تُنفَّذ العقوبة
 * (مرة واحدة فقط - one-shot، لا تكرار). الجلسات بالذاكرة فقط (Map) وتُفقد لو
 * البوت أعاد التشغيل - نفس فلسفة spamTracker بملف AutoMod.js تماماً.
 *
 * [الملفات التي يحتاجها هذا الملف عمله بالكامل - سيتم شرحها في نهاية الرد]:
 *   - أعمدة جديدة بجدول setting_alt_anti
 *   - جدول جديد: invite_relations (شجرة الدعوات)
 *   - جدول جديد: user_writing_fingerprint (البصمة الكتابية)
 *   - جدول جديد: user_activity_heatmap (النمط الزمني)
 *   - توسيع CHECK على alt_suspected.action_taken لإضافة 'Muted'
 *   - ربط init(client) + handleMemberJoin + handleMessage بـ index.js
 *   - استثناء 'AntiAlt.js' من المُحمِّل التلقائي بـ commandhandler.js
 * لن يُكتب أي SQL بهذا الرد بناءً على طلبك الصريح - فقط الكود هنا.
 * ============================================================================
 */

const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const dbUtils = require('../supabase/dbUtils');
const { universalGet } = dbUtils;

// ============================================================================
// الحالة بالذاكرة (In-Memory State) - نفس فلسفة AutoMod.js: لا تحتاج قاعدة
// بيانات لأنها مؤقتة بطبيعتها وتُفقد بأمان لو أعاد البوت التشغيل
// ============================================================================

const activeSessions = new Map();
const inviteCache = new Map();
const recentJoins = new Map();

// ============================================================================
// ثوابت وأدوات مساعدة عامة
// ============================================================================

const DURATION_UNITS_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const MAX_TIMEOUT_MS = 28 * DURATION_UNITS_MS.d;

function parseDurationToMs(input) {
    if (!input) return null;
    const match = String(input).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
    if (!match) return null;
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (!amount || amount <= 0) return null;
    const ms = amount * DURATION_UNITS_MS[unit];
    return ms > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : ms;
}

const NOTABLE_BADGES = [
    'Staff', 'Partner', 'Hypesquad', 'HypeSquadOnlineHouse1', 'HypeSquadOnlineHouse2',
    'HypeSquadOnlineHouse3', 'BugHunterLevel1', 'BugHunterLevel2', 'PremiumEarlySupporter',
    'VerifiedDeveloper', 'CertifiedModerator', 'ActiveDeveloper', 'VerifiedBot'
];

function getCredibilityMultiplier(ageMs) {
    const days = ageMs / DURATION_UNITS_MS.d;
    if (days < 7) return 1.0;
    if (days < 30) return 0.7;
    if (days < 180) return 0.4;
    return 0.15;
}

function addScore(session, rawPoints, dimensionKey) {
    if (!rawPoints) return;
    if (rawPoints > 0 && dimensionKey) session.dimensions.add(dimensionKey);
    session.score += rawPoints * session.multiplier;
    if (session.score < 0) session.score = 0;
}

function isRandomLookingUsername(username) {
    const name = (username || '').toLowerCase();
    if (name.length < 4) return false;
    if (/^[a-z]{2,10}\d{4,}$/.test(name)) return true;
    const digitRatio = (name.match(/\d/g) || []).length / name.length;
    if (name.length >= 6 && digitRatio > 0.5) return true;
    if (name.length >= 7 && !/[aeiou]/.test(name)) return true;
    return false;
}

function usernamePatternKey(username) {
    return (username || '').toLowerCase().replace(/[0-9]/g, '#');
}

// ============================================================================
// 1) البيانات الوصفية عند الدخول (Metadata)
// ============================================================================

function checkMetadata(member, ageMs) {
    let points = 0;
    const days = ageMs / DURATION_UNITS_MS.d;

    if (days < (1 / 24)) points += 30;
    else if (days < 1) points += 20;
    else if (days < 3) points += 12;
    else if (days < 7) points += 6;
    else if (days < 30) points += 2;

    if (!member.user.avatar) points += 8;

    if (isRandomLookingUsername(member.user.username)) points += 15;

    return { points, dimension: points > 0 ? 'metadata' : null };
}

async function checkAccountDepth(member) {
    let points = 0;
    try {
        const fresh = await member.user.fetch();

        const hasAnimatedAvatar = !!(fresh.avatar && fresh.avatar.startsWith('a_'));
        const hasBanner = !!fresh.banner;
        const isBooster = !!member.premiumSince;
        const badges = fresh.flags ? fresh.flags.toArray() : [];
        const hasNotableBadge = badges.some(b => NOTABLE_BADGES.includes(b));
        const hasCustomStatus = member.presence?.activities?.some(a => a.type === 4) || false;

        const positiveSignals = [hasAnimatedAvatar, hasBanner, isBooster, hasNotableBadge, hasCustomStatus].filter(Boolean).length;
        if (positiveSignals > 0) {
            points -= positiveSignals * 6;
        }
    } catch (e) {
        // فشل الجلب (نادر) - نتجاهل هذا البُعد لهذه الحالة فقط
    }
    return { points, dimension: null };
}

// ============================================================================
// 2) تتبع الدعوات + شجرة علاقات الداعي-المدعو (Inviter Graph)
// ============================================================================

async function cacheGuildInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        const map = new Map();
        invites.forEach(inv => {
            map.set(inv.code, {
                uses: inv.uses || 0,
                inviterId: inv.inviter?.id || null,
                inviterTag: inv.inviter?.tag || 'Unknown',
                createdTimestamp: inv.createdTimestamp || null
            });
        });
        inviteCache.set(guild.id, map);
    } catch (e) {
        // غالباً نقص صلاحية Manage Server - نتجاهل بُعد الدعوات بصمت لهذا السيرفر فقط
    }
}

async function detectUsedInvite(guild) {
    const before = inviteCache.get(guild.id);
    if (!before) return null;

    let freshInvites;
    try {
        freshInvites = await guild.invites.fetch();
    } catch (e) {
        return null;
    }

    let used = null;
    const rebuilt = new Map();
    freshInvites.forEach(inv => {
        const prev = before.get(inv.code);
        const prevUses = prev ? prev.uses : 0;
        if (!used && (inv.uses || 0) > prevUses) {
            used = {
                code: inv.code,
                inviterId: inv.inviter?.id || null,
                inviterTag: inv.inviter?.tag || 'Unknown',
                createdTimestamp: inv.createdTimestamp || null,
                usesNow: inv.uses || 0
            };
        }
        rebuilt.set(inv.code, {
            uses: inv.uses || 0,
            inviterId: inv.inviter?.id || null,
            inviterTag: inv.inviter?.tag || 'Unknown',
            createdTimestamp: inv.createdTimestamp || null
        });
    });
    inviteCache.set(guild.id, rebuilt);

    return used;
}

function scoreInviteFreshness(usedInvite) {
    let points = 0;
    if (usedInvite.createdTimestamp && (Date.now() - usedInvite.createdTimestamp) < 3600000) {
        points += 10;
    } else if (usedInvite.createdTimestamp &&
               (Date.now() - usedInvite.createdTimestamp) > 30 * DURATION_UNITS_MS.d &&
               usedInvite.usesNow > 10) {
        points -= 10;
    }
    return { points, dimension: points > 0 ? 'invite_freshness' : null };
}

async function checkInviterGraph(guild, member, usedInvite, supabase) {
    if (!usedInvite || !usedInvite.inviterId) return { points: 0, dimension: null };

    try {
        await supabase.from('invite_relations').insert({
            id_guild: guild.id,
            inviter_id: usedInvite.inviterId,
            invitee_id: member.id,
            invite_code: usedInvite.code,
            joined_at: new Date().toISOString()
        });
    } catch (e) { /* لا نكسر التنفيذ لو فشل التسجيل */ }

    let points = 0;

    try {
        const { data: inviterFlags } = await supabase
            .from('alt_suspected')
            .select('id')
            .eq('id_guild', guild.id)
            .eq('id_user', usedInvite.inviterId)
            .limit(1);

        if (inviterFlags && inviterFlags.length > 0) points += 20;

        const { data: siblings } = await supabase
            .from('invite_relations')
            .select('invitee_id')
            .eq('id_guild', guild.id)
            .eq('inviter_id', usedInvite.inviterId);

        if (siblings && siblings.length > 1) {
            const siblingIds = [...new Set(siblings.map(r => r.invitee_id))].filter(id => id !== member.id);
            if (siblingIds.length > 0) {
                const { data: flaggedSiblings } = await supabase
                    .from('alt_suspected')
                    .select('id_user')
                    .eq('id_guild', guild.id)
                    .in('id_user', siblingIds);

                const flaggedCount = flaggedSiblings ? new Set(flaggedSiblings.map(r => r.id_user)).size : 0;
                if (flaggedCount > 0) points += Math.min(flaggedCount * 10, 30);
            }
        }
    } catch (e) {
        // فشل استعلام - نتجاهل هذا البُعد لهذه الحالة فقط
    }

    return { points, dimension: points > 0 ? 'inviter_graph' : null };
}

// ============================================================================
// 3) السيرفرات المشتركة
// ============================================================================

function checkMutualServers(member, settings, client) {
    const minGuildCount = settings.mutual_server_min_guild_count || 15;
    if (client.guilds.cache.size < minGuildCount) return { points: 0, dimension: null };

    let mutualCount = 0;
    for (const g of client.guilds.cache.values()) {
        if (g.id === member.guild.id) continue;
        if (g.members.cache.has(member.id)) mutualCount++;
    }

    if (mutualCount === 0) return { points: 10, dimension: 'mutual_servers' };
    return { points: -5, dimension: null };
}

// ============================================================================
// 4) توقيع الغارة (Raid Cluster Detection)
// ============================================================================

async function registerJoinAndCheckRaidCluster(guild, member, settings, supabase) {
    const windowMs = (settings.raid_cluster_window_seconds || 30) * 1000;
    const minMembers = settings.raid_cluster_min_members || 3;

    if (!recentJoins.has(guild.id)) recentJoins.set(guild.id, []);
    const list = recentJoins.get(guild.id);

    const now = Date.now();
    const patternKey = usernamePatternKey(member.user.username);
    list.push({ userId: member.id, username: member.user.username, patternKey, ts: now });

    const fresh = list.filter(j => now - j.ts < windowMs);
    recentJoins.set(guild.id, fresh);

    const cluster = fresh.filter(j => j.patternKey === patternKey);
    if (cluster.length < minMembers) return;

    for (const j of cluster) {
        const key = `${guild.id}:${j.userId}`;
        const s = activeSessions.get(key);
        if (!s || s.actioned) continue;

        addScore(s, 25, 'raid_cluster');

        const m = await guild.members.fetch(j.userId).catch(() => null);
        if (m) await resolveAndExecuteAction(guild, m, s, settings, supabase);
    }
}

// ============================================================================
// 5) البصمة السلوكية عند الرسائل (سرعة أول رسالة + سبام حديثي الانضمام)
// ============================================================================

function checkFirstMessageSpeed(session) {
    const deltaMs = Date.now() - session.joinedAt;
    if (deltaMs < 5000) return { points: 20, dimension: 'first_message_speed' };
    if (deltaMs > 60000) return { points: -8, dimension: null };
    return { points: 0, dimension: null };
}

function checkNewJoinerSpam(session, settings) {
    const windowMs = (settings.new_joiner_spam_window_seconds || 15) * 1000;
    const limit = settings.new_joiner_spam_msg_limit || 4;
    const now = Date.now();

    if (!session.spamWindowStart || (now - session.spamWindowStart) > windowMs) {
        session.spamWindowStart = now;
        session.spamCount = 1;
        return { points: 0, dimension: null };
    }

    session.spamCount++;
    if (session.spamCount === limit) {
        return { points: 18, dimension: 'spam_rate' };
    }
    return { points: 0, dimension: null };
}

// ============================================================================
// 6) البصمة الكتابية العميقة (Stylometric Fingerprint)
// ============================================================================

function buildBigramProfile(text) {
    const clean = (text || '').toLowerCase()
        .replace(/[^\w\s\u0600-\u06FF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const profile = {};
    for (let i = 0; i < clean.length - 1; i++) {
        const bigram = clean.substring(i, i + 2);
        profile[bigram] = (profile[bigram] || 0) + 1;
    }
    return profile;
}

function mergeMessageProfiles(messages) {
    const merged = {};
    messages.forEach(text => {
        const p = buildBigramProfile(text);
        for (const k in p) merged[k] = (merged[k] || 0) + p[k];
    });
    return merged;
}

function cosineSimilarityProfiles(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let dot = 0, magA = 0, magB = 0;
    for (const k of keys) {
        const va = a[k] || 0, vb = b[k] || 0;
        dot += va * vb;
        magA += va * va;
        magB += vb * vb;
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function checkStylometric(guild, session, settings, supabase) {
    if (session.stylometricChecked) return { points: 0, dimension: null };
    if (session.messageSamples.length < 3) return { points: 0, dimension: null };

    session.stylometricChecked = true;

    try {
        const newProfile = mergeMessageProfiles(session.messageSamples.map(m => m.content));
        const lookbackDate = new Date(Date.now() - (settings.lookback_days || 90) * DURATION_UNITS_MS.d).toISOString();

        const { data: stored } = await supabase
            .from('user_writing_fingerprint')
            .select('fingerprint')
            .eq('id_guild', guild.id)
            .gte('flagged_at', lookbackDate);

        if (!stored || stored.length === 0) return { points: 0, dimension: null };

        let best = 0;
        for (const row of stored) {
            const sim = cosineSimilarityProfiles(newProfile, row.fingerprint?.profile || {});
            if (sim > best) best = sim;
        }

        let points = 0;
        if (best >= 0.85) points = 35;
        else if (best >= 0.70) points = 20;
        else if (best >= 0.55) points = 8;

        return { points, dimension: points > 0 ? 'stylometric' : null };
    } catch (e) {
        return { points: 0, dimension: null };
    }
}

// ============================================================================
// 7) نمط النشاط الزمني (Temporal Heatmap)
// ============================================================================

function buildHeatmap(timestamps) {
    const hours = new Array(24).fill(0);
    timestamps.forEach(ts => { hours[new Date(ts).getUTCHours()]++; });
    return hours;
}

function cosineSimilarityVectors(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function checkTemporalHeatmap(guild, session, settings, supabase) {
    if (session.temporalChecked) return { points: 0, dimension: null };
    if (session.messageTimestamps.length < 5) return { points: 0, dimension: null };

    session.temporalChecked = true;

    try {
        const newHeatmap = buildHeatmap(session.messageTimestamps);
        const lookbackDate = new Date(Date.now() - (settings.lookback_days || 90) * DURATION_UNITS_MS.d).toISOString();

        const { data: stored } = await supabase
            .from('user_activity_heatmap')
            .select('hours')
            .eq('id_guild', guild.id)
            .gte('flagged_at', lookbackDate);

        if (!stored || stored.length === 0) return { points: 0, dimension: null };

        let best = 0;
        for (const row of stored) {
            const sim = cosineSimilarityVectors(newHeatmap, row.hours || []);
            if (sim > best) best = sim;
        }

        let points = 0;
        if (best >= 0.90) points = 18;
        else if (best >= 0.75) points = 10;

        return { points, dimension: points > 0 ? 'temporal_heatmap' : null };
    } catch (e) {
        return { points: 0, dimension: null };
    }
}

// ============================================================================
// 8) تخزين "بصمة" أي حساب يصل لعتبة الإجراء - يبني بنك المقارنات المستقبلي
// ============================================================================

async function persistFlaggedProfile(guild, userId, session, supabase) {
    const now = new Date().toISOString();
    try {
        if (session.messageSamples.length >= 3) {
            const profile = mergeMessageProfiles(session.messageSamples.map(m => m.content));
            await supabase.from('user_writing_fingerprint').insert({
                id_guild: guild.id,
                id_user: userId,
                fingerprint: { profile },
                sample_size: session.messageSamples.length,
                flagged_at: now
            });
        }
        if (session.messageTimestamps.length >= 5) {
            const hours = buildHeatmap(session.messageTimestamps);
            await supabase.from('user_activity_heatmap').insert({
                id_guild: guild.id,
                id_user: userId,
                hours,
                sample_size: session.messageTimestamps.length,
                flagged_at: now
            });
        }
    } catch (e) {
        console.error('[AntiAlt] Failed to persist flagged profile:', e.message);
    }
}

// ============================================================================
// 9) تسجيل القرار (alt_suspected + log_moderation + قناة اللوق)
// ============================================================================

async function logAltDecision(guild, member, session, settings, supabase, actionTaken, reason) {
    try {
        await supabase.from('alt_suspected').insert({
            id_guild: guild.id,
            id_user: member.id,
            username: member.user.tag,
            url_avatar: member.user.displayAvatarURL(),
            at_created_account: member.user.createdAt.toISOString(),
            action_taken: actionTaken,
            at_detected: new Date().toISOString()
        });
    } catch (e) {
        console.error('[AntiAlt] Failed to log alt_suspected:', e.message);
    }

    if (['Banned', 'Kicked', 'Muted'].includes(actionTaken)) {
        try {
            await dbUtils.addInfraction(guild.id, member.id, guild.client.user.id, actionTaken.toLowerCase(), reason, null, member.user.tag);
        } catch (e) { /* لا نكسر التنفيذ لو فشل هذا التسجيل الثانوي */ }
    }

    if (settings.log_channel_id) {
        try {
            const channel = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
            if (channel) {
                const colorMap = { Banned: 0xE74C3C, Kicked: 0xE67E22, Muted: 0xF1C40F, Flagged: 0x95A5A6 };
                const embed = new EmbedBuilder()
                    .setTitle('🛡️ AntiAlt Detection Report')
                    .setColor(colorMap[actionTaken] || 0x95A5A6)
                    .addFields(
                        { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: true },
                        { name: 'Score', value: `${session.score.toFixed(1)}`, inline: true },
                        { name: 'Action', value: actionTaken, inline: true },
                        { name: 'Dimensions Triggered', value: Array.from(session.dimensions).join(', ') || 'none' },
                        { name: 'Reason', value: reason }
                    )
                    .setThumbnail(member.user.displayAvatarURL())
                    .setTimestamp();
                await channel.send({ embeds: [embed] }).catch(() => {});
            }
        } catch (e) { /* تجاهل فشل الإرسال */ }
    }
}

// ============================================================================
// 10) نقطة القرار المركزية
// ============================================================================

async function resolveAndExecuteAction(guild, member, session, settings, supabase) {
    if (session.actioned) return;
    const threshold = (settings.threshold_action ?? 65);
    if (session.score < threshold) return;

    session.actioned = true;

    const breakdown = Array.from(session.dimensions).join(', ') || 'none';
    const hasEnoughDiversity = session.dimensions.size >= 2;

    await persistFlaggedProfile(guild, member.id, session, supabase);

    if (!hasEnoughDiversity) {
        await logAltDecision(
            guild, member, session, settings, supabase, 'Flagged',
            `Score reached ${session.score.toFixed(1)}/${threshold} but only from a single independent dimension (${breakdown}) - auto-action withheld for fairness, requires human review.`
        );
        return;
    }

    const action = settings.action_to_take;
    const reason = `AntiAlt: Score ${session.score.toFixed(1)}/${threshold} across [${breakdown}]`;

    try {
        if (action === 'ban') {
            if (member.bannable) {
                await member.ban({ reason });
                await logAltDecision(guild, member, session, settings, supabase, 'Banned', reason);
            } else {
                console.error(`[AntiAlt] Cannot ban ${member.user.tag}: not bannable by the bot.`);
            }
        } else if (action === 'kick') {
            if (member.kickable) {
                await member.kick(reason);
                await logAltDecision(guild, member, session, settings, supabase, 'Kicked', reason);
            } else {
                console.error(`[AntiAlt] Cannot kick ${member.user.tag}: not kickable by the bot.`);
            }
        } else if (action === 'mute') {
            if (member.moderatable) {
                const ms = parseDurationToMs(settings.action_mute_duration) || 24 * DURATION_UNITS_MS.h;
                await member.timeout(ms, reason);
                await logAltDecision(guild, member, session, settings, supabase, 'Muted', reason);
            } else {
                console.error(`[AntiAlt] Cannot mute ${member.user.tag}: not moderatable by the bot.`);
            }
        } else {
            await logAltDecision(guild, member, session, settings, supabase, 'Flagged', reason);
        }
    } catch (err) {
        console.error(`[AntiAlt] Failed to execute action "${action}" on ${member.user.tag}: ${err.message}`);
    }
}

// ============================================================================
// 11) Honeypot - الزناد الفوري الوحيد الذي يتجاوز نظام النقاط بالكامل
// ============================================================================

async function handleHoneypot(message, settings) {
    if (!settings.honeypot_channel_ids?.includes(message.channel.id)) return false;

    const member = message.member;
    if (!member || member.permissions.has(PermissionFlagsBits.Administrator)) return true;

    try {
        if (member.bannable) {
            await member.ban({ reason: 'AntiAlt: Honeypot channel interaction (near-certain automated/malicious account).' });
            const supabase = require('../supabase/db');
            const fakeSession = { score: 999, dimensions: new Set(['honeypot']) };
            await logAltDecision(
                message.guild, member, fakeSession, settings, supabase, 'Banned',
                'Interacted with a hidden honeypot channel invisible to real members.'
            );
        }
    } catch (e) {
        console.error('[AntiAlt] Honeypot ban failed:', e.message);
    }
    return true;
}

// ============================================================================
// 12) نقاط الدخول المُصدَّرة (Entry Points)
// ============================================================================

function init(client) {
    client.once('ready', async () => {
        for (const guild of client.guilds.cache.values()) {
            await cacheGuildInvites(guild);
        }
    });

    client.on('inviteCreate', invite => cacheGuildInvites(invite.guild));
    client.on('inviteDelete', invite => cacheGuildInvites(invite.guild));

    setInterval(() => {
        const now = Date.now();
        for (const [key, session] of activeSessions) {
            if (now > session.expiresAt) activeSessions.delete(key);
        }
        for (const [guildId, joins] of recentJoins) {
            const filtered = joins.filter(j => now - j.ts < 5 * 60 * 1000);
            if (filtered.length > 0) recentJoins.set(guildId, filtered);
            else recentJoins.delete(guildId);
        }
    }, 10 * 60 * 1000);
}

async function handleMemberJoin(member) {
    if (member.user.bot) return;
    const guild = member.guild;

    const settings = await universalGet('setting_alt_anti', guild.id);
    if (!settings || !settings.enabled) return;

    const supabase = require('../supabase/db');
    const key = `${guild.id}:${member.id}`;

    const ageMs = Date.now() - member.user.createdTimestamp;
    const multiplier = getCredibilityMultiplier(ageMs);

    const session = {
        guildId: guild.id,
        userId: member.id,
        joinedAt: Date.now(),
        expiresAt: Date.now() + (settings.monitoring_window_hours || 72) * DURATION_UNITS_MS.h,
        multiplier,
        score: 0,
        dimensions: new Set(),
        messageSamples: [],
        messageTimestamps: [],
        spamWindowStart: 0,
        spamCount: 0,
        firstMessageChecked: false,
        stylometricChecked: false,
        temporalChecked: false,
        actioned: false
    };
    activeSessions.set(key, session);

    const meta = checkMetadata(member, ageMs);
    addScore(session, meta.points, meta.dimension);

    const depth = await checkAccountDepth(member);
    addScore(session, depth.points, depth.dimension);

    const usedInvite = await detectUsedInvite(guild);
    if (usedInvite) {
        const inv = scoreInviteFreshness(usedInvite);
        addScore(session, inv.points, inv.dimension);

        const graph = await checkInviterGraph(guild, member, usedInvite, supabase);
        addScore(session, graph.points, graph.dimension);
    }

    const mutual = checkMutualServers(member, settings, guild.client);
    addScore(session, mutual.points, mutual.dimension);

    await registerJoinAndCheckRaidCluster(guild, member, settings, supabase);

    await resolveAndExecuteAction(guild, member, session, settings, supabase);
}

async function handleMessage(message) {
    if (!message.guild || message.author.bot) return;
    const guild = message.guild;

    const settings = await universalGet('setting_alt_anti', guild.id);
    if (!settings || !settings.enabled) return;

    const wasHoneypot = await handleHoneypot(message, settings);
    if (wasHoneypot) return;

    const key = `${guild.id}:${message.author.id}`;
    const session = activeSessions.get(key);
    if (!session || session.actioned || Date.now() > session.expiresAt) return;

    const supabase = require('../supabase/db');

    if (!session.firstMessageChecked) {
        session.firstMessageChecked = true;
        const speed = checkFirstMessageSpeed(session);
        addScore(session, speed.points, speed.dimension);
    }

    const spam = checkNewJoinerSpam(session, settings);
    addScore(session, spam.points, spam.dimension);

    if (session.messageSamples.length < 25) {
        session.messageSamples.push({ content: message.content, ts: Date.now() });
    }
    session.messageTimestamps.push(Date.now());

    const stylo = await checkStylometric(guild, session, settings, supabase);
    addScore(session, stylo.points, stylo.dimension);

    const temporal = await checkTemporalHeatmap(guild, session, settings, supabase);
    addScore(session, temporal.points, temporal.dimension);

    await resolveAndExecuteAction(guild, message.member, session, settings, supabase);
}

module.exports = {
    name: 'antiAlt',
    description: 'Weighted scoring-based alt/raid detection system - fully DB-gated, no fixed action ladder.',
    init,
    handleMemberJoin,
    handleMessage
};