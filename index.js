require("dotenv").config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
const port = process.env.PORT || 10000;

const OWNER_JID = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";
let sock, qrCodeImage, isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// --- 1. تهيئة Firebase ---
if (process.env.FIREBASE_CONFIG && !admin.apps.length) {
    try {
        const cert = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({ credential: admin.credential.cert(cert) });
        console.log("✅ Firebase initialized");
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

// --- 3. نظام استعادة الهوية ---
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
            } else {
                console.log("⚠️ لا توجد هوية محفوظة في Firebase");
            }
        } catch (e) { console.log("❌ فشل استعادة الهوية:", e.message); }
    } else if (action === 'save') {
        try {
            if (fs.existsSync(credPath)) {
                const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
                await db.set(creds, { merge: true });
                console.log("✅ تم حفظ الهوية في Firebase");
            }
        } catch (e) {}
    }
    return false;
}

// --- 4. مسار check-device المطلوب من التطبيق ---
app.get("/check-device", async (req, res) => {
    try {
        const deviceId = req.query.id;
        const appName = req.query.appName || "default";
        
        console.log(`🔍 فحص الجهاز: ${deviceId} للتطبيق: ${appName}`);
        
        // التحقق من وجود الجهاز في قاعدة البيانات
        const deviceDoc = await admin.firestore().collection('allowed_devices').doc(deviceId).get();
        
        if (deviceDoc.exists) {
            // الجهاز موثوق مسبقاً
            console.log(`✅ الجهاز موثوق: ${deviceId}`);
            return res.status(200).send("Verified");
        } else {
            // الجهاز غير موثوق، نطلب تسجيل الدخول
            console.log(`⚠️ جهاز غير موثوق: ${deviceId}`);
            return res.status(404).send("Device not verified");
        }
    } catch (error) {
        console.error("❌ خطأ في check-device:", error);
        res.status(500).send("Error");
    }
});

// --- 5. معالجة طلبات OTP (متوافقة مع تطبيقك) ---
app.get("/request-otp", async (req, res) => {
    try {
        const formattedPhone = smartFormat(req.query.phone);
        const deviceId = req.query.deviceId;
        const userName = req.query.name || 'مستخدم';
        const appName = req.query.app || 'default';
        
        console.log(`📱 طلب كود: ${formattedPhone} للجهاز: ${deviceId}`);
        
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // حفظ الكود في Firebase
        await admin.firestore().collection('pending_otps').doc(deviceId).set({ 
            phone: formattedPhone,
            code: code,
            deviceId: deviceId,
            userName: userName,
            appName: appName,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            verified: false
        });
        
        // إرسال الكود عبر واتساب إذا كان البوت متصلاً
        if (isConnected && sock) {
            try {
                await sock.sendMessage(formattedPhone + "@s.whatsapp.net", { 
                    text: `مرحباً ${userName}،\n\n📱 كود تفعيل تطبيق ${appName} هو:\n🔑 ${code}\n\nأدخل هذا الكود في التطبيق للتحقق.`
                });
                
                await sock.sendMessage(OWNER_JID, { 
                    text: `🔔 طلب تفعيل جديد\n👤 المستخدم: ${userName}\n📱 الرقم: ${formattedPhone}\n🔑 الكود: ${code}\n📱 الجهاز: ${deviceId}\n📱 التطبيق: ${appName}`
                });
                
                console.log(`✅ تم إرسال الكود إلى ${formattedPhone}`);
            } catch (e) {
                console.error("❌ فشل إرسال الكود:", e.message);
            }
        } else {
            console.log("⚠️ البوت غير متصل، لم يتم إرسال الكود");
        }
        
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ في request-otp:", error);
        res.status(500).send("Error");
    }
});

// --- 6. التحقق من الكود (متوافق مع تطبيقك) ---
app.get("/verify-otp", async (req, res) => {
    try {
        const formattedPhone = smartFormat(req.query.phone);
        const inputCode = req.query.code ? req.query.code.toString().trim() : "";
        
        console.log(`🔍 محاولة تحقق: الرقم ${formattedPhone}، الكود: ${inputCode}`);
        
        // البحث عن الكود في Firebase
        const otpsRef = admin.firestore().collection('pending_otps');
        const snapshot = await otpsRef.where('phone', '==', formattedPhone).get();
        
        if (snapshot.empty) {
            console.log(`❌ لا يوجد طلب كود للرقم: ${formattedPhone}`);
            return res.status(401).send("Error");
        }
        
        let verified = false;
        let deviceId = null;
        
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const storedCode = data.code.toString().trim();
            
            // التحقق من وقت الصلاحية (10 دقائق)
            const timestamp = data.timestamp?.toDate?.() || new Date();
            const now = new Date();
            const diffMinutes = (now - timestamp) / (1000 * 60);
            
            if (diffMinutes <= 10 && storedCode === inputCode) {
                verified = true;
                deviceId = data.deviceId;
                
                // تسجيل الجهاز الموثوق
                await admin.firestore().collection('allowed_devices').doc(deviceId).set({ 
                    phone: formattedPhone,
                    userName: data.userName || 'مستخدم',
                    appName: data.appName || 'default',
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                    verified: true
                });
                
                // حذف طلب الكود
                await doc.ref.delete();
                
                // إرسال تأكيد للمالك
                if (isConnected && sock) {
                    await sock.sendMessage(OWNER_JID, { 
                        text: `✅ تم تفعيل جهاز جديد\n📱 الرقم: ${formattedPhone}\n📱 الجهاز: ${deviceId}`
                    });
                }
                
                break;
            }
        }
        
        if (verified) {
            console.log(`✅ تحقق ناجح للرقم: ${formattedPhone}`);
            return res.status(200).send("Verified");
        } else {
            console.log(`❌ كود غير صحيح للرقم: ${formattedPhone}`);
            return res.status(401).send("Error");
        }
        
    } catch (error) {
        console.error("❌ خطأ في verify-otp:", error);
        res.status(500).send("Error");
    }
});

// --- 7. تشغيل البوت ---
async function start() {
    try {
        // استعادة الهوية
        await syncSession('restore');
        
        // التحقق من وجود مجلد auth_info
        if (!fs.existsSync('./auth_info')) {
            fs.mkdirSync('./auth_info', { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({ 
            version,
            auth: state, 
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ["Guardian VIP", "Chrome", "1.0.0"],
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', async () => { 
            await saveCreds(); 
            await syncSession('save'); 
        });

        sock.ev.on('connection.update', (u) => {
            const { connection, qr, lastDisconnect } = u;
            
            if (qr) {
                QRCode.toDataURL(qr, (err, url) => { 
                    qrCodeImage = url; 
                    console.log("📱 تم تحديث QR code");
                });
            }
            
            if (connection === 'open') { 
                isConnected = true; 
                qrCodeImage = "DONE"; 
                reconnectAttempts = 0;
                console.log("🛡️ الحارس متصل الآن بهويتك المستعادة");
                console.log("✅ البوت جاهز لاستقبال طلبات التفعيل");
            }
            
            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("❌ تم تسجيل الخروج، يجب مسح QR جديد");
                    // حذف الجلسة المنتهية
                    try {
                        fs.rmSync('./auth_info', { recursive: true, force: true });
                        qrCodeImage = null;
                    } catch (e) {}
                } else {
                    reconnectAttempts++;
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        console.log(`🔄 محاولة استعادة الاتصال (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                        setTimeout(start, 5000);
                    } else {
                        console.log("❌ فشل الاتصال بعد عدة محاولات، يرجى مراجعة الإعدادات");
                    }
                }
            }
        });

    } catch (error) {
        console.error("❌ خطأ في تشغيل البوت:", error);
        setTimeout(start, 10000);
    }
}

// --- 8. الصفحة الرئيسية ---
app.get("/", (req, res) => {
    if (isConnected) {
        res.send(`
            <html>
                <head>
                    <title>الحارس - متصل</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: Arial; text-align: center; padding: 20px; background: #f0f0f0; }
                        .card { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 20px auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        .online { color: green; font-size: 24px; }
                        .info { background: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: right; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1 class="online">✅ متصل</h1>
                        <div class="info">
                            <p>🔐 البوت يعمل بهويتك الأصلية</p>
                            <p>📱 جاهز لاستقبال طلبات التفعيل</p>
                            <p>⚡ الحالة: مستقرة</p>
                        </div>
                    </div>
                </body>
            </html>
        `);
    } else if (qrCodeImage && qrCodeImage !== "DONE") {
        res.send(`
            <html>
                <head>
                    <title>الحارس - مسح QR</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: Arial; text-align: center; padding: 20px; background: #f0f0f0; }
                        .card { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 20px auto; }
                        .qr-container { margin: 30px 0; }
                        img { max-width: 100%; width: 300px; height: auto; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>📱 مسح QR code</h1>
                        <div class="qr-container">
                            <img src="${qrCodeImage}" alt="QR Code">
                        </div>
                        <p>1. افتح واتساب على جوالك</p>
                        <p>2. اذهب إلى الإعدادات > الأجهزة المرتبطة</p>
                        <p>3. امسح الرمز لربط البوت</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>الحارس - جاري التحميل</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: Arial; text-align: center; padding: 20px; background: #f0f0f0; }
                        .card { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 20px auto; }
                        .loading { color: #666; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1 class="loading">⏳ جاري التحميل...</h1>
                        <p>جاري استعادة الهوية من Firebase</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// --- 9. صفحة حالة إضافية ---
app.get("/status", (req, res) => {
    res.json({
        connected: isConnected,
        timestamp: new Date().toISOString(),
        reconnectAttempts: reconnectAttempts
    });
});

// --- 10. بدء تشغيل السيرفر ---
app.listen(port, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${port}`);
    console.log(`🌐 الرابط: https://threew3t3s3wts.onrender.com`);
    start();
});
