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
const bannedDevices = new Set(); // للأجهزة المحظورة
const bannedPhones = new Set(); // للأرقام المحظورة

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
        } else {
            console.log("⚠️ البوت غير متصل، لا يمكن الإرسال");
        }
    } catch (e) { 
        console.log("⚠️ فشل الإرسال:", e.message); 
    }
}

// دالة إرسال رسالة تيليجرام
async function sendTelegram(chatId, text) {
    try {
        if (!TELEGRAM_BOT_TOKEN) return;
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

// دالة الحصول على اسم الدولة (كانت مفقودة في الكود السابق)
function getCountryName(code) {
    const names = {
        '966': '🇸🇦 السعودية',
        '20': '🇪🇬 مصر',
        '974': '🇶🇦 قطر',
        '973': '🇧🇭 البحرين',
        '968': '🇴🇲 عمان',
        '965': '🇰🇼 الكويت',
        '971': '🇦🇪 الإمارات',
        '967': '🇾🇪 اليمن',
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
        '673': '🇧🇳 بروناي',
        '670': '🇹🇱 تيمور الشرقية',
        '970': '🇵🇸 فلسطين',
        '253': '🇩🇯 جيبوتي',
        '269': '🇰🇲 جزر القمر',
        '994': '🇦🇿 أذربايجان',
        '7': '🇰🇿 كازاخستان',
        '993': '🇹🇲 تركمانستان',
        '998': '🇺🇿 أوزبكستان',
        '992': '🇹🇯 طاجيكستان',
        '996': '🇰🇬 قيرغيزستان'
    };
    return names[code] || '🌍 أخرى';
}

// دالة ذكية لتنسيق الأرقام من أي صيغة يدخلها المستخدم
function formatPhoneNumber(phone) {
    // 1. تنظيف الرقم من جميع الرموز غير الرقمية
    let cleaned = phone.replace(/\D/g, '');
    
    // إذا كان الرقم فارغاً أو أقصر من 7 أرقام
    if (!cleaned || cleaned.length < 7) {
        return {
            nationalNumber: cleaned,
            countryCode: 'XX',
            fullNumber: null,
            isValid: false,
            countryName: 'رقم غير صالح'
        };
    }

    console.log(`🧹 الرقم بعد التنظيف: ${cleaned}`);

    // 2. قائمة بكل مفاتيح الدول المدعومة
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
        { code: '62', name: '🇮🇩 إندونيسيا', length: 10, startsWith: ['8'] },
        { code: '63', name: '🇵🇭 الفلبين', length: 10, startsWith: ['9'] },
        { code: '94', name: '🇱🇰 سريلانكا', length: 9, startsWith: ['7'] },
        { code: '673', name: '🇧🇳 بروناي', length: 7, startsWith: ['2'] },
        { code: '670', name: '🇹🇱 تيمور الشرقية', length: 8, startsWith: ['7'] },
        { code: '970', name: '🇵🇸 فلسطين', length: 9, startsWith: ['5', '6'] },
        { code: '253', name: '🇩🇯 جيبوتي', length: 6, startsWith: ['2'] },
        { code: '269', name: '🇰🇲 جزر القمر', length: 7, startsWith: ['3'] },
        { code: '994', name: '🇦🇿 أذربايجان', length: 9, startsWith: ['4', '5'] },
        { code: '7', name: '🇰🇿 كازاخستان', length: 10, startsWith: ['7'] },
        { code: '993', name: '🇹🇲 تركمانستان', length: 8, startsWith: ['6'] },
        { code: '998', name: '🇺🇿 أوزبكستان', length: 9, startsWith: ['9'] },
        { code: '992', name: '🇹🇯 طاجيكستان', length: 9, startsWith: ['9'] },
        { code: '996', name: '🇰🇬 قيرغيزستان', length: 9, startsWith: ['5'] }
    ];

    // 3. محاولة التعرف على الرقم باستخدام مكتبة libphonenumber
    try {
        const phoneNumber = parsePhoneNumberFromString(phone);
        if (phoneNumber && phoneNumber.isValid()) {
            console.log(`✅ المكتبة عرفت الرقم: ${phoneNumber.number}`);
            return {
                nationalNumber: phoneNumber.nationalNumber,
                countryCode: phoneNumber.countryCallingCode,
                fullNumber: phoneNumber.number,
                isValid: true,
                countryName: countryCodes.find(c => c.code == phoneNumber.countryCallingCode)?.name || '🌍 أخرى'
            };
        }
    } catch (e) {
        // إذا فشلت، نكمل
    }

    // 4. التحليل اليدوي
    
    // إزالة الصفر البادئ
    let numberToAnalyze = cleaned;
    if (numberToAnalyze.startsWith('0')) {
        numberToAnalyze = numberToAnalyze.substring(1);
    }

    // البحث عن مفتاح الدولة
    let detectedCountry = null;
    for (const country of countryCodes) {
        if (numberToAnalyze.startsWith(country.code)) {
            const nationalPart = numberToAnalyze.substring(country.code.length);
            if (nationalPart.length === country.length) {
                detectedCountry = {
                    ...country,
                    nationalNumber: nationalPart
                };
                break;
            }
        }
    }

    if (detectedCountry) {
        console.log(`✅ تم التعرف على الدولة من المفتاح: ${detectedCountry.name}`);
        return {
            nationalNumber: detectedCountry.nationalNumber,
            countryCode: detectedCountry.code,
            fullNumber: `+${detectedCountry.code}${detectedCountry.nationalNumber}`,
            isValid: true,
            countryName: detectedCountry.name
        };
    }

    // البحث في بقية الرقم
    for (const country of countryCodes) {
        if (numberToAnalyze.length === country.length) {
            for (const start of country.startsWith) {
                if (numberToAnalyze.startsWith(start)) {
                    console.log(`✅ تم التعرف على الدولة من طول وبداية الرقم: ${country.name}`);
                    return {
                        nationalNumber: numberToAnalyze,
                        countryCode: country.code,
                        fullNumber: `+${country.code}${numberToAnalyze}`,
                        isValid: true,
                        countryName: country.name
                    };
                }
            }
        }
    }

    // إذا لم نتمكن من التحديد، نستخدم مفتاح افتراضي
    console.log(`⚠️ لم نتمكن من تحديد الدولة، سنستخدم المفتاح الافتراضي 966`);
    return {
        nationalNumber: numberToAnalyze,
        countryCode: '966',
        fullNumber: `+966${numberToAnalyze}`,
        isValid: true,
        countryName: '🇸🇦 السعودية (تقديري)'
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

// --- 4. تحميل الأجهزة المحظورة من Firebase ---
async function loadBannedDevices() {
    try {
        const bannedSnapshot = await db.collection('banned').get();
        bannedSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.deviceId) bannedDevices.add(data.deviceId);
            if (data.phone) bannedPhones.add(data.phone);
        });
        console.log(`🚫 تم تحميل ${bannedDevices.size} جهاز محظور و ${bannedPhones.size} رقم محظور`);
    } catch (error) {
        console.log("⚠️ فشل تحميل الأجهزة المحظورة");
    }
}

// --- 5. تعريف دالة startBot ---
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
            
            // إرسال رسالة تأكيد للمالك عند الاتصال
            try {
                const ownerJid = getJidFromPhone(OWNER_NUMBER);
                await safeSend(ownerJid, { text: "✅ البوت متصل وجاهز للعمل" });
            } catch (e) {}
        }
        if (connection === 'close') {
            isStarting = false;
            const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (code !== DisconnectReason.loggedOut) {
                console.log("⚠️ الاتصال مغلق، إعادة محاولة بعد 10 ثواني...");
                setTimeout(() => startBot(), 10000);
            }
        }
    });
}

// --- 6. دوال النشر عبر الواتساب ---
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

// --- 7. دالة حظر جهاز أو رقم ---
async function banDevice(deviceId, phone, reason, chatId) {
    try {
        const banData = {
            deviceId: deviceId || null,
            phone: phone || null,
            reason: reason || "غير محدد",
            bannedAt: admin.firestore.FieldValue.serverTimestamp(),
            bannedBy: chatId
        };
        
        await db.collection('banned').add(banData);
        
        if (deviceId) bannedDevices.add(deviceId);
        if (phone) bannedPhones.add(phone);
        
        // حذف المستخدم إذا كان موجوداً
        if (deviceId) {
            const userSnapshot = await db.collection('users').where('deviceId', '==', deviceId).get();
            userSnapshot.docs.forEach(async doc => {
                await doc.ref.delete();
            });
        }
        
        return true;
    } catch (error) {
        console.log("❌ فشل حظر الجهاز:", error);
        return false;
    }
}

// --- 8. إعداد Webhook تيليجرام ---
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
// API المحسن للواتساب
// ============================================

// نقطة التحقق من الجهاز (مطورة)
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName, version } = req.query;
        console.log(`🔍 فحص الجهاز: ${id} للتطبيق: ${appName} الإصدار: ${version || 'غير محدد'}`);
        
        // التحقق من الحظر
        if (bannedDevices.has(id)) {
            console.log(`🚫 جهاز محظور: ${id}`);
            return res.status(403).send("DEVICE_BANNED");
        }
        
        // البحث عن المستخدم
        const snap = await db.collection('users')
            .where("deviceId", "==", id)
            .where("appName", "==", appName)
            .get();
        
        if (!snap.empty) {
            const userData = snap.docs[0].data();
            const savedVersion = userData.appVersion || '1.0';
            
            // التحقق من تطابق الإصدار
            if (version && savedVersion !== version) {
                console.log(`📱 إصدار مختلف: المتوقع ${savedVersion}، المستلم ${version}`);
                return res.status(409).send("VERSION_MISMATCH");
            }
            
            console.log(`✅ جهاز مصرح به: ${id}`);
            return res.status(200).send("SUCCESS");
        } else {
            console.log(`❌ جهاز غير مسجل: ${id}`);
            return res.status(404).send("NOT_FOUND");
        }
    } catch (error) {
        console.error("❌ خطأ في /check-device:", error);
        res.status(500).send("ERROR");
    }
});

// طلب كود التفعيل (مطور)
app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId, version } = req.query;
        
        console.log("=".repeat(50));
        console.log("📱 طلب كود جديد");
        console.log("=".repeat(50));
        console.log("الرقم الأصلي:", phone);
        console.log("التطبيق:", appName);
        console.log("الجهاز:", deviceId);
        
        // التحقق من الحظر
        if (bannedDevices.has(deviceId)) {
            console.log(`🚫 جهاز محظور: ${deviceId}`);
            return res.status(403).send("DEVICE_BANNED");
        }
        
        if (bannedPhones.has(phone)) {
            console.log(`🚫 رقم محظور: ${phone}`);
            return res.status(403).send("PHONE_BANNED");
        }
        
        const formatted = formatPhoneNumber(phone);
        console.log("الرقم بعد التنسيق:", formatted);
        
        if (!formatted.isValid || !formatted.fullNumber) {
            console.log("❌ رقم غير صالح بعد التنسيق");
            return res.status(400).send("INVALID_NUMBER");
        }
        
        // التحقق من عدم وجود مستخدم بنفس الجهاز ولكن تطبيق مختلف
        const existingUser = await db.collection('users')
            .where("deviceId", "==", deviceId)
            .where("appName", "!=", appName)
            .get();
        
        if (!existingUser.empty) {
            console.log(`⚠️ الجهاز ${deviceId} مسجل لتطبيق آخر`);
        }
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        const codeData = {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName,
            deviceId: deviceId,
            appVersion: version || '1.0',
            originalPhone: phone,
            formattedPhone: formatted,
            timestamp: Date.now(),
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.headers['user-agent']
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
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.headers['user-agent'],
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`📦 تم تخزين الكود ${otp} للجهاز ${deviceId} (التطبيق: ${appName})`);
        
        // إرسال الكود عبر الواتساب
        const jid = formatted.fullNumber.replace('+', '') + "@s.whatsapp.net";
        const sent = await safeSend(jid, { 
            text: `🔐 مرحباً ${name}، كود تفعيل تطبيق ${appName} هو: *${otp}*` 
        });
        
        if (sent) {
            console.log(`✅ تم إرسال الكود بنجاح إلى ${jid}`);
        } else {
            console.log(`⚠️ فشل إرسال الكود إلى ${jid}`);
        }
        
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ في /request-otp:", error);
        res.status(500).send("ERROR");
    }
});

// التحقق من الكود (مطور)
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
            return res.status(401).send("EXPIRED");
        }
        
        // التحقق من الحظر مرة أخرى
        if (bannedDevices.has(codeData.deviceId)) {
            console.log(`🚫 جهاز محظور: ${codeData.deviceId}`);
            return res.status(403).send("DEVICE_BANNED");
        }
        
        if (bannedPhones.has(codeData.originalPhone)) {
            console.log(`🚫 رقم محظور: ${codeData.originalPhone}`);
            return res.status(403).send("PHONE_BANNED");
        }
        
        console.log(`🎉 تحقق ناجح!`);
        
        const finalPhone = codeData.formattedPhone?.fullNumber?.replace('+', '') || 
                          codeData.fullNumber?.replace('+', '') || 
                          phone.replace(/\D/g, '');
        
        // استخدام مفتاح مركب: deviceId_appName
        const userKey = codeData.deviceId + "_" + codeData.appName;
        
        await db.collection('users').doc(userKey).set({ 
            name: codeData.name,
            phone: finalPhone,
            originalPhone: codeData.originalPhone,
            appName: codeData.appName,
            deviceId: codeData.deviceId,
            appVersion: codeData.appVersion || '1.0',
            countryCode: codeData.formattedPhone?.countryCode || codeData.countryCode,
            nationalNumber: codeData.formattedPhone?.nationalNumber || codeData.nationalNumber,
            ip: codeData.ip,
            userAgent: codeData.userAgent,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        console.log(`✅ تم تسجيل المستخدم: ${userKey} (الإصدار: ${codeData.appVersion || '1.0'})`);
        
        // إرسال إشعار للمالك
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
                            `🆔 *معرف الجهاز:* ${codeData.deviceId}\n` +
                            `📅 *التاريخ:* ${dateStr} ${timeStr}`;
            
            await safeSend(ownerJid, { text: message });
            console.log(`✅ تم إرسال إشعار للمالك`);
        } catch (e) {
            console.log(`⚠️ فشل إرسال إشعار للمالك:`, e.message);
        }
        
        pendingCodes.delete(code);
        await db.collection('pending_codes').doc(code).delete();
        
        return res.status(200).send("SUCCESS");
        
    } catch (error) {
        console.error("❌ خطأ في /verify-otp:", error);
        res.status(500).send("FAIL");
    }
});

// ============================================
// Webhook تيليجرام للتحكم (مطور مع أمر حظر)
// ============================================

app.post("/telegram-webhook", async (req, res) => {
    try {
        const message = req.body.message;
        if (!message) return res.sendStatus(200);
        
        const chatId = message.chat.id;
        const text = message.text;
        const userId = message.from.id;
        
        if (userId.toString() !== TELEGRAM_ADMIN_ID) {
            await sendTelegram(chatId, "⛔ أنت غير مصرح باستخدام هذا البوت.");
            return res.sendStatus(200);
        }
        
        const currentState = telegramStates.get(chatId);
        
        if (currentState) {
            if (text === "إلغاء") {
                telegramStates.delete(chatId);
                await sendTelegram(chatId, "❌ تم إلغاء العملية.");
                return res.sendStatus(200);
            }
            
            if (currentState.command === "نشر") {
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
                    
                    await publishToWhatsApp(selectedApp, currentState.link, currentState.desc, chatId);
                    
                    return res.sendStatus(200);
                }
            }
            
            if (currentState.command === "حظر") {
                if (currentState.step === "waiting_device_id") {
                    currentState.deviceId = text;
                    currentState.step = "waiting_phone";
                    telegramStates.set(chatId, currentState);
                    await sendTelegram(chatId, "✅ تم استلام معرف الجهاز.\nالآن أرسل *رقم الهاتف* (أو أرسل *تخطي* إذا لم يكن متوفراً):");
                    return res.sendStatus(200);
                }
                
                if (currentState.step === "waiting_phone") {
                    currentState.phone = text === "تخطي" ? null : text;
                    currentState.step = "waiting_reason";
                    telegramStates.set(chatId, currentState);
                    await sendTelegram(chatId, "✅ تم استلام رقم الهاتف.\nالآن أرسل *سبب الحظر*:");
                    return res.sendStatus(200);
                }
                
                if (currentState.step === "waiting_reason") {
                    const success = await banDevice(currentState.deviceId, currentState.phone, text, chatId);
                    
                    if (success) {
                        await sendTelegram(chatId, `✅ *تم حظر الجهاز بنجاح!*\n\n📱 معرف الجهاز: ${currentState.deviceId}\n📞 الرقم: ${currentState.phone || 'غير محدد'}\n📝 السبب: ${text}`);
                    } else {
                        await sendTelegram(chatId, "❌ *فشل حظر الجهاز!*");
                    }
                    
                    telegramStates.delete(chatId);
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
            const bannedSnap = await db.collection('banned').get();
            const pendingSnap = await db.collection('pending_codes').get();
            
            const appStats = {};
            usersSnap.docs.forEach(doc => {
                const appName = doc.data().appName || 'غير معروف';
                appStats[appName] = (appStats[appName] || 0) + 1;
            });
            
            let statsText = "📊 *إحصائيات النظام:*\n\n";
            statsText += `👥 *إجمالي المستخدمين:* ${usersSnap.size}\n`;
            statsText += `🚫 *الأجهزة المحظورة:* ${bannedSnap.size}\n`;
            statsText += `⏳ *الطلبات المعلقة:* ${pendingSnap.size}\n\n`;
            statsText += "📱 *حسب التطبيق:*\n";
            
            if (Object.keys(appStats).length === 0) {
                statsText += "• لا يوجد مستخدمين بعد\n";
            } else {
                for (const [app, count] of Object.entries(appStats).sort((a, b) => b[1] - a[1])) {
                    statsText += `• ${app}: ${count} مستخدم\n`;
                }
            }
            
            await sendTelegram(chatId, statsText);
        }
        else if (text === "نجم حالة") {
            const usersSnap = await db.collection('users').get();
            const bannedSnap = await db.collection('banned').get();
            
            const statusText = `⚡ *حالة البوت:*\n\n` +
                              `✅ *حالة الاتصال:* ${sock && sock.user ? 'متصل' : 'غير متصل'}\n` +
                              `👥 *عدد المستخدمين:* ${usersSnap.size}\n` +
                              `🚫 *عدد المحظورين:* ${bannedSnap.size}\n` +
                              `💾 *الذاكرة:* ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB\n` +
                              `⏰ *وقت التشغيل:* ${Math.round(process.uptime() / 60)} دقيقة`;
            
            await sendTelegram(chatId, statusText);
        }
        else if (text === "نجم حضر") {
            telegramStates.set(chatId, { command: "حظر", step: "waiting_device_id" });
            await sendTelegram(chatId, "🚫 *خطوة 1/3 - حظر جهاز*\nأرسل *معرف الجهاز (deviceId)*:");
        }
        else if (text === "نجم مسح") {
            const pendingSnap = await db.collection('pending_codes').get();
            let deletedCount = 0;
            
            for (const doc of pendingSnap.docs) {
                const data = doc.data();
                const createdAt = data.createdAt?.toDate?.() || new Date(data.timestamp || 0);
                const ageMinutes = (Date.now() - createdAt.getTime()) / (1000 * 60);
                
                if (ageMinutes > 30) {
                    await doc.ref.delete();
                    deletedCount++;
                }
            }
            
            await sendTelegram(chatId, `🧹 *تم تنظيف ${deletedCount} كود منتهي الصلاحية*`);
        }
        else {
            const helpText = `🌟 *الأوامر المتاحة:*\n\n` +
                            `📢 *نجم نشر* - لنشر إعلان جديد\n` +
                            `📊 *نجم احصا* - لعرض الإحصائيات\n` +
                            `⚡ *نجم حالة* - لعرض حالة البوت\n` +
                            `🚫 *نجم حضر* - لحظر جهاز أو رقم\n` +
                            `🧹 *نجم مسح* - لتنظيف الأكواد المنتهية\n\n` +
                            `💡 يمكنك إلغاء أي عملية بكتابة *إلغاء*`;
            
            await sendTelegram(chatId, helpText);
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ خطأ في تيليجرام:", error);
        res.sendStatus(200);
    }
});

// نقطة لجلب الأجهزة المحظورة
app.get("/banned-list", async (req, res) => {
    try {
        const bannedSnapshot = await db.collection('banned').get();
        const bannedList = bannedSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            bannedAt: doc.data().bannedAt?.toDate?.() || null
        }));
        
        res.json(bannedList);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// نقطة لحذف مستخدم
app.delete("/user/:deviceId/:appName", async (req, res) => {
    try {
        const { deviceId, appName } = req.params;
        const userKey = deviceId + "_" + appName;
        
        await db.collection('users').doc(userKey).delete();
        res.status(200).send("DELETED");
    } catch (error) {
        res.status(500).send("ERROR");
    }
});

// ============================================
// الصفحات العامة
// ============================================

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => {
    if (qrImage === "DONE") {
        res.send(`
            <html>
                <head><title>بوت التفعيل</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1 style="color: green;">✅ البوت يعمل</h1>
                    <p>📊 الإحصائيات: <span id="stats">جاري التحميل...</span></p>
                    <script>
                        fetch('/stats')
                            .then(r => r.json())
                            .then(d => {
                                document.getElementById('stats').innerText = 
                                    \`المستخدمين: \${d.users} | المحظورين: \${d.banned}\`;
                            });
                    </script>
                </body>
            </html>
        `);
    } else if (qrImage) {
        res.send(`<html><body style="text-align: center; padding: 20px;"><img src="${qrImage}" style="max-width: 300px;"></body></html>`);
    } else {
        res.send("⏳ جاري التحميل...");
    }
});

app.get("/stats", async (req, res) => {
    try {
        const usersSnap = await db.collection('users').get();
        const bannedSnap = await db.collection('banned').get();
        const pendingSnap = await db.collection('pending_codes').get();
        
        res.json({
            users: usersSnap.size,
            banned: bannedSnap.size,
            pending: pendingSnap.size,
            uptime: process.uptime(),
            memory: process.memoryUsage()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
    
    await loadBannedDevices();
    await setupTelegramWebhook();
    startBot();
});
