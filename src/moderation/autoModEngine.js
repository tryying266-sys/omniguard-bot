// استدعاء المكونات والدوال المطلوبة
const queries = require('../database/queries');

// استدعاء جميع الإعدادات من ملف cow (تم إزالة التكرار)
const { 
    klab, 
    albagr, 
    alMaeez, 
    cow, 
    donkey, 
    youAreBadBoy,
    goAwayBadThingGo, 
    youAreNotKidding, 
    maeez, 
    goat,
    piggy 
} = require('../config/cow');

// دالة طباعة الأخطاء
const logError = (error) => console.log(error);

// دالة المعالجة والتحديث
async function handleUpdate(req, res) {
    try {
        // استخراج البيانات من req.body داخل نطاق الدالة
        const { tableName, guildId, updates, message } = req.body;

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
const autoModEngine = { handleUpdate };
async function autoModEngineFunction(req,res) {
    return autoModEngine.handleUpdate(req, res);
}
fucnt