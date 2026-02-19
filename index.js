const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const pino = require("pino");
const https = require("https");
const path = require("path");
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
let isStarting = false;
let isShuttingDown = false; // أمر اجباري (إيقاف السيرفر كامل)

// ============================================
// نظام الحماية المتطور (أقصى حد)
// ============================================

// --- حالة الطوارئ العامة ---
let emergencyStop = false; // أمر قف - يوقف الأوامر فقط

// --- تخزين حالة كل مستخدم ---
const userState = new Map();

// --- كلمات السر للأوامر (يمكن تغييرها) ---
const SECRETS = {
    HELP: "نجم",
    PUBLISH: "نجم نشر",
    STATS: "نجم احصا",
    STATUS: "نجم حالة",
    STOP: "نجم قف",
    FORCE_STOP: "نجم اجباري",
    RESTART: "نجم بدء",
    RESUME: "نجم انطلق",
    CANCEL: "إلغاء"
};

// --- نظام مكافحة التكرار والهستيريا المتقدم ---
const userActivity = {
    history: new Map(),      // سجل آخر 10 رسائل لكل مستخدم
    cooldown: new Map(),     // وقت آخر أمر لكل مستخدم
    blocked: new Map(),      // المستخدمين المحظورين
    commandCount: new Map(), // عدد الأوامر في الدقيقة
    
    // إعدادات الحماية (متشددة جداً)
    MAX_HISTORY: 10,
    COMMAND_COOLDOWN: 3000,          // 3 ثواني بين الأوامر
    MAX_COMMANDS_PER_MINUTE: 8,       // 8 أوامر كحد أقصى في الدقيقة
    REPEAT_BLOCK_COUNT: 3,             // 3 مرات تكرار = حظر فوري
    REPEAT_TIME_WINDOW: 20000,         // خلال 20 ثانية
    BLOCK_DURATION: 60 * 60 * 1000,    // 60 دقيقة حظر
    
    // التحقق من الحظر
    isBlocked(jid) {
        if (this.blocked.has(jid)) {
            const blockExpiry = this.blocked.get(jid);
            if (Date.now() < blockExpiry) {
                return true;
            }
            this.blocked.delete(jid);
        }
        return false;
    },
    
    // التحقق من عدد الأوامر في الدقيقة
    checkCommandRate(jid) {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        if (!this.commandCount.has(jid)) {
            this.commandCount.set(jid, []);
        }
        
        let commands = this.commandCount.get(jid).filter(t => t > oneMinuteAgo);
        commands.push(now);
        this.commandCount.set(jid, commands);
        
        return commands.length <= this.MAX_COMMANDS_PER_MINUTE;
    },
    
    // التحقق من التكرار
    checkSpam(jid, text) {
        const now = Date.now();
        
        if (!this.history.has(jid)) {
            this.history.set(jid, []);
        }
        
        let history = this.history.get(jid);
        history.push({ text, time: now });
        
        if (history.length > this.MAX_HISTORY) {
            history.shift();
        }
        
        let repeatCount = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].text === text && now - history[i].time < this.REPEAT_TIME_WINDOW) {
                repeatCount++;
            } else {
                break;
            }
        }
        
        return repeatCount < this.REPEAT_BLOCK_COUNT;
    },
    
    // حظر مستخدم
    blockUser(jid) {
        this.blocked.set(jid, Date.now() + this.BLOCK_DURATION);
        this.history.delete(jid);
        this.cooldown.delete(jid);
        this.commandCount.delete(jid);
        userState.delete(jid);
        console.log(`🚫 تم حظر المستخدم ${jid} لمدة ساعة`);
    },
    
    // تنظيف دوري للبيانات القديمة
    cleanOldData() {
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        
        for (let [jid, history] of this.history) {
            history = history.filter(h => h.time > oneHourAgo);
            if (history.length === 0) {
                this.history.delete(jid);
            } else {
                this.history.set(jid, history);
            }
        }
        
        for (let [jid, times] of this.commandCount) {
            times = times.filter(t => t > oneHourAgo);
            if (times.length === 0) {
                this.commandCount.delete(jid);
            } else {
                this.commandCount.set(jid, times);
            }
        }
        
        console.log("🧹 تم تنظيف البيانات القديمة");
    }
};

// تنظيف دوري كل ساعة
setInterval(() => userActivity.cleanOldData(), 3600000);

// دالة التحقق النهائي قبل معالجة أي رسالة
async function preProcessCheck(jid, text, sender) {
    // إذا كان السيرفر في حالة إيقاف كامل
    if (isShuttingDown) {
        return { allowed: false, reason: "SHUTDOWN" };
    }
    
    // إذا كان الطوارئ العام مفعل
    if (emergencyStop) {
        return { allowed: false, reason: "EMERGENCY" };
    }
    
    // التحقق من الحظر
    if (userActivity.isBlocked(jid)) {
        return { allowed: false, reason: "BLOCKED" };
    }
    
    // التحقق من معدل الأوامر
    if (!userActivity.checkCommandRate(jid)) {
        userActivity.blockUser(jid);
        return { allowed: false, reason: "RATE_LIMIT" };
    }
    
    // التحقق من التكرار
    if (!userActivity.checkSpam(jid, text)) {
        userActivity.blockUser(jid);
        return { allowed: false, reason: "SPAM" };
    }
    
    // التحقق من فترة التباطؤ
    const lastCommand = userActivity.cooldown.get(jid) || 0;
    if (Date.now() - lastCommand < userActivity.COMMAND_COOLDOWN) {
        return { allowed: false, reason: "COOLDOWN" };
    }
    
    return { allowed: true };
}

// --- 1. إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// --- 2. النبض الحديدي ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host && !isShuttingDown) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دالة الإرسال الآمن
async function safeSend(jid, content) {
    try {
        if (sock && sock.user && !emergencyStop && !isShuttingDown) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { 
        console.log("⚠️ فشل الإرسال:", e.message); 
    }
}

// دالة عالمية لتوحيد صيغة الرقم لأي دولة
function formatPhoneNumber(phone) {
    let clean = phone.replace(/\D/g, '');
    
    try {
        let phoneNumber = parsePhoneNumberFromString(clean);
        if (!phoneNumber || !phoneNumber.isValid()) {
            phoneNumber = parsePhoneNumberFromString('+' + clean);
        }
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                local: phoneNumber.nationalNumber,
                full: phoneNumber.number,
                international: phoneNumber.number,
                countryCode: phoneNumber.countryCallingCode,
                isValid: true
            };
        }
    } catch (e) {
        console.log("⚠️ خطأ في تحليل الرقم:", e.message);
    }
    
    console.log("⚠️ استخدام الطريقة اليدوية للرقم:", clean);
    
    while (clean.startsWith('0')) {
        clean = clean.substring(1);
    }
    
    if (clean.startsWith('966') && clean.length > 9) {
        return { local: clean.substring(3), full: '+' + clean, international: '+' + clean, countryCode: '966', isValid: true };
    } else if (clean.startsWith('967') && clean.length > 9) {
        return { local: clean.substring(3), full: '+' + clean, international: '+' + clean, countryCode: '967', isValid: true };
    } else if (clean.startsWith('974') && clean.length > 9) {
        return { local: clean.substring(3), full: '+' + clean, international: '+' + clean, countryCode: '974', isValid: true };
    } else if (clean.length === 9 && clean.startsWith('7')) {
        return { local: clean, full: '+967' + clean, international: '+967' + clean, countryCode: '967', isValid: true };
    } else if (clean.length === 8 && /^[34567]/.test(clean)) {
        return { local: clean, full: '+974' + clean, international: '+974' + clean, countryCode: '974', isValid: true };
    } else if (clean.length === 9 && clean.startsWith('5')) {
        return { local: clean, full: '+966' + clean, international: '+966' + clean, countryCode: '966', isValid: true };
    }
    
    return { local: clean, full: '+' + clean, international: '+' + clean, countryCode: 'unknown', isValid: true };
}

function normalizePhone(phone) {
    const formatted = formatPhoneNumber(phone);
    const withoutPlus = formatted.full.replace('+', '');
    return withoutPlus + "@s.whatsapp.net";
}

// --- 3. استعادة الهوية ---
async function restoreIdentity() {
    try {
        const authDir = './auth_info_stable';
        const credPath = path.join(authDir, 'creds.json');
        
        const sessionDoc = await db.collection('session').doc('session_vip_rashed').get();
        
        if (sessionDoc.exists) {
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            fs.writeFileSync(credPath, JSON.stringify(sessionDoc.data()));
            console.log("✅ تم استعادة الهوية");
            return true;
        }
    } catch (error) {
        console.log("❌ فشل استعادة الهوية");
        return false;
    }
}

async function saveIdentity() {
    try {
        const authDir = './auth_info_stable';
        const credPath = path.join(authDir, 'creds.json');
        
        if (fs.existsSync(credPath)) {
            const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            await db.collection('session').doc('session_vip_rashed').set(creds, { merge: true });
            console.log("✅ تم حفظ الهوية");
        }
    } catch (error) {
        console.log("❌ فشل حفظ الهوية");
    }
}

// --- 4. محرك الأوامر (جميعها سرية وتعمل من أي رقم) ---
async function processCommand(jid, text, sender, isMe) {
    // ===== الحل الجذري لمشكلة التكرار =====
    // تجاهل رسائل البوت الخاصة نهائياً (هذا أهم سطر في الكود)
    if (isMe) {
        console.log("🚫 تجاهل رسالة البوت الخاصة - رقم:", jid);
        return false;
    }
    
    // إذا كان السيرفر في حالة إيقاف كامل
    if (isShuttingDown) {
        if (text === SECRETS.RESTART) {
            isShuttingDown = false;
            emergencyStop = false;
            console.log("✅ تم إعادة تشغيل السيرفر");
            await safeSend(jid, { text: "✅ تم إعادة تشغيل السيرفر بنجاح" });
        }
        return true;
    }
    
    // التحقق المسبق
    const check = await preProcessCheck(jid, text, sender);
    if (!check.allowed) {
        return true;
    }
    
    // تحديث وقت آخر أمر
    userActivity.cooldown.set(jid, Date.now());
    
    // ===== أوامر الطوارئ (تعمل من أي رقم) =====
    
    // أمر اجباري (إيقاف السيرفر كامل)
    if (text === SECRETS.FORCE_STOP) {
        isShuttingDown = true;
        emergencyStop = true;
        userState.clear();
        userActivity.history.clear();
        userActivity.cooldown.clear();
        userActivity.commandCount.clear();
        console.log("💀 تم إيقاف السيرفر كاملاً");
        await safeSend(jid, { text: "💀 *تم إيقاف السيرفر كاملاً*\n📱 أرسل '" + SECRETS.RESTART + "' لإعادة التشغيل" });
        // إنهاء جميع الاتصالات
        if (sock) {
            sock.end();
            sock = null;
        }
        return true;
    }
    
    // أمر قف (إيقاف الأوامر فقط)
    if (text === SECRETS.STOP) {
        emergencyStop = true;
        userState.clear();
        userActivity.history.clear();
        userActivity.cooldown.clear();
        userActivity.commandCount.clear();
        console.log("🚨 تم تفعيل حالة الطوارئ");
        await safeSend(jid, { text: "🚨 *تم إيقاف جميع الأوامر*\n✅ النظام في حالة طوارئ\n📱 أرسل '" + SECRETS.RESUME + "' للعودة" });
        return true;
    }
    
    // أمر العودة من الطوارئ
    if (text === SECRETS.RESUME) {
        emergencyStop = false;
        console.log("✅ تم إلغاء حالة الطوارئ");
        await safeSend(jid, { text: "✅ تم إلغاء حالة الطوارئ\n🌟 البوت يعمل بشكل طبيعي" });
        return true;
    }
    
    // إذا كان الطوارئ مفعل، لا تستجيب لأي أوامر أخرى
    if (emergencyStop) {
        return true;
    }
    
    const currentState = userState.get(jid);
    
    // إذا كان المستخدم في حالة تفاعلية
    if (currentState) {
        // التحقق من انتهاء صلاحية الحالة (15 دقيقة فقط)
        if (Date.now() - currentState.timestamp > 15 * 60 * 1000) {
            userState.delete(jid);
            await safeSend(jid, { text: "⏰ انتهت صلاحية الجلسة. أرسل '" + SECRETS.PUBLISH + "' مرة أخرى." });
            return true;
        }
        
        // أمر الإلغاء
        if (text === SECRETS.CANCEL) {
            userState.delete(jid);
            await safeSend(jid, { text: "❌ تم إلغاء العملية بنجاح." });
            return true;
        }
        
        // معالجة خطوات النشر
        if (currentState.command === "نشر") {
            // الخطوة 1: استلام الرابط
            if (currentState.step === "waiting_link") {
                if (!text.startsWith('http')) {
                    await safeSend(jid, { text: "❌ رابط غير صحيح. أرسل رابطاً يبدأ بـ http\nأو أرسل '" + SECRETS.CANCEL + "' للإلغاء." });
                    return true;
                }
                currentState.link = text;
                currentState.step = "waiting_desc";
                currentState.timestamp = Date.now();
                userState.set(jid, currentState);
                await safeSend(jid, { text: "✅ تم استلام الرابط.\nالآن أرسل *الوصف*:" });
                return true;
            }
            
            // الخطوة 2: استلام الوصف
            if (currentState.step === "waiting_desc") {
                currentState.desc = text;
                currentState.step = "waiting_target";
                currentState.timestamp = Date.now();
                userState.set(jid, currentState);
                
                const usersSnapshot = await db.collection('users').get();
                const appNames = [...new Set(usersSnapshot.docs.map(d => d.data().appName))].filter(name => name && name !== 'default');
                
                let menu = "🎯 *اختر الجمهور المستهدف:*\n\n";
                menu += "0 - 🌐 *الجميع*\n\n";
                appNames.forEach((app, index) => {
                    menu += `${index + 1} - 📱 *${app}*\n`;
                });
                menu += "\n💡 أرسل رقم الخيار المطلوب.\n❌ أرسل '" + SECRETS.CANCEL + "' للإلغاء.";
                
                await safeSend(jid, { text: menu });
                return true;
            }
            
            // الخطوة 3: التنفيذ النهائي
            if (currentState.step === "waiting_target") {
                const usersSnapshot = await db.collection('users').get();
                const appNames = [...new Set(usersSnapshot.docs.map(d => d.data().appName))].filter(name => name && name !== 'default');
                
                let targets = [];
                let targetDescription = "";
                
                if (text === "0") { 
                    targets = usersSnapshot.docs;
                    targetDescription = "الجميع";
                } else {
                    const idx = parseInt(text) - 1;
                    if (isNaN(idx) || idx < 0 || idx >= appNames.length) {
                        await safeSend(jid, { text: "❌ رقم غير صحيح. أرسل '" + SECRETS.CANCEL + "' للإلغاء." });
                        return true;
                    }
                    const selectedApp = appNames[idx];
                    targets = usersSnapshot.docs.filter(d => d.data().appName === selectedApp);
                    targetDescription = `تطبيق *${selectedApp}*`;
                }
                
                await safeSend(jid, { text: `🚀 جاري النشر لـ ${targets.length} مستخدم...` });
                
                let successCount = 0;
                let failCount = 0;
                
                for (const d of targets) {
                    try {
                        const userPhone = d.data().phone;
                        await safeSend(normalizePhone(userPhone), { 
                            text: `📢 *تحديث جديد!*\n\n${currentState.desc}\n\n🔗 ${currentState.link}` 
                        });
                        successCount++;
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } catch (e) {
                        failCount++;
                    }
                }
                
                userState.delete(jid);
                
                const report = `✅ *تم النشر بنجاح!*\n\n📊 *الإحصائيات:*\n✓ تم الإرسال: ${successCount}\n✗ فشل: ${failCount}\n👥 المجموع: ${targets.length}\n🎯 المستهدف: ${targetDescription}`;
                await safeSend(jid, { text: report });
                return true;
            }
        }
        return true;
    }
    
    // الأوامر الرئيسية (كلها تعمل من أي رقم)
    if (text === SECRETS.HELP || text === SECRETS.HELP + " مساعدة") {
        await safeSend(jid, { text: `🌟 *الأوامر السرية:*\n\n1️⃣ *${SECRETS.PUBLISH}* - نشر إعلان\n2️⃣ *${SECRETS.STATS}* - إحصائيات\n3️⃣ *${SECRETS.STATUS}* - حالة البوت\n4️⃣ *${SECRETS.STOP}* - إيقاف الطوارئ\n5️⃣ *${SECRETS.FORCE_STOP}* - إيقاف السيرفر\n\n💡 أرسل *${SECRETS.CANCEL}* أثناء النشر للإلغاء.` });
        return true;
    }
    
    if (text === SECRETS.PUBLISH) {
        userState.set(jid, { command: "نشر", step: "waiting_link", timestamp: Date.now() });
        await safeSend(jid, { text: "🔗 *خطوة 1/3*\nأرسل *الرابط* الآن:" });
        return true;
    }
    
    if (text === SECRETS.STATS) {
        const usersSnap = await db.collection('users').get();
        const appStats = {};
        usersSnap.docs.forEach(doc => {
            const appName = doc.data().appName || 'غير معروف';
            appStats[appName] = (appStats[appName] || 0) + 1;
        });
        
        let statsText = "📊 *إحصائيات المستخدمين:*\n\n";
        statsText += `👥 *الإجمالي:* ${usersSnap.size}\n\n📱 *حسب التطبيق:*\n`;
        for (const [app, count] of Object.entries(appStats)) {
            statsText += `• ${app}: ${count} مستخدم\n`;
        }
        await safeSend(jid, { text: statsText });
        return true;
    }
    
    if (text === SECRETS.STATUS) {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const emergency = emergencyStop ? "🚨 مفعلة" : "✅ طبيعي";
        const shutdown = isShuttingDown ? "💀 متوقف" : "✅ يعمل";
        await safeSend(jid, { text: `⚡ *حالة البوت:*\n\n✅ متصل\n⏱️ ${hours} ساعة ${minutes} دقيقة\n🚦 الطوارئ: ${emergency}\n💻 السيرفر: ${shutdown}` });
        return true;
    }
    
    return false;
}

async function startBot() {
    if (isStarting) return;
    isStarting = true;
    
    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    
    await restoreIdentity();
    
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false, 
        syncFullHistory: false
    });
    
    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        await saveIdentity(); 
    });
    
    // معالجة الرسائل الواردة
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            
            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe; // يتحقق هل الرسالة من البوت نفسه
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
            
            if (!text) return;
            
            await processCommand(jid, text, sender, isMe);
            
        } catch (e) { console.log("❌ خطأ:", e.message); }
    });
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            emergencyStop = false;
            isShuttingDown = false;
            console.log("🚀 البوت متصل");
        }
        if (connection === 'close') {
            isStarting = false;
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut && !isShuttingDown) {
                setTimeout(() => startBot(), 10000);
            }
        }
    });
}

// --- تخزين مؤقت في الذاكرة ---
const tempStorage = new Map();

// --- API (نفس الكود السابق) ---
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName } = req.query;
        console.log("=".repeat(50));
        console.log("🔍 فحص الجهاز");
        console.log("=".repeat(50));
        console.log("معرف الجهاز:", id);
        console.log("اسم التطبيق:", appName);
        
        const snap = await db.collection('users')
            .where("deviceId", "==", id)
            .where("appName", "==", appName)
            .get();
        
        if (!snap.empty) {
            console.log(`✅ جهاز موجود مسجل لهذا التطبيق`);
            return res.status(200).send("SUCCESS");
        } else {
            console.log(`❌ جهاز غير مسجل لهذا التطبيق`);
            return res.status(404).send("NOT_FOUND");
        }
    } catch (error) {
        console.error("❌ خطأ في check-device:", error);
        res.status(500).send("ERROR");
    }
});

app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        
        console.log("=".repeat(50));
        console.log("📱 طلب كود جديد");
        console.log("=".repeat(50));
        console.log("الرقم المرسل من التطبيق:", phone);
        
        const formatted = formatPhoneNumber(phone);
        const localPhone = formatted.local;
        const fullPhone = formatted.full.replace('+', '');
        const countryCode = formatted.countryCode;
        
        console.log("الرقم بعد التنسيق (محلي):", localPhone);
        console.log("الرقم بعد التنسيق (كامل):", fullPhone);
        console.log("مفتاح الدولة:", countryCode);
        console.log("الاسم:", name);
        console.log("التطبيق:", appName);
        console.log("معرف الجهاز:", deviceId);
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        const storageKey = localPhone + "_" + appName;
        
        tempStorage.set(storageKey, {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            localPhone: localPhone,
            fullPhone: fullPhone,
            countryCode: countryCode,
            timestamp: Date.now()
        });
        
        await db.collection('temp_codes').doc(storageKey).set({
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            localPhone: localPhone,
            fullPhone: fullPhone,
            countryCode: countryCode,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`📦 تم تخزين الكود ${otp} للرقم ${fullPhone} للتطبيق ${appName}`);
        console.log(`📱 جاري إرسال الكود إلى: ${fullPhone}`);
        
        await safeSend(normalizePhone(fullPhone), { 
            text: `🔐 كود تفعيل تطبيق ${appName} هو: *${otp}*` 
        });
        
        console.log(`✅ تم إرسال الكود بنجاح`);
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ في request-otp:", error);
        res.status(500).send("Error");
    }
});

app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        
        console.log("=".repeat(50));
        console.log("🔍 محاولة تحقق");
        console.log("=".repeat(50));
        console.log("الرقم المرسل من التطبيق:", phone);
        
        const formatted = formatPhoneNumber(phone);
        const localPhone = formatted.local;
        const fullPhone = formatted.full.replace('+', '');
        
        console.log("الرقم بعد التنسيق (محلي):", localPhone);
        console.log("الرقم بعد التنسيق (كامل):", fullPhone);
        console.log("الكود المرسل من التطبيق:", code);
        
        const inputCode = code.toString().trim();
        
        console.log(`🔍 البحث عن الكود للرقم: ${localPhone}`);
        
        let foundData = null;
        let foundKey = null;
        let source = "memory";
        
        for (let [key, value] of tempStorage.entries()) {
            if (key.startsWith(localPhone + "_") && value.otp.toString().trim() === inputCode) {
                foundData = value;
                foundKey = key;
                break;
            }
        }
        
        if (!foundData) {
            console.log(`🔍 البحث في Firebase`);
            const fbSnapshot = await db.collection('temp_codes').get();
            
            for (const doc of fbSnapshot.docs) {
                const docId = doc.id;
                if (docId.startsWith(localPhone + "_")) {
                    const data = doc.data();
                    if (data.otp.toString().trim() === inputCode) {
                        foundData = data;
                        foundKey = docId;
                        source = "firebase";
                        break;
                    }
                }
            }
        }
        
        if (!foundData) {
            console.log(`❌ لا يوجد كود صحيح للرقم: ${localPhone}`);
            return res.status(401).send("FAIL");
        }
        
        console.log(`📦 الكود المخزن: ${foundData.otp} (المصدر: ${source})`);
        
        const now = Date.now();
        const timestamp = foundData.timestamp || (foundData.createdAt?.toDate?.()?.getTime() || now);
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        console.log(`⏰ عمر الكود: ${diffMinutes.toFixed(1)} دقيقة`);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            if (foundKey) {
                tempStorage.delete(foundKey);
                await db.collection('temp_codes').doc(foundKey).delete();
            }
            return res.status(401).send("FAIL");
        }
        
        console.log(`✅ تحقق ناجح! الكود صحيح`);
        
        const userFullPhone = foundData.fullPhone || fullPhone;
        const userKey = userFullPhone + "_" + foundData.appName;
        
        await db.collection('users').doc(userKey).set({ 
            name: foundData.name || 'مستخدم',
            phone: userFullPhone,
            localPhone: foundData.localPhone,
            countryCode: foundData.countryCode || 'unknown',
            appName: foundData.appName || 'default',
            deviceId: foundData.deviceId || '',
            verifiedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        if (foundKey) {
            tempStorage.delete(foundKey);
            await db.collection('temp_codes').doc(foundKey).delete();
        }
        
        await safeSend(normalizePhone(myNumber), { 
            text: `🆕 مستخدم جديد: ${userFullPhone}\n📱 التطبيق: ${foundData.appName}\n🌍 الدولة: ${foundData.countryCode || 'unknown'}` 
        });
        
        console.log(`🎉 تم تسجيل المستخدم بنجاح للتطبيق ${foundData.appName}`);
        return res.status(200).send("SUCCESS");
        
    } catch (error) {
        console.error("❌ خطأ في verify-otp:", error);
        res.status(500).send("FAIL");
    }
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => {
    if (qrImage === "DONE") {
        res.send("✅ البوت يعمل");
    } else if (qrImage) {
        res.send(`<img src="${qrImage}">`);
    } else {
        res.send("⏳ جاري التحميل...");
    }
});

app.listen(process.env.PORT || 10000, () => {
    console.log("=".repeat(50));
    console.log(`🚀 السيرفر يعمل على المنفذ ${process.env.PORT || 10000}`);
    console.log("=".repeat(50));
    startBot();
});
