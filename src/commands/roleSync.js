// ============================================================================
// roleSync.js - Dashboard Role Management (Exact-ID Sync, No Fuzzy Search)
// ============================================================================
// [NEW] هذا الملف خاص حصراً بصفحة user-profile بالداشبورد (كرت Manage User
// Roles). يختلف عن roleadd.js عمداً - roleadd.js مبني لحالة الشات (مشرف
// يكتب اسم رتبة يدوياً، يحتاج بحث ذكي/تقريبي لتفادي الأخطاء الإملائية).
// هون الداشبورد يرسل قائمة Role IDs دقيقة من dropdown حقيقي (Smart Binding)
// - فمافيه داعي ولا مبرر أمني لأي تخمين بالاسم؛ التعامل يكون بالـ ID فقط.
//
// ⚠️ IMPORTANT: هذا الملف لازم يُضاف لقائمة EXCLUDED_FILES بملف
// commandhandler.js (نفس صف AutoMod.js/AntiAlt.js/GRS.js/custom.js/
// AutoRole.js/welcome.js/Rolemanagement.js/getroles.js) - لأنه ما يصدّر
// run(message, dbUtils) إطلاقاً (مو أمر شات، أمر داشبورد فقط). لو ما انضاف
// للاستثناء، الـ Auto-Loader بيسجله كأمر باسم "rolesync" وأي محاولة تنفيذه
// من الشات هتطيح بخطأ (command.run is not a function).
// ============================================================================

/**
 * CORE LOGIC: syncMemberRoles
 * يقارن الرتب الحالية الفعلية للعضو (من ديسكورد مباشرة، مو من أي كاش) مع
 * القائمة المطلوبة القادمة من التاغات بالداشبورد، ويطبّق الفرق فقط:
 * - رتبة موجودة بالقائمة المطلوبة وناقصة عند العضو -> تُضاف
 * - رتبة موجودة عند العضو وغير موجودة بالقائمة المطلوبة -> تُحذف
 * رتب لا تتغير (موجودة بالطرفين أو غير موجودة بالطرفين) لا تُلمس إطلاقاً.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} targetId - آيدي العضو المستهدف
 * @param {string[]} desiredRoleIds - كل الرتب اللي المفروض العضو يملكها بعد الحفظ (من التاغات)
 * @param {import('discord.js').User} moderator - مين نفذ العملية (من الداشبورد، مؤقتاً null لحد ما يخلص OAuth2)
 * @param {Object} dbUtils
 * @returns {Promise<{success: boolean, added?: string[], removed?: string[], skipped?: string[], error?: string}>}
 */
async function syncMemberRoles(guild, targetId, desiredRoleIds, moderator, dbUtils) {
    try {
        const targetMember = await guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) return { success: false, error: "Member not found in this server." };

        const botMember = guild.members.me;

        // الرتب الحالية الفعلية للعضو الآن (مصدر الحقيقة الوحيد - مباشرة من ديسكورد)
        const currentRoleIds = targetMember.roles.cache
            .filter(r => r.id !== guild.id) // استبعاد @everyone (آيديها = آيدي السيرفر نفسه)
            .map(r => r.id);

        const desired = new Set(desiredRoleIds || []);
        const current = new Set(currentRoleIds);

        const toAdd = [...desired].filter(id => !current.has(id));
        const toRemove = [...current].filter(id => !desired.has(id));

        const added = [];
        const removed = [];
        const skipped = []; // رتب ما قدر البوت يتعامل معها (تسلسل هرمي/صلاحيات)

        // --- التحقق من كل رتبة قبل التنفيذ (Hierarchy Safety) ---
        for (const roleId of [...toAdd, ...toRemove]) {
            const role = guild.roles.cache.get(roleId);

            // رتبة محذوفة أصلاً من السيرفر أو آيدي غير صالح
            if (!role) { skipped.push(roleId); continue; }

            // نفس فحص roleadd.js: البوت ما يقدر يتحكم برتبة أعلى من أو تساوي أعلى رتبة عنده
            if (!role.editable || botMember.roles.highest.position <= role.position) {
                skipped.push(roleId);
                continue;
            }
        }

        // --- التنفيذ الفعلي (رتبة رتبة، عشان لو وحدة فشلت الباقي يكمل) ---
        for (const roleId of toAdd) {
            if (skipped.includes(roleId)) continue;
            try {
                await targetMember.roles.add(roleId, `Dashboard: Role sync by ${moderator?.tag || 'Dashboard'}`);
                added.push(roleId);
            } catch (err) {
                console.error(`[RoleSync Error] Failed to add role ${roleId}:`, err.message);
                skipped.push(roleId);
            }
        }

        for (const roleId of toRemove) {
            if (skipped.includes(roleId)) continue;
            try {
                await targetMember.roles.remove(roleId, `Dashboard: Role sync by ${moderator?.tag || 'Dashboard'}`);
                removed.push(roleId);
            } catch (err) {
                console.error(`[RoleSync Error] Failed to remove role ${roleId}:`, err.message);
                skipped.push(roleId);
            }
        }

        // --- تسجيل اللوق (سطر واحد يلخص التغيير، بدل سطر لكل رتبة) ---
        if ((added.length > 0 || removed.length > 0) && dbUtils?.addInfraction) {
            const summary = `Roles synced via Dashboard | Added: ${added.length} | Removed: ${removed.length}`;
            await dbUtils.addInfraction(
                guild.id,
                targetId,
                moderator?.id || null,
                'roleadd', // نفس action_type المستخدم أصلاً بجدول log_moderation (راجع CHECK constraint) - ما يوجد نوع "rolesync" منفصل بالسكيما
                summary,
                null,
                targetMember.user.tag
            );
        }

        return { success: true, added, removed, skipped };

    } catch (err) {
        console.error('[RoleSync Engine Error]:', err);
        return { success: false, error: "Internal error during role sync." };
    }
}

module.exports = {
    syncMemberRoles
};