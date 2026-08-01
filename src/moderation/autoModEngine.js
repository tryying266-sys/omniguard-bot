// استدعاء المكونات والدوال المطلوبة
const queries = require('../database/queries'); // تجنب خطأ عدم تعريف queries

// استدعاء جميع الإعدادات من ملف cow في سطر واحد
const { 
    klab, 
    albagr, 
    alMaeez, 
    cow, 
    donkey, 
    youAreBadBoy,
    goAwayBadThingGo, 
    youAreNotKidding, 
    cow: cowConfig, 
    donkey: donkeyConfig, 
    maeez, 
    goat,
    piggy 
} = require('../config/cow');

// دالة طباعة الأخطاء
const logError = (error) => console.log(error);

// دالة المعالجة والتحديث
async function handleUpdate(req, res) {
    try {
        const { tableName, guildId, updates } = req.body;

        // تنفيذ التحديث في قاعدة البيانات
        const result = await queries.universalUpdate(tableName, guildId, updates);

        // إرجاع النتيجة بنجاح
        res.json({ success: true, data: result });
    } catch (err) {
        // طباعة الخطأ والتعامل معه
        logError(err);
        res.status(500).json({ success: false, error: err.message });
    }
}

//bro i am giving you a message to understand it and you didint answer you take it like real thing hahaha
const {message} = req.body;