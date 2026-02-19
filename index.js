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

// دالة عالمية لتنسيق الأرقام - تدعم جميع الدول العربية والإسلامية
function formatPhoneNumber(phone) {
    let clean = phone.replace(/\D/g, '');
    
    // إزالة الصفر البادئ أو 00
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    
    // قائمة بجميع الدول العربية والإسلامية مع أطوال أرقامها وأنماطها
    const countryPatterns = {
        // دول مجلس التعاون الخليجي
        '966': { length: 9, startsWith: ['5'], name: '🇸🇦 السعودية' },
        '974': { length: 8, startsWith: ['3','4','5','6','7'], name: '🇶🇦 قطر' },
        '973': { length: 8, startsWith: ['3'], name: '🇧🇭 البحرين' },
        '968': { length: 8, startsWith: ['2','9'], name: '🇴🇲 عمان' },
        '965': { length: 8, startsWith: ['5','6','9'], name: '🇰🇼 الكويت' },
        '971': { length: 9, startsWith: ['5'], name: '🇦🇪 الإمارات' },
        
        // دول شرق آسيا وإفريقيا
        '967': { length: 9, startsWith: ['7'], name: '🇾🇪 اليمن' },
        '20': { length: 10, startsWith: ['1','2'], name: '🇪🇬 مصر' },
        '962': { length: 9, startsWith: ['7'], name: '🇯🇴 الأردن' },
        '964': { length: 10, startsWith: ['7'], name: '🇮🇶 العراق' },
        '963': { length: 9, startsWith: ['9'], name: '🇸🇾 سوريا' },
        '961': { length: 8, startsWith: ['3','7'], name: '🇱🇧 لبنان' },
        
        // شمال إفريقيا
        '213': { length: 9, startsWith: ['5','6','7'], name: '🇩🇿 الجزائر' },
        '212': { length: 9, startsWith: ['6','7'], name: '🇲🇦 المغرب' },
        '216': { length: 8, startsWith: ['2','5','9'], name: '🇹🇳 تونس' },
        '218': { length: 9, startsWith: ['9'], name: '🇱🇾 ليبيا' },
        '222': { length: 8, startsWith: ['2'], name: '🇲🇷 موريتانيا' },
        '249': { length: 9, startsWith: ['9'], name: '🇸🇩 السودان' },
        
        // دول إسلامية أخرى
        '92': { length: 10, startsWith: ['3'], name: '🇵🇰 باكستان' },
        '93': { length: 9, startsWith: ['7'], name: '🇦🇫 أفغانستان' },
        '98': { length: 10, startsWith: ['9'], name: '🇮🇷 إيران' },
        '90': { length: 10, startsWith: ['5'], name: '🇹🇷 تركيا' },
        '91': { length: 10, startsWith: ['6','7','8','9'], name: '🇮🇳 الهند' },
        '880': { length: 10, startsWith: ['1'], name: '🇧🇩 بنجلاديش' },
        '60': { length: 9, startsWith: ['1'], name: '🇲🇾 ماليزيا' },
        '62': { length: 10, startsWith: ['8'], name: '🇮🇩 إندونيسيا' },
        '63': { length: 10, startsWith: ['9'], name: '🇵🇭 الفلبين' },
        '94': { length: 9, startsWith: ['7'], name: '🇱🇰 سريلانكا' },
        '95': { length: 8, startsWith: ['9'], name: '🇲🇲 ميانمار' },
        '673': { length: 7, startsWith: ['2'], name: '🇧🇳 بروناي' },
        '670': { length: 8, startsWith: ['7'], name: '🇹🇱 تيمور الشرقية' }
    };
    
    // أولاً: محاولة التحقق باستخدام مكتبة libphonenumber-js (لأي رقم في العالم)
    try {
        const phoneNumber = parsePhoneNumberFromString('+' + clean);
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                nationalNumber: phoneNumber.nationalNumber,
                countryCode: phoneNumber.countryCallingCode,
                fullNumber: phoneNumber.number,
                isValid: true,
                countryName: getCountryName(phoneNumber.countryCallingCode)
            };
        }
    } catch (e) {}
    
    // ثانياً: إذا كان الرقم يحوي مفتاح دولة واضح (مثال: 966512345678)
    for (const [code, pattern] of Object.entries(countryPatterns)) {
        const codeLength = code.length;
        if (clean.length === codeLength + pattern.length && clean.startsWith(code)) {
            const nationalNumber = clean.substring(codeLength);
            return {
                nationalNumber: nationalNumber,
                countryCode: code,
                fullNumber: '+' + code + nationalNumber,
                isValid: true,
                countryName: pattern.name
            };
        }
    }
    
    // ثالثاً: إذا كان الرقم بدون مفتاح دولة، نحاول تحديد الدولة بناءً على الطول وبداية الرقم
    for (const [code, pattern] of Object.entries(countryPatterns)) {
        if (clean.length === pattern.length) {
            for (const start of pattern.startsWith) {
                if (clean.startsWith(start)) {
                    return {
                        nationalNumber: clean,
                        countryCode: code,
                        fullNumber: '+' + code + clean,
                        isValid: true,
                        countryName: pattern.name
                    };
                }
            }
        }
    }
    
    // رابعاً: إذا لم نتمكن من التحديد، نستخدم مفتاح افتراضي (السعودية) مع وضع علامة غير موثوق
    return {
        nationalNumber: clean,
        countryCode: '966',
        fullNumber: '+' + '966' + clean,
        isValid: false,
        countryName: '🌍 غير معروف'
    };
}

// دالة مساعدة للحصول على اسم الدولة
function getCountryName(code) {
    const names = {
        '966': '🇸🇦 السعودية',
        '974': '🇶🇦 قطر',
        '973': '🇧🇭 البحرين',
        '968': '🇴🇲 عمان',
        '965': '🇰🇼 الكويت',
        '971': '🇦🇪 الإمارات',
        '967': '🇾🇪 اليمن',
        '20': '🇪🇬 مصر',
        '962': '🇯🇴 الأردن',
        '964': '🇮🇶 العراق',
        '963': '🇸🇾 سوريا',
        '961': '🇱🇧 لبنان',
        '213': '🇩🇿 الجزائر',
        '212': '🇲🇦 المغرب',
        '216': '🇹🇳 تونس',
        '218': '🇱🇾 ليبيا',
        '222': '🇲🇷 موريتانيا',
        '249': '🇸🇩 السودان',
        '92': '🇵🇰 باكستان',
        '93': '🇦🇫 أفغانستان',
        '98': '🇮🇷 إيران',
        '90': '🇹🇷 تركيا',
        '91': '🇮🇳 الهند',
        '880': '🇧🇩 بنجلاديش',
        '60': '🇲🇾 ماليزيا',
        '62': '🇮🇩 إندونيسيا',
        '63': '🇵🇭 الفلبين',
        '94': '🇱🇰 سريلانكا',
        '95': '🇲🇲 ميانمار',
        '673': '🇧🇳 بروناي',
        '670': '🇹🇱 تيمور الشرقية'
    };
    return names[code] || '🌍 أخرى';
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

// [تم التعديل] إضافة التحقق من الإصدار
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName, version } = req.query;
        console.log(`🔍 فحص الجهاز: ${id} للتطبيق: ${appName} الإصدار: ${version || 'غير محدد'}`);
        
        const snap = await db.collection('users')
            .where("deviceId", "==", id)
            .where("appName", "==", appName)
            .get();
        
        if (!snap.empty) {
            // التحقق من تطابق الإصدار
            const userData = snap.docs[0].data();
            const savedVersion = userData.appVersion || '1.0';
            
            if (version && savedVersion !== version) {
                console.log(`📱 إصدار مختلف: المتوقع ${savedVersion}، المستلم ${version}`);
                return res.status(409).send("VERSION_MISMATCH");
            }
            
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
        const { phone, name, app: appName, deviceId, version } = req.query;
        
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
            appVersion: version || '1.0',
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
            appVersion: version || '1.0',
            originalPhone: phone,
            countryCode: formatted.countryCode,
            nationalNumber: formatted.nationalNumber,
            fullNumber: formatted.fullNumber,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`📦 تم تخزين الكود ${otp} للجهاز ${deviceId} (الإصدار: ${version || '1.0'})`);
        
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
        
        // [تم التعديل] حفظ رقم الإصدار مع المستخدم
        await db.collection('users').doc(userKey).set({ 
            name: codeData.name,
            phone: finalPhone,
            appName: codeData.appName,
            deviceId: codeData.deviceId,
            appVersion: codeData.appVersion || '1.0',
            verifiedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        console.log(`✅ تم تسجيل المستخدم: ${userKey} (الإصدار: ${codeData.appVersion || '1.0'})`);
        
        // إرسال إشعار للمالك عبر الواتساب مع اسم الدولة
        try {
            const ownerJid = getJidFromPhone(OWNER_NUMBER);
            const now = new Date();
            const dateStr = now.toLocaleDateString('ar-EG');
            const timeStr = now.toLocaleTimeString('ar-EG');
            
            const countryDisplay = codeData.formattedPhone?.countryName || getCountryName(codeData.formattedPhone?.countryCode) || '🌍 أخرى';
            
            const message = `🆕 *مستخدم جديد اشترك!*\n\n` +
                            `👤 *الاسم:* ${codeData.name}\n` +
                            `📱 *رقم الهاتف:* ${finalPhone}\n` +
                            `🌍 *الدولة:* ${countryDisplay}\n` +
                            `📲 *التطبيق:* ${codeData.appName}\n` +
                            `📱 *الإصدار:* ${codeData.appVersion || '1.0'}\n` +
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
                const appVersion = doc.data().appVersion || '1.0';
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
