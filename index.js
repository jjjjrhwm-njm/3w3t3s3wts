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

// رقم المالك
const OWNER_NUMBER = process.env.OWNER_NUMBER || "966554526287";

// متغيرات تيليجرام
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// التخزين المؤقت
const pendingVerifications = new Map(); // مفتاح: deviceId_appName, قيمة: {otp, phone, name, timestamp}

// إعداد Firebase
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// النبض الحديدي
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دالة الإرسال الآمن
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال"); }
}

// دالة إرسال تيليجرام
async function sendTelegram(chatId, text) {
    try {
        await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: chatId, 
                text: text, 
                parse_mode: 'Markdown' 
            })
        });
    } catch (e) { console.log("⚠️ فشل إرسال تيليجرام"); }
}

// دالة ذكية لتنسيق الأرقام (محسنة)
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    if (!cleaned || cleaned.length < 7) {
        return { isValid: false };
    }

    // محاولة باستخدام المكتبة
    try {
        const phoneNumber = parsePhoneNumberFromString(phone);
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                nationalNumber: phoneNumber.nationalNumber,
                countryCode: phoneNumber.countryCallingCode,
                fullNumber: phoneNumber.number,
                isValid: true
            };
        }
    } catch (e) {}

    // تحليل يدوي للمفاتيح الشائعة
    const countryCodes = [
        { code: '966', length: 9 }, // السعودية
        { code: '20', length: 10 }, // مصر
        { code: '971', length: 9 }, // الإمارات
        { code: '965', length: 8 }, // الكويت
        { code: '974', length: 8 }, // قطر
        { code: '973', length: 8 }, // البحرين
        { code: '968', length: 8 }, // عمان
        { code: '962', length: 9 }, // الأردن
        { code: '964', length: 10 }, // العراق
        { code: '963', length: 9 }, // سوريا
        { code: '961', length: 8 }, // لبنان
        { code: '967', length: 9 }, // اليمن
        { code: '213', length: 9 }, // الجزائر
        { code: '212', length: 9 }, // المغرب
        { code: '216', length: 8 }, // تونس
        { code: '218', length: 9 }, // ليبيا
        { code: '249', length: 9 }, // السودان
        { code: '92', length: 10 }, // باكستان
        { code: '93', length: 9 }, // أفغانستان
        { code: '98', length: 10 }, // إيران
        { code: '90', length: 10 }, // تركيا
        { code: '91', length: 10 }, // الهند
        { code: '880', length: 10 }, // بنجلاديش
    ];

    // البحث عن مفتاح الدولة
    for (const country of countryCodes) {
        if (cleaned.startsWith(country.code)) {
            const nationalPart = cleaned.substring(country.code.length);
            if (nationalPart.length === country.length) {
                return {
                    nationalNumber: nationalPart,
                    countryCode: country.code,
                    fullNumber: `+${country.code}${nationalPart}`,
                    isValid: true
                };
            }
        }
    }

    return { isValid: false };
}

function getJidFromPhone(phone) {
    const formatted = formatPhoneNumber(phone);
    return formatted.fullNumber.replace('+', '') + "@s.whatsapp.net";
}

// استعادة الهوية
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

// تشغيل البوت
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

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 البوت متصل");
        }
        if (connection === 'close') {
            isStarting = false;
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) {
                setTimeout(() => startBot(), 10000);
            }
        }
    });
}

// دالة النشر عبر الواتساب
async function publishToWhatsApp(appName, link, description, chatId) {
    try {
        let query = db.collection('users');
        if (appName !== "الجميع") {
            query = query.where("appName", "==", appName);
        }
        
        const usersSnapshot = await query.get();
        const targets = usersSnapshot.docs;
        
        await sendTelegram(chatId, `🚀 جاري النشر لـ ${targets.length} مستخدم ${appName !== "الجميع" ? `من تطبيق ${appName}` : ''}...`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (const d of targets) {
            try {
                const userPhone = d.data().phone;
                await safeSend(getJidFromPhone(userPhone), { 
                    text: `📢 *تحديث جديد!*\n\n${description}\n\n🔗 ${link}` 
                });
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (e) {
                failCount++;
            }
        }
        
        const report = `✅ *تم النشر بنجاح!*\n\n📊 *الإحصائيات:*\n✓ تم الإرسال: ${successCount}\n✗ فشل: ${failCount}\n👥 المجموع: ${targets.length}`;
        await sendTelegram(chatId, report);
        
    } catch (error) {
        await sendTelegram(chatId, `❌ خطأ في النشر: ${error.message}`);
    }
}

// إعداد Webhook تيليجرام
async function setupTelegramWebhook() {
    if (!TELEGRAM_BOT_TOKEN) return;
    
    const webhookUrl = `https://threew3t3s3wts.onrender.com/telegram-webhook`;
    try {
        await fetch(`${TELEGRAM_API_URL}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhookUrl })
        });
        console.log("✅ Webhook تيليجرام تم إعداده");
    } catch (error) {
        console.log("⚠️ فشل إعداد webhook:", error.message);
    }
}

// ============================================
// API المتقدم - نقطة واحدة للتحقق
// ============================================

app.get("/api", async (req, res) => {
    try {
        const { action, phone, name, deviceId, appName, appVersion, code } = req.query;
        
        console.log("=".repeat(50));
        console.log(`📱 طلب: ${action}`, { phone, name, deviceId, appName, appVersion, code });
        console.log("=".repeat(50));
        
        // نقطة التحقق من الجهاز
        if (action === "check") {
            if (!deviceId || !appName) {
                return res.status(400).send("MISSING_PARAMS");
            }
            
            // البحث عن المستخدم بهذا الجهاز والتطبيق
            const userSnapshot = await db.collection('users')
                .where("deviceId", "==", deviceId)
                .where("appName", "==", appName)
                .get();
            
            if (!userSnapshot.empty) {
                const userData = userSnapshot.docs[0].data();
                const savedVersion = userData.appVersion || '1.0';
                
                // التحقق من الإصدار
                if (appVersion && savedVersion !== appVersion) {
                    return res.status(409).send("VERSION_MISMATCH");
                }
                
                return res.status(200).send("VERIFIED");
            } else {
                return res.status(404).send("NOT_FOUND");
            }
        }
        
        // نقطة طلب كود التفعيل
        else if (action === "request") {
            if (!phone || !name || !deviceId || !appName) {
                return res.status(400).send("MISSING_PARAMS");
            }
            
            const formatted = formatPhoneNumber(phone);
            if (!formatted.isValid || !formatted.fullNumber) {
                return res.status(400).send("INVALID_NUMBER");
            }
            
            // التحقق من عدم وجود الجهاز مسجل بالفعل
            const existingUser = await db.collection('users')
                .where("deviceId", "==", deviceId)
                .where("appName", "==", appName)
                .get();
            
            if (!existingUser.empty) {
                return res.status(409).send("ALREADY_REGISTERED");
            }
            
            // إنشاء كود عشوائي
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const key = `${deviceId}_${appName}`;
            
            // تخزين مؤقت
            pendingVerifications.set(key, {
                otp,
                phone: formatted.fullNumber,
                name,
                appVersion: appVersion || '1.0',
                timestamp: Date.now()
            });
            
            // تخزين في Firebase كنسخة احتياطية
            await db.collection('pending_codes').doc(key).set({
                otp,
                phone: formatted.fullNumber,
                name,
                appName,
                deviceId,
                appVersion: appVersion || '1.0',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // إرسال الكود عبر الواتساب
            const jid = formatted.fullNumber.replace('+', '') + "@s.whatsapp.net";
            await safeSend(jid, { 
                text: `🔐 مرحباً ${name}، كود تفعيل تطبيق ${appName} هو: *${otp}*` 
            });
            
            console.log(`✅ تم إرسال الكود ${otp} للرقم ${formatted.fullNumber}`);
            return res.status(200).send("OTP_SENT");
        }
        
        // نقطة التحقق من الكود
        else if (action === "verify") {
            if (!code || !deviceId || !appName || !phone) {
                return res.status(400).send("MISSING_PARAMS");
            }
            
            const key = `${deviceId}_${appName}`;
            
            // البحث في الذاكرة أولاً
            let verification = pendingVerifications.get(key);
            let source = "memory";
            
            // إذا لم يوجد، ابحث في Firebase
            if (!verification) {
                const fbDoc = await db.collection('pending_codes').doc(key).get();
                if (fbDoc.exists) {
                    verification = fbDoc.data();
                    source = "firebase";
                }
            }
            
            if (!verification) {
                return res.status(404).send("NOT_FOUND");
            }
            
            // التحقق من صلاحية الكود (10 دقائق)
            const timestamp = verification.timestamp || (verification.createdAt?.toDate?.()?.getTime() || 0);
            const now = Date.now();
            const diffMinutes = (now - timestamp) / (1000 * 60);
            
            if (diffMinutes > 10) {
                pendingVerifications.delete(key);
                await db.collection('pending_codes').doc(key).delete();
                return res.status(401).send("EXPIRED");
            }
            
            // التحقق من تطابق الكود
            if (verification.otp !== code) {
                return res.status(401).send("INVALID_CODE");
            }
            
            // التحقق من تطابق رقم الهاتف
            const formatted = formatPhoneNumber(phone);
            if (verification.phone !== formatted.fullNumber) {
                return res.status(401).send("PHONE_MISMATCH");
            }
            
            // تسجيل المستخدم
            const userKey = `${deviceId}_${appName}`;
            await db.collection('users').doc(userKey).set({
                name: verification.name,
                phone: verification.phone,
                appName,
                deviceId,
                appVersion: verification.appVersion,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // إرسال إشعار للمالك
            try {
                const ownerJid = getJidFromPhone(OWNER_NUMBER);
                const now = new Date();
                const dateStr = now.toLocaleDateString('ar-EG');
                const timeStr = now.toLocaleTimeString('ar-EG');
                
                const message = `🆕 *مستخدم جديد!*\n\n` +
                                `👤 *الاسم:* ${verification.name}\n` +
                                `📱 *الرقم:* ${verification.phone}\n` +
                                `📲 *التطبيق:* ${appName}\n` +
                                `📱 *الإصدار:* ${verification.appVersion}\n` +
                                `📅 *التاريخ:* ${dateStr} ${timeStr}`;
                
                await safeSend(ownerJid, { text: message });
            } catch (e) {}
            
            // تنظيف البيانات المؤقتة
            pendingVerifications.delete(key);
            await db.collection('pending_codes').doc(key).delete();
            
            return res.status(200).send("SUCCESS");
        }
        
        else {
            return res.status(400).send("INVALID_ACTION");
        }
        
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("ERROR");
    }
});

// ============================================
// Webhook تيليجرام للتحكم
// ============================================

app.post("/telegram-webhook", async (req, res) => {
    try {
        const message = req.body.message;
        if (!message) return res.sendStatus(200);
        
        const chatId = message.chat.id;
        const text = message.text;
        const userId = message.from.id;
        
        if (userId.toString() !== TELEGRAM_ADMIN_ID) {
            await sendTelegram(chatId, "⛔ أنت غير مصرح!");
            return res.sendStatus(200);
        }
        
        // أوامر بسيطة
        if (text === "/start") {
            const menu = `🌟 *بوت التحكم*\n\n` +
                        `الأوامر:\n` +
                        `📊 /stats - الإحصائيات\n` +
                        `📢 /publish - نشر رسالة\n` +
                        `🔍 /apps - قائمة التطبيقات\n` +
                        `💓 /ping - حالة البوت`;
            
            await sendTelegram(chatId, menu);
        }
        
        else if (text === "/stats" || text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            const appStats = {};
            usersSnap.docs.forEach(doc => {
                const appName = doc.data().appName || 'غير معروف';
                appStats[appName] = (appStats[appName] || 0) + 1;
            });
            
            let statsText = "📊 *إحصائيات المستخدمين*\n\n";
            statsText += `👥 *الإجمالي:* ${usersSnap.size}\n\n`;
            statsText += "📱 *حسب التطبيق:*\n";
            
            const sortedApps = Object.entries(appStats).sort((a, b) => b[1] - a[1]);
            for (const [app, count] of sortedApps) {
                const percentage = ((count / usersSnap.size) * 100).toFixed(1);
                statsText += `• *${app}*: ${count} (${percentage}%)\n`;
            }
            
            await sendTelegram(chatId, statsText);
        }
        
        else if (text === "/apps" || text === "نجم تطبيقات") {
            const usersSnap = await db.collection('users').get();
            const appNames = [...new Set(usersSnap.docs.map(d => d.data().appName))].filter(name => name);
            
            let appsText = "📱 *قائمة التطبيقات*\n\n";
            appNames.forEach((app, index) => {
                appsText += `${index + 1}. ${app}\n`;
            });
            
            await sendTelegram(chatId, appsText);
        }
        
        else if (text === "/ping" || text === "نجم حالة") {
            await sendTelegram(chatId, "⚡ *البوت يعمل بشكل طبيعي* ✅");
        }
        
        else if (text.startsWith("/publish") || text === "نجم نشر") {
            // تنفيذ النشر (يمكن تطويره)
            await sendTelegram(chatId, "🔧 هذه الخاصية قيد التطوير");
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ خطأ في تيليجرام:", error);
        res.sendStatus(200);
    }
});

// ============================================
// الصفحات العامة
// ============================================

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

// ============================================
// تشغيل السيرفر
// ============================================

app.listen(process.env.PORT || 10000, async () => {
    console.log("=".repeat(50));
    console.log(`🚀 السيرفر يعمل على المنفذ ${process.env.PORT || 10000}`);
    console.log(`🌐 الرابط: https://threew3t3s3wts.onrender.com`);
    console.log(`📱 رقم المالك: ${OWNER_NUMBER}`);
    console.log("=".repeat(50));
    
    await setupTelegramWebhook();
    startBot();
});
