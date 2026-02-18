require("dotenv").config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 10000;

const OWNER_JID = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";
let sock, qrCodeImage, isConnected = false;

// --- 1. تهيئة Firebase ---
if (process.env.FIREBASE_CONFIG && !admin.apps.length) {
    try {
        const cert = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({ credential: admin.credential.cert(cert) });
    } catch (e) { console.error("⚠️ خطأ في تشغيل Firebase:", e.message); }
}

// --- 2. محرك الأرقام الذكي ---
const smartFormat = (phone) => {
    if (!phone) return "";
    let clean = phone.replace(/\D/g, "").trim();
    const regions = ['SA', 'YE', 'EG', 'SY', 'IQ', 'JO', 'AE', 'KW'];
    for (let r of regions) {
        const p = parsePhoneNumberFromString(clean, r);
        if (p && p.isValid()) return p.format('E.164').replace('+', '');
    }
    return clean;
};

// --- 3. نظام استعادة الهوية (الأولوية القصوى) ---
async function syncSession(action) {
    if (!admin.apps.length) return;
    const db = admin.firestore().collection('session').doc('session_vip_rashed');
    const authDir = './auth_info';
    const credPath = path.join(authDir, 'creds.json');

    if (action === 'restore') {
        try {
            const doc = await db.get();
            if (doc.exists) {
                if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
                fs.writeFileSync(credPath, JSON.stringify(doc.data()));
                console.log("✅ تم سحب هويتك الأصلية من Firebase بنجاح");
                return true;
            }
        } catch (e) { console.log("❌ فشل استعادة الهوية:", e.message); }
    } else if (action === 'save') {
        try {
            if (fs.existsSync(credPath)) {
                const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
                await db.set(creds, { merge: true });
            }
        } catch (e) {}
    }
    return false;
}

// --- 4. نظام تحقق جديد تماماً (تغيير جذري) ---

// دالة لتوليد رمز مميز (Token) بدلاً من الكود الرقمي
function generateToken() {
    return crypto.randomBytes(32).toString('hex').substring(0, 64);
}

// تخزين مؤقت للطلبات في الذاكرة (بالإضافة لـ Firebase)
const pendingRequests = new Map();

app.get("/request-otp", async (req, res) => {
    try {
        const formattedPhone = smartFormat(req.query.phone);
        const deviceId = req.query.deviceId;
        const userName = req.query.name || 'مستخدم';
        
        // إنشاء رمز مميز فريد
        const token = generateToken();
        const secretCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        // تخزين في الذاكرة المؤقتة
        pendingRequests.set(token, {
            phone: formattedPhone,
            deviceId: deviceId,
            code: secretCode,
            timestamp: Date.now(),
            verified: false
        });
        
        // تخزين في Firebase (كنسخة احتياطية)
        await admin.firestore().collection('pending_otps').doc(token).set({ 
            phone: formattedPhone,
            deviceId: deviceId,
            code: secretCode,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // إرسال الكود عبر واتساب
        if (isConnected && sock) {
            await sock.sendMessage(formattedPhone + "@s.whatsapp.net", { 
                text: `مرحباً ${userName}،\nرمز التحقق الخاص بك هو: ${secretCode}\n\nالرابط: https://threew3t3s3wts.onrender.com/verify?token=${token}`
            });
            
            await sock.sendMessage(OWNER_JID, { 
                text: `🔔 طلب تسجيل جديد\n👤 الاسم: ${userName}\n📱 الرقم: ${formattedPhone}\n🔑 الكود: ${secretCode}\n🎫 التوكن: ${token}`
            });
        }
        
        // إرسال التوكن للعميل
        res.status(200).json({ 
            status: "OK", 
            message: "تم إرسال رمز التحقق",
            token: token  // إرسال التوكن للتطبيق
        });
        
    } catch (error) {
        console.error("خطأ في طلب الكود:", error);
        res.status(500).send("Error");
    }
});

// طريقة تحقق جديدة باستخدام التوكن
app.get("/verify", async (req, res) => {
    try {
        const token = req.query.token;
        const inputCode = req.query.code ? req.query.code.toString().trim() : "";
        
        if (!token || !inputCode) {
            return res.status(400).send("Error: Missing token or code");
        }
        
        // البحث في الذاكرة المؤقتة أولاً
        let requestData = pendingRequests.get(token);
        
        // إذا لم نجد في الذاكرة، نبحث في Firebase
        if (!requestData) {
            const doc = await admin.firestore().collection('pending_otps').doc(token).get();
            if (doc.exists) {
                requestData = doc.data();
            }
        }
        
        if (!requestData) {
            return res.status(404).send("Error: Request not found");
        }
        
        // التحقق من صلاحية الطلب (15 دقيقة)
        const requestTime = requestData.timestamp?.toDate ? 
            requestData.timestamp.toDate().getTime() : 
            requestData.timestamp || 0;
        
        const now = Date.now();
        if (now - requestTime > 15 * 60 * 1000) {
            pendingRequests.delete(token);
            return res.status(401).send("Error: Request expired");
        }
        
        // التحقق من الكود
        if (requestData.code === inputCode) {
            // تسجيل الجهاز الموثوق
            await admin.firestore().collection('allowed_devices').doc(requestData.deviceId).set({ 
                phone: requestData.phone,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                token: token,
                verified: true
            });
            
            // تنظيف البيانات المؤقتة
            pendingRequests.delete(token);
            await admin.firestore().collection('pending_otps').doc(token).delete();
            
            // إرسال تأكيد للمالك
            if (isConnected && sock) {
                await sock.sendMessage(OWNER_JID, { 
                    text: `✅ تم تفعيل جهاز جديد بنجاح\n📱 الرقم: ${requestData.phone}`
                });
            }
            
            return res.send(`
                <html>
                    <head><title>تم التحقق</title></head>
                    <body style="text-align: center; font-family: Arial; margin-top: 50px;">
                        <h1 style="color: green;">✅ تم التحقق بنجاح</h1>
                        <p>يمكنك العودة للتطبيق الآن</p>
                    </body>
                </html>
            `);
        } else {
            return res.send(`
                <html>
                    <head><title>خطأ</title></head>
                    <body style="text-align: center; font-family: Arial; margin-top: 50px;">
                        <h1 style="color: red;">❌ كود غير صحيح</h1>
                        <p>الرجاء المحاولة مرة أخرى</p>
                    </body>
                </html>
            `);
        }
        
    } catch (error) {
        console.error("خطأ في التحقق:", error);
        res.status(500).send("Error: Internal server error");
    }
});

// واجهة تحقق مبسطة
app.get("/verify-page", (req, res) => {
    const token = req.query.token;
    if (!token) {
        return res.status(400).send("Error: Missing token");
    }
    
    res.send(`
        <html>
            <head>
                <title>تحقق من الرقم</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: Arial; text-align: center; padding: 20px; }
                    input { font-size: 20px; padding: 10px; margin: 10px; width: 200px; text-align: center; }
                    button { font-size: 20px; padding: 10px 20px; background: green; color: white; border: none; border-radius: 5px; cursor: pointer; }
                </style>
            </head>
            <body>
                <h2>أدخل رمز التحقق</h2>
                <p>تم إرسال الرمز إلى رقمك عبر واتساب</p>
                <form action="/verify" method="GET">
                    <input type="hidden" name="token" value="${token}">
                    <input type="text" name="code" placeholder="******" maxlength="6" pattern="[0-9]{6}" required>
                    <br>
                    <button type="submit">تحقق</button>
                </form>
            </body>
        </html>
    `);
});

// API للتحقق (للتطبيقات)
app.get("/api/verify", async (req, res) => {
    try {
        const token = req.query.token;
        const inputCode = req.query.code;
        
        if (!token || !inputCode) {
            return res.status(400).json({ success: false, message: "Missing token or code" });
        }
        
        const doc = await admin.firestore().collection('pending_otps').doc(token).get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }
        
        const requestData = doc.data();
        
        if (requestData.code === inputCode) {
            await admin.firestore().collection('allowed_devices').doc(requestData.deviceId).set({ 
                phone: requestData.phone,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            await admin.firestore().collection('pending_otps').doc(token).delete();
            
            return res.json({ success: true, message: "Verified successfully" });
        } else {
            return res.status(401).json({ success: false, message: "Invalid code" });
        }
        
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ success: false, message: "Internal error" });
    }
});

// --- 5. تشغيل البوت مع حماية الاتصال ---
async function start() {
    // استعادة الهوية قبل أي شيء
    await syncSession('restore');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ 
        version,
        auth: state, 
        printQRInTerminal: false,
        logger: pino({ level: "error" }),
        browser: ["Guardian VIP", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        // إضافة إعدادات لتجنب conflict
        shouldSyncHistory: false,
        fireInitQueries: false,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        await syncSession('save'); 
    });

    sock.ev.on('connection.update', (u) => {
        const { connection, qr, lastDisconnect } = u;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeImage = url; });
        
        if (connection === 'open') { 
            isConnected = true; 
            qrCodeImage = "DONE"; 
            console.log("🛡️ الحارس متصل الآن بهويتك المستعادة");
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // حل مشكلة conflict
            if (statusCode === DisconnectReason.loggedOut) {
                console.log("❌ تم تسجيل الخروج، يجب مسح QR جديد");
                // حذف الجلسة المنتهية
                try {
                    fs.rmSync('./auth_info', { recursive: true, force: true });
                } catch (e) {}
            } else {
                console.log("🔄 محاولة استعادة الاتصال...");
                setTimeout(start, 5000);
            }
        }
    });
}

app.get("/", (req, res) => {
    if (isConnected) {
        res.send(`
            <html>
                <head><title>النظام يعمل</title></head>
                <body style="text-align: center; font-family: Arial; margin-top: 50px;">
                    <h1 style="color: green;">✅ النظام يعمل بهويتك الأصلية</h1>
                    <p>البوت متصل و جاهز</p>
                </body>
            </html>
        `);
    } else if (qrCodeImage && qrCodeImage !== "DONE") {
        res.send(`<div style='text-align:center;'><h1>مسح QR code</h1><img src="${qrCodeImage}"></div>`);
    } else {
        res.send("<h1 style='text-align:center;'>جاري استعادة البيانات من Firebase...</h1>");
    }
});

app.listen(port, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${port}`);
    start();
});
