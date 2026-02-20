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
const crypto = require('crypto');

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
let isStarting = false;

// المالك
const OWNER_NUMBER = process.env.OWNER_NUMBER || "966554526287";

// تيليجرام
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// التخزين المؤقت
const pendingSessions = new Map(); // للتخزين المؤقت للجلسات
const telegramStates = new Map(); // لحالات التيليجرام

// --- إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// --- النبض ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دوال مساعدة
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال"); }
}

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

// دالة تنسيق الأرقام (محسنة)
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (!cleaned || cleaned.length < 7) {
        return { isValid: false, fullNumber: null };
    }

    const countryCodes = [
        { code: '966', name: '🇸🇦 السعودية', length: 9, startsWith: ['5'] },
        { code: '20', name: '🇪🇬 مصر', length: 10, startsWith: ['1', '2'] },
        { code: '974', name: '🇶🇦 قطر', length: 8, startsWith: ['3', '4', '5', '6', '7'] },
        { code: '973', name: '🇧🇭 البحرين', length: 8, startsWith: ['3'] },
        { code: '968', name: '🇴🇲 عمان', length: 8, startsWith: ['2', '9'] },
        { code: '965', name: '🇰🇼 الكويت', length: 8, startsWith: ['5', '6', '9'] },
        { code: '971', name: '🇦🇪 الإمارات', length: 9, startsWith: ['5'] },
        { code: '967', name: '🇾🇪 اليمن', length: 9, startsWith: ['7'] },
        { code: '962', name: '🇯🇴 الأردن', length: 9, startsWith: ['7'] },
        { code: '964', name: '🇮🇶 العراق', length: 10, startsWith: ['7'] },
        { code: '963', name: '🇸🇾 سوريا', length: 9, startsWith: ['9'] },
        { code: '961', name: '🇱🇧 لبنان', length: 8, startsWith: ['3', '7'] },
        { code: '213', name: '🇩🇿 الجزائر', length: 9, startsWith: ['5', '6', '7'] },
        { code: '212', name: '🇲🇦 المغرب', length: 9, startsWith: ['6', '7'] },
        { code: '216', name: '🇹🇳 تونس', length: 8, startsWith: ['2', '5', '9'] },
        { code: '218', name: '🇱🇾 ليبيا', length: 9, startsWith: ['9'] },
        { code: '222', name: '🇲🇷 موريتانيا', length: 8, startsWith: ['2'] },
        { code: '249', name: '🇸🇩 السودان', length: 9, startsWith: ['9'] },
        { code: '92', name: '🇵🇰 باكستان', length: 10, startsWith: ['3'] },
        { code: '93', name: '🇦🇫 أفغانستان', length: 9, startsWith: ['7'] },
        { code: '98', name: '🇮🇷 إيران', length: 10, startsWith: ['9'] },
        { code: '90', name: '🇹🇷 تركيا', length: 10, startsWith: ['5'] },
        { code: '91', name: '🇮🇳 الهند', length: 10, startsWith: ['6', '7', '8', '9'] },
        { code: '880', name: '🇧🇩 بنجلاديش', length: 10, startsWith: ['1'] },
        { code: '60', name: '🇲🇾 ماليزيا', length: 9, startsWith: ['1'] },
        { code: '62', name: '🇮🇩 إندونيسيا', length: 10, startsWith: ['8'] }
    ];

    try {
        const phoneNumber = parsePhoneNumberFromString(phone);
        if (phoneNumber && phoneNumber.isValid()) {
            const country = countryCodes.find(c => c.code == phoneNumber.countryCallingCode);
            return {
                nationalNumber: phoneNumber.nationalNumber,
                countryCode: phoneNumber.countryCallingCode,
                fullNumber: phoneNumber.number,
                isValid: true,
                countryName: country?.name || '🌍 أخرى'
            };
        }
    } catch (e) {}

    let numberToAnalyze = cleaned.startsWith('0') ? cleaned.substring(1) : cleaned;
    
    for (const country of countryCodes) {
        if (numberToAnalyze.startsWith(country.code)) {
            const nationalPart = numberToAnalyze.substring(country.code.length);
            if (nationalPart.length === country.length) {
                return {
                    nationalNumber: nationalPart,
                    countryCode: country.code,
                    fullNumber: `+${country.code}${nationalPart}`,
                    isValid: true,
                    countryName: country.name
                };
            }
        }
    }

    return {
        nationalNumber: numberToAnalyze,
        countryCode: '966',
        fullNumber: `+966${numberToAnalyze}`,
        isValid: true,
        countryName: '🇸🇦 السعودية (تقديري)'
    };
}

// دالة تشفير لإنشاء معرف جلسة فريد
function generateSessionToken(deviceId, appName, phone) {
    const data = `${deviceId}:${appName}:${phone}:${Date.now()}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

// --- استعادة وحفظ الهوية (بدون تغيير) ---
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

// --- تشغيل البوت ---
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
            
            // إرسال رسالة للمالك بأن البوت جاهز
            try {
                const ownerJid = OWNER_NUMBER.replace('+', '') + "@s.whatsapp.net";
                await safeSend(ownerJid, { text: "✅ *البوت جاهز للعمل*" });
            } catch(e) {}
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

// --- API محسن ---
// 1. التحقق من الجهاز (الآن مع التحقق من التطبيق والجهاز معاً)
app.get("/check-device", async (req, res) => {
    try {
        const { deviceId, appName, version } = req.query;
        
        if (!deviceId || !appName) {
            return res.status(400).send("MISSING_PARAMS");
        }
        
        console.log(`🔍 فحص: جهاز=${deviceId}, تطبيق=${appName}, إصدار=${version || 'غير محدد'}`);
        
        // البحث عن المستخدم بمعرف الجهاز واسم التطبيق معاً
        const userSnapshot = await db.collection('users')
            .where("deviceId", "==", deviceId)
            .where("appName", "==", appName)
            .get();
        
        if (!userSnapshot.empty) {
            const userData = userSnapshot.docs[0].data();
            
            // التحقق من الإصدار إذا تم إرساله
            if (version && userData.appVersion && userData.appVersion !== version) {
                console.log(`📱 إصدار مختلف: المتوقع ${userData.appVersion}، المستلم ${version}`);
                return res.status(409).send("VERSION_MISMATCH");
            }
            
            // إنشاء رمز جلسة
            const sessionToken = generateSessionToken(deviceId, appName, userData.phone);
            
            return res.status(200).json({
                status: "AUTHORIZED",
                sessionToken: sessionToken,
                userData: {
                    name: userData.name,
                    phone: userData.phone,
                    appVersion: userData.appVersion
                }
            });
        } else {
            return res.status(404).send("UNAUTHORIZED");
        }
    } catch (error) {
        console.error("❌ خطأ في check-device:", error);
        res.status(500).send("ERROR");
    }
});

// 2. طلب كود (محسن)
app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, appName, deviceId, version } = req.query;
        
        if (!phone || !appName || !deviceId) {
            return res.status(400).send("MISSING_PARAMS");
        }
        
        console.log("=".repeat(50));
        console.log("📱 طلب كود جديد");
        console.log("=".repeat(50));
        
        const formatted = formatPhoneNumber(phone);
        
        if (!formatted.isValid || !formatted.fullNumber) {
            return res.status(400).send("INVALID_NUMBER");
        }
        
        // التحقق مما إذا كان الجهاز مسجلاً مسبقاً لهذا التطبيق
        const existingUser = await db.collection('users')
            .where("deviceId", "==", deviceId)
            .where("appName", "==", appName)
            .get();
        
        if (!existingUser.empty) {
            // الجهاز مسجل مسبقاً، نعيد توجيهه للتحقق المباشر
            return res.status(200).send("ALREADY_REGISTERED");
        }
        
        // إنشاء كود عشوائي من 6 أرقام
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // إنشاء معرف جلسة فريد
        const sessionId = generateSessionToken(deviceId, appName, formatted.fullNumber);
        
        const sessionData = {
            sessionId: sessionId,
            otp: otp,
            name: name || 'مستخدم',
            appName: appName,
            deviceId: deviceId,
            appVersion: version || '1.0',
            formattedPhone: formatted,
            timestamp: Date.now(),
            attempts: 0
        };
        
        // تخزين في الذاكرة وفي Firebase
        pendingSessions.set(sessionId, sessionData);
        
        await db.collection('pending_sessions').doc(sessionId).set({
            ...sessionData,
            formattedPhone: admin.firestore.FieldValue.delete(), // لا نخزن الكائن بالكامل
            countryCode: formatted.countryCode,
            nationalNumber: formatted.nationalNumber,
            fullNumber: formatted.fullNumber,
            countryName: formatted.countryName,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // إرسال الكود عبر الواتساب
        const jid = formatted.fullNumber.replace('+', '') + "@s.whatsapp.net";
        await safeSend(jid, { 
            text: `🔐 *مرحباً ${name || 'مستخدم'}*\n\n` +
                  `كود تفعيل تطبيق *${appName}* هو:\n` +
                  `*${otp}*\n\n` +
                  `⏰ الكود صالح لمدة 10 دقائق`
        });
        
        console.log(`✅ تم إرسال الكود ${otp} للجهاز ${deviceId}`);
        
        res.status(200).json({
            status: "OK",
            sessionId: sessionId,
            expiresIn: 600 // 10 دقائق بالثواني
        });
        
    } catch (error) {
        console.error("❌ خطأ في request-otp:", error);
        res.status(500).send("ERROR");
    }
});

// 3. التحقق من الكود (محسن)
app.get("/verify-otp", async (req, res) => {
    try {
        const { sessionId, otp } = req.query;
        
        if (!sessionId || !otp) {
            return res.status(400).send("MISSING_PARAMS");
        }
        
        // البحث في الذاكرة أولاً
        let sessionData = pendingSessions.get(sessionId);
        let source = "memory";
        
        if (!sessionData) {
            const fbDoc = await db.collection('pending_sessions').doc(sessionId).get();
            if (fbDoc.exists) {
                sessionData = fbDoc.data();
                source = "firebase";
            }
        }
        
        if (!sessionData) {
            return res.status(401).send("INVALID_SESSION");
        }
        
        // التحقق من الصلاحية الزمنية
        const timestamp = sessionData.timestamp || (sessionData.createdAt?.toDate?.()?.getTime() || 0);
        const now = Date.now();
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        if (diffMinutes > 10) {
            pendingSessions.delete(sessionId);
            await db.collection('pending_sessions').doc(sessionId).delete();
            return res.status(401).send("EXPIRED");
        }
        
        // التحقق من عدد المحاولات
        sessionData.attempts = (sessionData.attempts || 0) + 1;
        if (sessionData.attempts > 5) {
            pendingSessions.delete(sessionId);
            await db.collection('pending_sessions').doc(sessionId).delete();
            return res.status(401).send("TOO_MANY_ATTEMPTS");
        }
        
        // تحديث في الذاكرة
        pendingSessions.set(sessionId, sessionData);
        
        // التحقق من صحة الكود
        if (sessionData.otp !== otp) {
            return res.status(401).send("INVALID_CODE");
        }
        
        // نجاح التحقق - تسجيل المستخدم
        const phone = sessionData.fullNumber || 
                     (sessionData.formattedPhone?.fullNumber) || 
                     `+${sessionData.countryCode}${sessionData.nationalNumber}`;
        
        const cleanPhone = phone.replace('+', '');
        const userKey = `${cleanPhone}_${sessionData.appName}`;
        
        await db.collection('users').doc(userKey).set({ 
            name: sessionData.name,
            phone: cleanPhone,
            appName: sessionData.appName,
            deviceId: sessionData.deviceId,
            appVersion: sessionData.appVersion || '1.0',
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // إنشاء رمز جلسة نهائي
        const finalToken = generateSessionToken(sessionData.deviceId, sessionData.appName, cleanPhone);
        
        // إشعار المالك
        try {
            const ownerJid = OWNER_NUMBER.replace('+', '') + "@s.whatsapp.net";
            const countryDisplay = sessionData.countryName || '🌍 أخرى';
            
            const message = `🆕 *مستخدم جديد*\n\n` +
                            `👤 *الاسم:* ${sessionData.name}\n` +
                            `📱 *الرقم:* ${cleanPhone}\n` +
                            `🌍 *الدولة:* ${countryDisplay}\n` +
                            `📲 *التطبيق:* ${sessionData.appName}\n` +
                            `📱 *الإصدار:* ${sessionData.appVersion || '1.0'}\n` +
                            `🆔 *الجهاز:* ${sessionData.deviceId.substring(0, 8)}...`;
            
            await safeSend(ownerJid, { text: message });
        } catch (e) {}
        
        // تنظيف البيانات المؤقتة
        pendingSessions.delete(sessionId);
        await db.collection('pending_sessions').doc(sessionId).delete();
        
        res.status(200).json({
            status: "SUCCESS",
            sessionToken: finalToken,
            userData: {
                name: sessionData.name,
                phone: cleanPhone,
                appName: sessionData.appName
            }
        });
        
    } catch (error) {
        console.error("❌ خطأ في verify-otp:", error);
        res.status(500).send("ERROR");
    }
});

// 4. إعادة التحقق (للأجهزة المسجلة مسبقاً)
app.get("/reverify", async (req, res) => {
    try {
        const { deviceId, appName, sessionToken } = req.query;
        
        if (!deviceId || !appName || !sessionToken) {
            return res.status(400).send("MISSING_PARAMS");
        }
        
        // البحث عن المستخدم
        const userSnapshot = await db.collection('users')
            .where("deviceId", "==", deviceId)
            .where("appName", "==", appName)
            .get();
        
        if (userSnapshot.empty) {
            return res.status(404).send("NOT_FOUND");
        }
        
        const userData = userSnapshot.docs[0].data();
        
        // التحقق من صحة التوكن (في الإنتاج استخدم JWT)
        const expectedToken = generateSessionToken(deviceId, appName, userData.phone);
        if (sessionToken !== expectedToken) {
            return res.status(401).send("INVALID_TOKEN");
        }
        
        // تحديث آخر نشاط
        await userSnapshot.docs[0].ref.update({
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.status(200).json({
            status: "AUTHORIZED",
            userData: {
                name: userData.name,
                phone: userData.phone,
                appName: userData.appName,
                appVersion: userData.appVersion
            }
        });
        
    } catch (error) {
        console.error("❌ خطأ في reverify:", error);
        res.status(500).send("ERROR");
    }
});

// --- Webhook تيليجرام (محسن) ---
app.post("/telegram-webhook", async (req, res) => {
    try {
        const message = req.body.message;
        if (!message) return res.sendStatus(200);
        
        const chatId = message.chat.id;
        const text = message.text;
        const userId = message.from.id;
        
        // التحقق من الصلاحية
        if (userId.toString() !== TELEGRAM_ADMIN_ID) {
            await sendTelegram(chatId, "⛔ أنت غير مصرح باستخدام هذا البوت.");
            return res.sendStatus(200);
        }
        
        const currentState = telegramStates.get(chatId);
        
        // معالجة الحالات النشطة
        if (currentState) {
            if (text === "❌ إلغاء") {
                telegramStates.delete(chatId);
                await sendTelegram(chatId, "✅ تم إلغاء العملية.");
                return res.sendStatus(200);
            }
            
            if (currentState.command === "نشر") {
                // خطوات النشر...
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
                
                if (currentState.step === "waiting_desc") {
                    currentState.desc = text;
                    currentState.step = "waiting_target";
                    telegramStates.set(chatId, currentState);
                    
                    const usersSnapshot = await db.collection('users').get();
                    const appStats = {};
                    usersSnapshot.docs.forEach(doc => {
                        const app = doc.data().appName;
                        if (app) appStats[app] = (appStats[app] || 0) + 1;
                    });
                    
                    let menu = "🎯 *اختر التطبيق:*\n\n";
                    menu += "0️⃣ - 🌐 *الجميع*\n\n";
                    
                    const apps = Object.keys(appStats);
                    apps.forEach((app, index) => {
                        menu += `${index+1}️⃣ - 📱 *${app}* (${appStats[app]} مستخدم)\n`;
                    });
                    menu += "\n📌 أرسل الرقم المطلوب";
                    
                    await sendTelegram(chatId, menu);
                    return res.sendStatus(200);
                }
                
                if (currentState.step === "waiting_target") {
                    const usersSnapshot = await db.collection('users').get();
                    const apps = [...new Set(usersSnapshot.docs.map(d => d.data().appName))].filter(Boolean);
                    
                    let selectedApp = "";
                    
                    if (text === "0") {
                        selectedApp = "الجميع";
                    } else {
                        const idx = parseInt(text) - 1;
                        if (isNaN(idx) || idx < 0 || idx >= apps.length) {
                            await sendTelegram(chatId, "❌ رقم غير صحيح");
                            return res.sendStatus(200);
                        }
                        selectedApp = apps[idx];
                    }
                    
                    telegramStates.delete(chatId);
                    
                    // بدء النشر
                    await sendTelegram(chatId, `🚀 جاري النشر لتطبيق *${selectedApp}*...`);
                    
                    const targets = selectedApp === "الجميع" 
                        ? usersSnapshot.docs
                        : usersSnapshot.docs.filter(d => d.data().appName === selectedApp);
                    
                    let success = 0, fail = 0;
                    
                    for (const doc of targets) {
                        try {
                            const userPhone = doc.data().phone;
                            await safeSend(userPhone + "@s.whatsapp.net", { 
                                text: `📢 *تحديث جديد*\n\n${currentState.desc}\n\n🔗 [اضغط هنا](${currentState.link})` 
                            });
                            success++;
                            await new Promise(r => setTimeout(r, 300));
                        } catch (e) {
                            fail++;
                        }
                    }
                    
                    await sendTelegram(chatId, 
                        `✅ *تم النشر*\n\n` +
                        `✓ نجح: ${success}\n` +
                        `✗ فشل: ${fail}\n` +
                        `👥 المجموع: ${targets.length}`
                    );
                    
                    return res.sendStatus(200);
                }
            }
            return res.sendStatus(200);
        }
        
        // الأوامر الرئيسية
        if (text === "/start") {
            await sendTelegram(chatId, 
                `🌟 *مرحباً بك في لوحة التحكم*\n\n` +
                `📋 *الأوامر المتاحة:*\n\n` +
                `📢 *نشر* - نشر إعلان جديد\n` +
                `📊 *إحصائيات* - عرض الإحصائيات\n` +
                `ℹ️ *حالة* - حالة البوت\n` +
                `📱 *الأجهزة* - عرض الأجهزة النشطة`
            );
        }
        else if (text === "نشر") {
            telegramStates.set(chatId, { command: "نشر", step: "waiting_link" });
            await sendTelegram(chatId, 
                "🔗 *الخطوة 1/3*\n\n" +
                "أرسل الرابط الذي تريد نشره:"
            );
        }
        else if (text === "إحصائيات") {
            const usersSnap = await db.collection('users').get();
            const stats = {};
            
            usersSnap.docs.forEach(doc => {
                const app = doc.data().appName || 'غير معروف';
                stats[app] = (stats[app] || 0) + 1;
            });
            
            let report = "📊 *الإحصائيات*\n\n";
            report += `👥 *الإجمالي:* ${usersSnap.size}\n\n`;
            report += "📱 *حسب التطبيق:*\n";
            
            Object.entries(stats)
                .sort((a, b) => b[1] - a[1])
                .forEach(([app, count]) => {
                    report += `• ${app}: ${count}\n`;
                });
            
            await sendTelegram(chatId, report);
        }
        else if (text === "حالة") {
            const usersCount = (await db.collection('users').get()).size;
            const pendingCount = (await db.collection('pending_sessions').get()).size;
            
            await sendTelegram(chatId,
                `⚡ *حالة النظام*\n\n` +
                `✅ البوت: نشط\n` +
                `👥 المستخدمين: ${usersCount}\n` +
                `⏳ في الانتظار: ${pendingCount}\n` +
                `📱 الواتساب: ${sock?.user ? '🟢 متصل' : '🔴 غير متصل'}`
            );
        }
        else if (text === "الأجهزة") {
            const usersSnap = await db.collection('users')
                .orderBy('lastActive', 'desc')
                .limit(10)
                .get();
            
            let report = "📱 *آخر الأجهزة النشطة*\n\n";
            usersSnap.docs.forEach((doc, i) => {
                const data = doc.data();
                report += `${i+1}. ${data.name || 'بدون اسم'}\n`;
                report += `   📱 ${data.appName} | ${data.phone.substring(0, 7)}...\n`;
                report += `   🕐 ${data.lastActive?.toDate?.()?.toLocaleString('ar-EG') || 'غير معروف'}\n\n`;
            });
            
            await sendTelegram(chatId, report);
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ خطأ تيليجرام:", error);
        res.sendStatus(200);
    }
});

// --- إعداد Webhook تيليجرام ---
async function setupTelegramWebhook() {
    if (!TELEGRAM_BOT_TOKEN) return;
    
    const webhookUrl = `https://threew3t3s3wts.onrender.com/telegram-webhook`;
    try {
        await fetch(`${TELEGRAM_API_URL}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhookUrl })
        });
        console.log("✅ Webhook تيليجرام جاهز");
    } catch (error) {
        console.log("⚠️ فشل إعداد webhook");
    }
}

// --- مسارات عامة ---
app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => {
    if (qrImage === "DONE") {
        res.send(`
            <html>
                <head><style>body{font-family:Arial;text-align:center;padding:50px;background:#f0f0f0}</style></head>
                <body>
                    <h1 style="color:#25D366">✅ البوت يعمل</h1>
                    <p>تم الاتصال بنجاح</p>
                </body>
            </html>
        `);
    } else if (qrImage) {
        res.send(`
            <html>
                <head><style>body{font-family:Arial;text-align:center;padding:20px;background:#f0f0f0}</style></head>
                <body>
                    <h1 style="color:#25D366">🔐 مسح QR</h1>
                    <img src="${qrImage}" style="max-width:300px;border:10px solid white;border-radius:20px;box-shadow:0 0 20px rgba(0,0,0,0.2)">
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head><style>body{font-family:Arial;text-align:center;padding:50px;background:#f0f0f0}</style></head>
                <body>
                    <h1 style="color:#25D366">⏳ جاري التحميل...</h1>
                </body>
            </html>
        `);
    }
});

// --- تشغيل السيرفر ---
app.listen(process.env.PORT || 10000, async () => {
    console.log("=".repeat(60));
    console.log(`🚀 السيرفر يعمل على المنفذ ${process.env.PORT || 10000}`);
    console.log(`🌐 الرابط: https://threew3t3s3wts.onrender.com`);
    console.log(`📱 المالك: ${OWNER_NUMBER}`);
    console.log("=".repeat(60));
    
    await setupTelegramWebhook();
    startBot();
});
