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

// --- تخزين مؤقت في الذاكرة (مفتاح: الكود نفسه) ---
const pendingCodes = new Map(); // مفتاح: الكود, قيمة: كل البيانات

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

// دالة الإرسال الآمن
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال"); }
}

// دالة عالمية لتنسيق الأرقام (تتعامل مع كل الصيغ)
function formatPhoneNumber(phone) {
    // إزالة كل الرموز غير الرقمية
    let clean = phone.replace(/\D/g, '');
    
    // محاولة تحليل الرقم بالمكتبة العالمية
    try {
        const phoneNumber = parsePhoneNumberFromString('+' + clean);
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                nationalNumber: phoneNumber.nationalNumber, // الرقم المحلي
                countryCode: phoneNumber.countryCallingCode, // مفتاح الدولة
                fullNumber: phoneNumber.number, // الرقم كامل مع +
                isValid: true
            };
        }
    } catch (e) {}
    
    // إذا فشل التحليل، نستخدم الطريقة اليدوية
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    
    // تحديد مفتاح الدولة بناءً على طول الرقم وبادئته
    let countryCode = '966'; // افتراضي سعودي
    let nationalNumber = clean;
    
    if (clean.length === 12 && clean.startsWith('966')) { // 966554526287
        nationalNumber = clean.substring(3);
        countryCode = '966';
    } else if (clean.length === 12 && clean.startsWith('967')) { // 967782203551
        nationalNumber = clean.substring(3);
        countryCode = '967';
    } else if (clean.length === 11 && clean.startsWith('974')) { // 97433567890
        nationalNumber = clean.substring(3);
        countryCode = '974';
    } else if (clean.length === 9 && clean.startsWith('5')) { // 554526287
        countryCode = '966';
    } else if (clean.length === 9 && clean.startsWith('7')) { // 782203551
        countryCode = '967';
    } else if (clean.length === 8 && /^[34567]/.test(clean)) { // 33567890
        countryCode = '974';
    }
    
    return {
        nationalNumber: nationalNumber,
        countryCode: countryCode,
        fullNumber: '+' + countryCode + nationalNumber,
        isValid: true
    };
}

// دالة للإرسال (تحتاج الرقم بصيغة محددة)
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

// ============================================
// API محكم - يربط الكود بكل البيانات
// ============================================

// فحص الجهاز
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

// طلب كود
app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        
        console.log("=".repeat(50));
        console.log("📱 طلب كود جديد");
        console.log("=".repeat(50));
        console.log("الرقم الأصلي:", phone);
        
        // تنسيق الرقم
        const formatted = formatPhoneNumber(phone);
        console.log("الرقم بعد التنسيق:", formatted);
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // البيانات الكاملة (مرتبطة بالكود نفسه)
        const codeData = {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName,
            deviceId: deviceId,
            originalPhone: phone,
            formattedPhone: formatted,
            timestamp: Date.now()
        };
        
        // تخزين في الذاكرة (مفتاح: الكود نفسه)
        pendingCodes.set(otp, codeData);
        
        // تخزين في Firebase (مفتاح: الكود نفسه)
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
        
        console.log(`📦 تم تخزين الكود ${otp} مع البيانات:`);
        console.log(`   - الاسم: ${name}`);
        console.log(`   - التطبيق: ${appName}`);
        console.log(`   - الجهاز: ${deviceId}`);
        
        // إرسال الكود
        const jid = getJidFromPhone(phone);
        console.log(`📱 جاري الإرسال إلى: ${jid}`);
        
        await safeSend(jid, { 
            text: `🔐 مرحباً ${name}، كود تفعيل تطبيق ${appName} هو: *${otp}*` 
        });
        
        console.log(`✅ تم الإرسال بنجاح`);
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

// التحقق من الكود - مع إرسال إشعار للمالك
app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        
        console.log("=".repeat(50));
        console.log("🔍 محاولة تحقق");
        console.log("=".repeat(50));
        console.log("الرقم المرسل:", phone);
        console.log("الكود المرسل:", code);
        
        // البحث بالكود فقط (لا داعي للرقم)
        console.log(`🔍 البحث عن الكود ${code}...`);
        
        // 1. البحث في الذاكرة
        let codeData = pendingCodes.get(code);
        let source = "memory";
        
        // 2. إذا لم يوجد، ابحث في Firebase
        if (!codeData) {
            console.log(`🔍 البحث في Firebase...`);
            const fbDoc = await db.collection('pending_codes').doc(code).get();
            if (fbDoc.exists) {
                codeData = fbDoc.data();
                source = "firebase";
            }
        }
        
        // 3. إذا لم يوجد نهائياً
        if (!codeData) {
            console.log(`❌ الكود ${code} غير موجود`);
            return res.status(401).send("FAIL");
        }
        
        console.log(`✅ تم العثور على الكود (${source})`);
        console.log(`📱 البيانات المخزنة:`);
        console.log(`   - الاسم: ${codeData.name}`);
        console.log(`   - التطبيق: ${codeData.appName}`);
        console.log(`   - الجهاز: ${codeData.deviceId}`);
        
        // 4. التحقق من الصلاحية (10 دقائق)
        const timestamp = codeData.timestamp || (codeData.createdAt?.toDate?.()?.getTime() || 0);
        const now = Date.now();
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية (${diffMinutes.toFixed(1)} دقيقة)`);
            pendingCodes.delete(code);
            await db.collection('pending_codes').doc(code).delete();
            return res.status(401).send("FAIL");
        }
        
        // 5. نجاح التحقق
        console.log(`🎉 تحقق ناجح!`);
        
        // تنسيق الرقم النهائي
        const finalPhone = codeData.formattedPhone?.fullNumber?.replace('+', '') || 
                          codeData.fullNumber?.replace('+', '') || 
                          phone.replace(/\D/g, '');
        
        // مفتاح المستخدم (phone + appName)
        const userKey = finalPhone + "_" + codeData.appName;
        
        // تسجيل المستخدم
        await db.collection('users').doc(userKey).set({ 
            name: codeData.name,
            phone: finalPhone,
            appName: codeData.appName,
            deviceId: codeData.deviceId,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        console.log(`✅ تم تسجيل المستخدم: ${userKey}`);
        
        // ========== إرسال إشعار للمالك بالمستخدم الجديد ==========
        try {
            const ownerJid = getJidFromPhone(OWNER_NUMBER);
            
            // الحصول على التاريخ والوقت بالتنسيق العربي
            const now = new Date();
            const dateStr = now.toLocaleDateString('ar-EG', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
            const timeStr = now.toLocaleTimeString('ar-EG', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
            // تحديد رمز الدولة بالعربية
            const countryNames = {
                '966': '🇸🇦 السعودية',
                '967': '🇾🇪 اليمن',
                '974': '🇶🇦 قطر',
                'unknown': '🌍 أخرى'
            };
            const countryDisplay = countryNames[codeData.formattedPhone?.countryCode] || countryNames.unknown;
            
            const message = `🆕 *مستخدم جديد اشترك!*\n\n` +
                            `👤 *الاسم:* ${codeData.name}\n` +
                            `📱 *رقم الهاتف:* ${finalPhone}\n` +
                            `🌍 *الدولة:* ${countryDisplay}\n` +
                            `📲 *التطبيق:* ${codeData.appName}\n` +
                            `🆔 *معرف الجهاز:* ${codeData.deviceId}\n` +
                            `📅 *التاريخ:* ${dateStr}\n` +
                            `⏰ *الوقت:* ${timeStr}`;
            
            await safeSend(ownerJid, { text: message });
            console.log(`📨 تم إرسال إشعار للمالك بمستخدم جديد: ${codeData.name}`);
        } catch (notifyError) {
            console.log("⚠️ فشل إرسال إشعار للمالك:", notifyError.message);
        }
        // ====================================================
        
        // تنظيف الكود
        pendingCodes.delete(code);
        await db.collection('pending_codes').doc(code).delete();
        
        return res.status(200).send("SUCCESS");
        
    } catch (error) {
        console.error("❌ خطأ:", error);
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
    console.log(`🌐 الرابط: https://threew3t3s3wts.onrender.com`);
    console.log(`📱 رقم المالك: ${OWNER_NUMBER}`);
    console.log("=".repeat(50));
    startBot();
});
