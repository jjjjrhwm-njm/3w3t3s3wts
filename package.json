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

// رقم المالك (سيتم إرسال الإشعارات إليه)
const OWNER_NUMBER = process.env.OWNER_NUMBER || "966554526287";

// متغيرات تيليجرام
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// --- تخزين مؤقت في الذاكرة ---
const pendingCodes = new Map(); // مفتاح: الكود, قيمة: كل البيانات
const telegramStates = new Map(); // لتخزين حالة المستخدم في تيليجرام

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
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دالة الإرسال الآمن للواتساب
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال"); }
}

// دالة إرسال رسالة تيليجرام
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

// دالة عالمية لتنسيق الأرقام
function formatPhoneNumber(phone) {
    let clean = phone.replace(/\D/g, '');
    
    try {
        const phoneNumber = parsePhoneNumberFromString('+' + clean);
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                nationalNumber: phoneNumber.nationalNumber,
                countryCode: phoneNumber.countryCallingCode,
                fullNumber: phoneNumber.number,
                isValid: true
            };
        }
    } catch (e) {}
    
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    
    let countryCode = '966';
    let nationalNumber = clean;
    
    if (clean.length === 12 && clean.startsWith('966')) {
        nationalNumber = clean.substring(3);
        countryCode = '966';
    } else if (clean.length === 12 && clean.startsWith('967')) {
        nationalNumber = clean.substring(3);
        countryCode = '967';
    } else if (clean.length === 11 && clean.startsWith('974')) {
        nationalNumber = clean.substring(3);
        countryCode = '974';
    } else if (clean.length === 9 && clean.startsWith('5')) {
        countryCode = '966';
    } else if (clean.length === 9 && clean.startsWith('7')) {
        countryCode = '967';
    } else if (clean.length === 8 && /^[34567]/.test(clean)) {
        countryCode = '974';
    }
    
    return {
        nationalNumber: nationalNumber,
        countryCode: countryCode,
        fullNumber: '+' + countryCode + nationalNumber,
        isValid: true
    };
}

function getJidFromPhone(phone) {
    const formatted = formatPhoneNumber(phone);
    return formatted.fullNumber.replace('+', '') + "@s.whatsapp.net";
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

// --- 4. تعريف دالة startBot قبل استخدامها ---
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

// --- 5. دوال النشر عبر الواتساب ---
async function publishToWhatsApp(appName, link, description, chatId) {
    try {
        const usersSnapshot = await db.collection('users').get();
        let targets = [];
        
        if (appName === "الجميع") {
            targets = usersSnapshot.docs;
        } else {
            targets = usersSnapshot.docs.filter(d => d.data().appName === appName);
        }
        
        await sendTelegram(chatId, `🚀 جاري النشر لـ ${targets.length} مستخدم من تطبيق ${appName}...`);
        
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

// --- 6. إعداد Webhook تيليجرام ---
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
// API للواتساب
// ============================================

app.get("/check-device", async (req, res) => {
    try {
        const { id, appName } = req.query;
        console.log(`🔍 فحص الجهاز: ${id} للتطبيق: ${appName}`);
        
        const snap = await db.collection('users')
            .where("deviceId", "==", id)
            .where("appName", "==", appName)
            .get();
        
        if (!snap.empty) {
            return res.status(200).send("SUCCESS");
        } else {
            return res.status(404).send("NOT_FOUND");
        }
    } catch (error) {
        res.status(500).send("ERROR");
    }
});

app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        
        console.log("=".repeat(50));
        console.log("📱 طلب كود جديد");
        console.log("=".repeat(50));
        console.log("الرقم الأصلي:", phone);
        
        const formatted = formatPhoneNumber(phone);
        console.log("الرقم بعد التنسيق:", formatted);
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        const codeData = {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName,
            deviceId: deviceId,
            originalPhone: phone,
            formattedPhone: formatted,
            timestamp: Date.now()
        };
        
        pendingCodes.set(otp, codeData);
        
        await db.collection('pending_codes').doc(otp).set({
            otp: otp,
            name: name || 'مستخدم',
            appName: appName,
            deviceId: deviceId,
            originalPhone: phone,
            countryCode: formatted.countryCode,
            nationalNumber: formatted.nationalNumber,
            fullNumber: formatted.fullNumber,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`📦 تم تخزين الكود ${otp} للجهاز ${deviceId}`);
        
        const jid = getJidFromPhone(phone);
        await safeSend(jid, { 
            text: `🔐 مرحباً ${name}، كود تفعيل تطبيق ${appName} هو: *${otp}*` 
        });
        
        console.log(`✅ تم الإرسال`);
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        
        console.log("=".repeat(50));
        console.log("🔍 محاولة تحقق");
        console.log("=".repeat(50));
        console.log("الرقم:", phone);
        console.log("الكود:", code);
        
        let codeData = pendingCodes.get(code);
        let source = "memory";
        
        if (!codeData) {
            const fbDoc = await db.collection('pending_codes').doc(code).get();
            if (fbDoc.exists) {
                codeData = fbDoc.data();
                source = "firebase";
            }
        }
        
        if (!codeData) {
            console.log(`❌ الكود غير موجود`);
            return res.status(401).send("FAIL");
        }
        
        console.log(`✅ تم العثور على الكود (${source})`);
        
        const timestamp = codeData.timestamp || (codeData.createdAt?.toDate?.()?.getTime() || 0);
        const now = Date.now();
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            pendingCodes.delete(code);
            await db.collection('pending_codes').doc(code).delete();
            return res.status(401).send("FAIL");
        }
        
        console.log(`🎉 تحقق ناجح!`);
        
        const finalPhone = codeData.formattedPhone?.fullNumber?.replace('+', '') || 
                          codeData.fullNumber?.replace('+', '') || 
                          phone.replace(/\D/g, '');
        
        const userKey = finalPhone + "_" + codeData.appName;
        
        await db.collection('users').doc(userKey).set({ 
            name: codeData.name,
            phone: finalPhone,
            appName: codeData.appName,
            deviceId: codeData.deviceId,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        console.log(`✅ تم تسجيل المستخدم: ${userKey}`);
        
        // إرسال إشعار للمالك عبر الواتساب
        try {
            const ownerJid = getJidFromPhone(OWNER_NUMBER);
            const now = new Date();
            const dateStr = now.toLocaleDateString('ar-EG');
            const timeStr = now.toLocaleTimeString('ar-EG');
            
            const countryNames = {
                '966': '🇸🇦 السعودية',
                '967': '🇾🇪 اليمن',
                '974': '🇶🇦 قطر'
            };
            const countryDisplay = countryNames[codeData.formattedPhone?.countryCode] || '🌍 أخرى';
            
            const message = `🆕 *مستخدم جديد اشترك!*\n\n` +
                            `👤 *الاسم:* ${codeData.name}\n` +
                            `📱 *رقم الهاتف:* ${finalPhone}\n` +
                            `🌍 *الدولة:* ${countryDisplay}\n` +
                            `📲 *التطبيق:* ${codeData.appName}\n` +
                            `📅 *التاريخ:* ${dateStr} ${timeStr}`;
            
            await safeSend(ownerJid, { text: message });
        } catch (e) {}
        
        pendingCodes.delete(code);
        await db.collection('pending_codes').doc(code).delete();
        
        return res.status(200).send("SUCCESS");
        
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("FAIL");
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
        
        // تحقق من أن المستخدم هو المسؤول
        if (userId.toString() !== TELEGRAM_ADMIN_ID) {
            await sendTelegram(chatId, "⛔ أنت غير مصرح باستخدام هذا البوت.");
            return res.sendStatus(200);
        }
        
        const currentState = telegramStates.get(chatId);
        
        // إذا كان المستخدم في حالة تفاعلية
        if (currentState) {
            if (text === "إلغاء") {
                telegramStates.delete(chatId);
                await sendTelegram(chatId, "❌ تم إلغاء العملية.");
                return res.sendStatus(200);
            }
            
            if (currentState.command === "نشر") {
                // استلام الرابط
                if (currentState.step === "waiting_link") {
                    if (!text.startsWith('http')) {
                        await sendTelegram(chatId, "❌ رابط غير صحيح. أرسل رابطاً يبدأ بـ http");
                        return res.sendStatus(200);
                    }
                    currentState.link = text;
                    currentState.step = "waiting_desc";
                    telegramStates.set(chatId, currentState);
                    await sendTelegram(chatId, "✅ تم استلام الرابط.\nالآن أرسل *الوصف*:");
                    return res.sendStatus(200);
                }
                
                // استلام الوصف
                if (currentState.step === "waiting_desc") {
                    currentState.desc = text;
                    currentState.step = "waiting_target";
                    telegramStates.set(chatId, currentState);
                    
                    // جلب جميع أسماء التطبيقات
                    const usersSnapshot = await db.collection('users').get();
                    const appNames = [...new Set(usersSnapshot.docs.map(d => d.data().appName))].filter(name => name);
                    
                    let menu = "🎯 *اختر الجمهور المستهدف:*\n\n";
                    menu += "0 - 🌐 *الجميع*\n\n";
                    appNames.forEach((app, index) => {
                        menu += `${index + 1} - 📱 *${app}*\n`;
                    });
                    menu += "\n💡 أرسل رقم الخيار المطلوب.\n";
                    menu += "❌ أرسل *إلغاء* للإلغاء.";
                    
                    await sendTelegram(chatId, menu);
                    return res.sendStatus(200);
                }
                
                // استلام رقم الخيار والتنفيذ
                if (currentState.step === "waiting_target") {
                    const usersSnapshot = await db.collection('users').get();
                    const appNames = [...new Set(usersSnapshot.docs.map(d => d.data().appName))].filter(name => name);
                    
                    let selectedApp = "";
                    
                    if (text === "0") {
                        selectedApp = "الجميع";
                    } else {
                        const idx = parseInt(text) - 1;
                        if (isNaN(idx) || idx < 0 || idx >= appNames.length) {
                            await sendTelegram(chatId, "❌ رقم غير صحيح. أرسل *إلغاء* للإلغاء.");
                            return res.sendStatus(200);
                        }
                        selectedApp = appNames[idx];
                    }
                    
                    telegramStates.delete(chatId);
                    
                    // تنفيذ النشر عبر الواتساب
                    await publishToWhatsApp(selectedApp, currentState.link, currentState.desc, chatId);
                    
                    return res.sendStatus(200);
                }
            }
            return res.sendStatus(200);
        }
        
        // الأوامر الرئيسية
        if (text === "نجم نشر") {
            telegramStates.set(chatId, { command: "نشر", step: "waiting_link" });
            await sendTelegram(chatId, "🔗 *خطوة 1/3*\nأرسل *الرابط* الآن:");
        }
        else if (text === "نجم احصا") {
            const usersSnap = await db.collection('users').get();
            const appStats = {};
            usersSnap.docs.forEach(doc => {
                const appName = doc.data().appName || 'غير معروف';
                appStats[appName] = (appStats[appName] || 0) + 1;
            });
            
            let statsText = "📊 *إحصائيات المستخدمين:*\n\n";
            statsText += `👥 *الإجمالي:* ${usersSnap.size}\n\n`;
            statsText += "📱 *حسب التطبيق:*\n";
            for (const [app, count] of Object.entries(appStats)) {
                statsText += `• ${app}: ${count} مستخدم\n`;
            }
            await sendTelegram(chatId, statsText);
        }
        else if (text === "نجم حالة") {
            await sendTelegram(chatId, "⚡ *البوت يعمل بشكل طبيعي*");
        }
        else {
            await sendTelegram(chatId, "🌟 الأوامر المتاحة:\n\nنجم نشر - لنشر إعلان\nنجم احصا - لعرض الإحصائيات\nنجم حالة - لعرض حالة البوت");
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
