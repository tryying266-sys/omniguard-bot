// ============================================================================
// authMiddleware.js - Shared Dashboard Auth Layer
// ============================================================================
// طبقة الهوية والصلاحيات الموحّدة - يستخدمها apiServer.js (الروتات المباشرة)
// وapiRouter.js (Universal Sync + الروتات المخصصة) معاً، عشان يكون فيه تطبيق
// واحد بس لمنطق "مين هذا المستخدم، وهل مسموح له يسوي هذا الإجراء".
//
// [SECURITY REWRITE] يحل محل نظام role_level المخزّن بجدول dashboard_staff:
// الصلاحية الحين تُفحص حياً من ديسكورد نفسه وقت كل طلب، بدل قيمة قديمة
// ممكن تكون ما عادت تعكس واقع صلاحيات العضو الفعلية.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const { PermissionsBitField } = require('discord.js');

const supabaseAuthClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// [FIX] Race Condition: لما الفرونت يطلق عدة طلبات متوازية (Promise.all
// وقت حفظ صفحة فيها أكثر من جدول إعدادات)، كل طلب كان يدخل requireDiscordPermission
// لحاله ويسوي fetch مستقل لنفس العضو لو الكاش فاضي - يعني 5-6 نداءات
// متزامنة لنفس العضو بنفس اللحظة، بعضها يتصادم مع Rate Limit ويفشل. هذا
// الكاش المؤقت (بالذاكرة، لمدة ثواني فقط) يخلي كل الطلبات المتزامنة لنفس
// العضو تتشارك نفس الـ Promise الواحد - أول طلب يبدأ الـ fetch الفعلي،
// والباقي ينتظرون نفس النتيجة بدل ما يكرروا النداء.
const inFlightMemberFetches = new Map();

function fetchGuildMemberDeduped(guild, discordId) {
    const key = `${guild.id}:${discordId}`;

    if (inFlightMemberFetches.has(key)) {
        return inFlightMemberFetches.get(key);
    }

    const cached = guild.members.cache.get(discordId);
    if (cached) return Promise.resolve(cached);

    const promise = guild.members.fetch(discordId)
        .catch(() => null)
        .finally(() => {
            // ننظف بعد ما ينتهي - الطلب الجاي يقرأ من guild.members.cache
            // (اتحدثت تلقائياً بعد fetch ناجح) أو يبدأ دورة جديدة.
            inFlightMemberFetches.delete(key);
        });

    inFlightMemberFetches.set(key, promise);
    return promise;
}

/**
 * يحدد هوية المستخدم من توكن Supabase الحقيقي (هيدر X-User-Token) ويحطها
 * بـ req.dashboardUser. ما يرفض الطلب لو فشل أو ما فيه توكن - الرفض الفعلي
 * يصير لاحقاً بـ requireDiscordPermission، حسب حاجة كل route.
 */
async function attachDashboardUser(req, res, next) {
    const userToken = req.headers['x-user-token'];
    if (!userToken) {
        req.dashboardUser = null;
        return next();
    }

    try {
        const { data, error } = await supabaseAuthClient.auth.getUser(userToken);
        if (error || !data?.user) {
            req.dashboardUser = null;
            return next();
        }

        const discordIdentity = data.user.identities?.find(i => i.provider === 'discord');
        const discordId = discordIdentity?.id || data.user.user_metadata?.provider_id || null;

        req.dashboardUser = {
            supabaseUid: data.user.id,
            discordId,
            username: data.user.user_metadata?.full_name || data.user.user_metadata?.name || null
        };
    } catch (err) {
        console.error('[Auth] Failed to verify user token:', err.message);
        req.dashboardUser = null;
    }

    next();
}

/**
 * [SECURITY BOUNDARY] هذي هي طبقة الحماية الحقيقية الحين. تتحقق حياً من
 * ديسكورد: هل هذا المستخدم عضو بهذا السيرفر، وهل عنده وحدة على الأقل من
 * الصلاحيات المطلوبة (OR مو AND). صاحب السيرفر وأي عضو عنده Administrator
 * يمرّون دايماً، بغض النظر عن الصلاحية المحددة - نفس منطق ديسكورد نفسه.
 *
 * permissionFlags: صلاحية وحدة أو مصفوفة صلاحيات.
 * تقرأ guildId من req.guildId (لو موجود مسبقاً) أو req.params.guildId -
 * ما تحتاج requireGuildId قبلها بالضرورة.
 */
function requireDiscordPermission(permissionFlags) {
    const flags = Array.isArray(permissionFlags) ? permissionFlags : [permissionFlags];

    return async (req, res, next) => {
        if (!req.dashboardUser) {
            return res.status(401).json({ error: 'Unauthorized: No valid user session provided.' });
        }
        if (!req.dashboardUser.discordId) {
            return res.status(400).json({ error: 'Could not resolve your Discord identity from the session.' });
        }

        const guildId = req.guildId || req.params.guildId || req.body?.guildId;
        if (!guildId) {
            return res.status(400).json({ error: 'Missing Required Parameter: guildId' });
        }
        req.guildId = guildId;

        try {
            const client = require('../index');
            if (!client.isReady()) {
                return res.status(503).json({ error: 'Bot is not ready yet. Please try again in a moment.' });
            }

             // [FIX] بدل .fetch() المباشر (يجبر HTTP request لديسكورد كل مرة، حتى لو
// المعلومة موجودة أصلاً بالكاش) - نقرأ من الكاش أولاً. البوت أصلاً متصل
// بالسيرفر عبر الـ Gateway ويعرف guilds/members حياً بدون أي طلب إضافي -
// هذا التغيير لوحده يقلل ضغط Discord API بشكل كبير، خصوصاً وقت طلبات
// متوازية (Promise.all بالفرونت وقت حفظ صفحة فيها أكثر من جدول إعدادات).
const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
                return res.status(404).json({ error: 'Bot is not in this guild' });
            }

            const member = await fetchGuildMemberDeduped(guild, req.dashboardUser.discordId);
            if (!member) {
                return res.status(403).json({ error: 'You are not a member of this Discord server.' });
            }

            const isOwner = member.id === guild.ownerId;
            const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
            const hasRequiredPermission = flags.some(flag => member.permissions.has(flag));

            if (!isOwner && !isAdmin && !hasRequiredPermission) {
                return res.status(403).json({ error: 'You do not have the required Discord permission for this action.' });
            }

            // يُخزَّن عشان أي route ثاني (زي resolveDashboardContext) ما يعيد
            // نفس الـ fetch مرة ثانية لنفس العضو بنفس الطلب.
            req.dashboardUser.discordMember = member;
            next();
        } catch (err) {
            console.error('[Auth] requireDiscordPermission check failed:', err.message);
            res.status(500).json({ error: 'Failed to verify Discord permissions' });
        }
    };
}

module.exports = { attachDashboardUser, requireDiscordPermission, PermissionsBitField };