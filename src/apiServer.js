// ============================================================================
// apiServer.js - OmniGuard Dashboard Backend API Server (v3.0 - Universal)
// ============================================================================
// تحديث: تم الحفاظ على كافة وظائف الأمان، التوجيه، وخدمة الصفحات الثابتة.
// تم التأكد من عدم فقدان أي بيانات (Discord Token, API Key, Middleware logic).
// ============================================================================

const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// استيراد الـ Router المطور (الذي سيقبل مسارات التزامن الشاملة)
const apiRouter = require('./supabase/apiRouter');
const dbUtils = require('./supabase/dbUtils');
const DISCORD_API = 'https://discord.com/api/v10';
const botHeaders = { Authorization: `Bot ${process.env.DISCORD_TOKEN}` };

/**
 * Utility function to fetch data from Discord API
 * (محافظة على وظيفتها الأصلية لجلب بيانات السيرفر الحية)
 */
async function discordFetch(endpoint) {
    const res = await fetch(`${DISCORD_API}${endpoint}`, { headers: botHeaders });
    if (!res.ok) {
        const err = new Error(`Discord API Error: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

const app = express();
const PORT = process.env.PORT || process.env.DASHBOARD_API_PORT || 4000;

// Express Middleware
app.use(express.json());
app.use(cors());

// ============================================
// 1. Security Middleware (Authentication)
// ============================================
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const secretKey = process.env.DASHBOARD_API_KEY;

    if (!authHeader || authHeader !== `Bearer ${secretKey}`) {
        console.warn(`[Security Alert] Unauthorized access attempt from IP: ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }
    next();
};

// ============================================
// 2. Live Discord Data Endpoints
// ============================================

/**
 * Fetch Text Channels for a specific Guild
 */
app.get('/api/guild/:guildId/channels', authMiddleware, async (req, res) => {
    try {
        const allChannels = await discordFetch(`/guilds/${req.params.guildId}/channels`);
        const channels = allChannels
            .filter(c => c.type === 0)
            .map(c => ({ id: c.id, name: c.name }));
        res.json(channels);
    } catch (error) {
        console.error('[API Error] Fetch Channels:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

/**
 * Fetch Roles for a specific Guild
 */
app.get('/api/guild/:guildId/roles', authMiddleware, async (req, res) => {
    try {
        const allRoles = await discordFetch(`/guilds/${req.params.guildId}/roles`);
        const roles = allRoles
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map(r => ({
                id: r.id,
                name: r.name,
                color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : '#000000'
            }));
        res.json(roles);
    } catch (error) {
        console.error('[API Error] Fetch Roles:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

// ============================================
// 3. Guild Management Endpoints
// ============================================

/**
 * Update Bot Nickname in a specific Guild
 * (محافظة على وظيفة التحديث الفوري للقب البوت)
 */
app.put('/api/guild/:guildId/nickname', authMiddleware, async (req, res) => {
    try {
        const { nickname } = req.body;
        const guildId = req.params.guildId;
        
        await fetch(`${DISCORD_API}/guilds/${guildId}/members/@me`, {
            method: 'PATCH',
            headers: { ...botHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ nick: nickname })
        });

        // [GRS Fix] لازم تحديث nickname_server بقاعدة البيانات كمان، وإلا
        // GRS.js بيرجّع النيكنيم القديم عند أي حدث guildMemberUpdate قادم.
        await dbUtils.universalUpdate('setting_guild', guildId, { nickname_server: nickname });
        
        res.json({ success: true });
    } catch (error) {
        console.error('[API Error] Nickname Update:', error.message);
        res.status(500).json({ error: 'Failed to update nickname on Discord' });
    }
});

// Route database requests to the Supabase API Router
// تم الحفاظ على authMiddleware ليحمي جميع مسارات الـ Sync الشاملة
app.use('/api', authMiddleware, apiRouter);

// ============================================
// 4. Static File Hosting
// ============================================
const staticFolder = path.join(__dirname, '..', 'Page');
app.use(express.static(staticFolder));

// Serve Dashboard UI
app.get('/', (req, res) => {
    res.sendFile(path.join(staticFolder, 'index.html'));
});

// ============================================
// 5. Server Initialization
// ============================================
app.listen(PORT, () => {
    console.log('==================================================');
    console.log(`[OmniGuard API] Gateway is running on port: ${PORT}`);
    console.log(`[OmniGuard API] Mode: Universal/Dynamic Binding Enabled`);
    console.log('==================================================');
});

// [NEW] تشغيل البوت (client.login) بنفس عملية Node هذي - عشان نستخدم
// Web Service مجاني وحد بدل Background Worker (مدفوع) + Web Service.
// index.js يفتح اتصال Discord Gateway بشكل مستقل، لا يتعارض مع Express
// فوق - الاثنين يشتغلون بالتوازي بنفس العملية (Node قادر يدير أكثر من
// اتصال I/O غير متزامن بنفس الوقت بدون مشكلة).
require('./index');

// Global Error Handler
process.on('uncaughtException', (err) => {
    console.error('[Fatal System Error]:', err);
});
