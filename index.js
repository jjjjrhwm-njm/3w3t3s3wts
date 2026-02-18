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

// --- 3. نظام استعادة الهوية (بدون تغيير) ---
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

// --- 4. مسار check-device (مطابق لتطبيقك) ---
app.get("/check-device", async (req, res) => {
    try {
        const deviceId = req.query.id;
        const appName = req.query.appName || "default";
        
        console.log(`🔍 فحص الجهاز: ${deviceId} للتطبيق: ${appName}`);
        
        const deviceDoc = await admin.firestore().collection('allowed_devices').doc(deviceId).get();
        
        if (deviceDoc.exists) {
            console.log(`✅ الجهاز موثوق: ${deviceId}`);
            return res.status(200).send("Verified");
        } else {
            console.log(`⚠️ جهاز غير موثوق: ${deviceId}`);
            return res.status(404).send("Device not verified");
        }
    } catch (error) {
        console.error("❌ خطأ في check-device:", error);
        res.status(500).send("Error");
    }
});

// --- 5. طلب الكود (مطابق لتطبيقك) ---
app.get("/request-otp", async (req, res) => {
    try {
        const formattedPhone = smartFormat(req.query.phone);
        const deviceId = req.query.deviceId;
        const userName = req.query.name || 'مستخدم';
        const appName = req.query.app || 'default';
        
        console.log(`📱 طلب كود: ${formattedPhone} للجهاز: ${deviceId}`);
        
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // ✅ التعديل المهم: استخدام deviceId كمفتاح رئيسي
        await admin.firestore().collection('pending_otps').doc(deviceId).set({ 
            phone: formattedPhone,
            code: code,
            deviceId: deviceId,
            userName: userName,
            appName: appName,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            verified: false
        });
        
        // حفظ أيضاً برقم الهاتف كنسخة احتياطية (للبحث السريع)
        await admin.firestore().collection('pending_by_phone').doc(formattedPhone).set({
            deviceId: deviceId,
            code: code,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        if (isConnected && sock) {
            try {
                await sock.sendMessage(formattedPhone + "@s.whatsapp.net", { 
                    text: `مرحباً ${userName}،\n\n📱 كود تفعيل تطبيق ${appName} هو:\n🔑 ${code}\n\nأدخل هذا الكود في التطبيق للتحقق.`
                });
                
                await sock.sendMessage(OWNER_JID, { 
                    text: `🔔 طلب تفعيل جديد\n👤 المستخدم: ${userName}\n📱 الرقم: ${formattedPhone}\n🔑 الكود: ${code}\n📱 الجهاز: ${deviceId}\n📱 التطبيق: ${appName}`
                });
                
                console.log(`✅ تم إرسال الكود ${code} إلى ${formattedPhone}`);
            } catch (e) {
                console.error("❌ فشل إرسال الكود:", e.message);
            }
        }
        
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ في request-otp:", error);
        res.status(500).send("Error");
    }
});

// --- 6. التحقق من الكود (تم إصلاحه بالكامل) ---
app.get("/verify-otp", async (req, res) => {
    try {
        const formattedPhone = smartFormat(req.query.phone);
        const inputCode = req.query.code ? req.query.code.toString().trim() : "";
        
        console.log(`🔍 محاولة تحقق: الرقم ${formattedPhone}، الكود: ${inputCode}`);
        
        // البحث عن الجهاز المرتبط بهذا الرقم
        const phoneDoc = await admin.firestore().collection('pending_by_phone').doc(formattedPhone).get();
        
        if (!phoneDoc.exists) {
            console.log(`❌ لا يوجد طلب كود للرقم: ${formattedPhone}`);
            return res.status(401).send("Error");
        }
        
        const phoneData = phoneDoc.data();
        const deviceId = phoneData.deviceId;
        
        // البحث عن الكود باستخدام deviceId
        const otpDoc = await admin.firestore().collection('pending_otps').doc(deviceId).get();
        
        if (!otpDoc.exists) {
            console.log(`❌ لا يوجد كود للجهاز: ${deviceId}`);
            return res.status(401).send("Error");
        }
        
        const otpData = otpDoc.data();
        const storedCode = otpData.code.toString().trim();
        
        // التحقق من وقت الصلاحية (10 دقائق)
        const timestamp = otpData.timestamp?.toDate?.() || new Date();
        const now = new Date();
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية للرقم: ${formattedPhone}`);
            await otpDoc.ref.delete();
            await phoneDoc.ref.delete();
            return res.status(401).send("Error");
        }
        
        // مقارنة الكود
        if (storedCode === inputCode) {
            console.log(`✅ تحقق ناجح للرقم: ${formattedPhone}`);
            
            // تسجيل الجهاز الموثوق
            await admin.firestore().collection('allowed_devices').doc(deviceId).set({ 
                phone: formattedPhone,
                userName: otpData.userName || 'مستخدم',
                appName: otpData.appName || 'default',
                verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                verified: true
            });
            
            // تنظيف البيانات المؤقتة
            await otpDoc.ref.delete();
            await phoneDoc.ref.delete();
            
            // إرسال تأكيد للمالك
            if (isConnected && sock) {
                await sock.sendMessage(OWNER_JID, { 
                    text: `✅ تم تفعيل جهاز جديد\n📱 الرقم: ${formattedPhone}\n📱 الجهاز: ${deviceId}`
                });
            }
            
            return res.status(200).send("Verified");
        } else {
            console.log(`❌ كود غير صحيح: المدخل ${inputCode} ≠ المخزن ${storedCode}`);
            return res.status(401).send("Error");
        }
        
    } catch (error) {
        console.error("❌ خطأ في verify-otp:", error);
        res.status(500).send("Error");
    }
});

// --- 7. تشغيل البوت (بدون تغيير) ---
async function start() {
    try {
        await syncSession('restore');
        
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
                        console.log("❌ فشل الاتصال بعد عدة محاولات");
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
                        .status { color: #666; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1 class="online">✅ البوت متصل</h1>
                        <div class="info">
                            <p>🔐 الهوية: نشطة ومستقرة</p>
                            <p>📱 الحالة: جاهز لاستقبال الطلبات</p>
                            <p>⚡ آخر تحديث: ${new Date().toLocaleString('ar-SA')}</p>
                        </div>
                        <div class="status">
                            <p>تم استعادة الهوية بنجاح ✅</p>
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
                        .steps { text-align: right; margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>📱 مسح QR code</h1>
                        <div class="qr-container">
                            <img src="${qrCodeImage}" alt="QR Code">
                        </div>
                        <div class="steps">
                            <p>1. افتح واتساب على جوالك</p>
                            <p>2. اذهب إلى الإعدادات > الأجهزة المرتبطة</p>
                            <p>3. اضغط على "ربط جهاز"</p>
                            <p>4. امسح الرمز الظاهر أعلاه</p>
                        </div>
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
                        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
                        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1 class="loading">⏳ جاري التحميل...</h1>
                        <div class="spinner"></div>
                        <p>جاري استعادة الهوية من Firebase</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// --- 9. صفحة الحالة ---
app.get("/status", (req, res) => {
    res.json({
        connected: isConnected,
        timestamp: new Date().toISOString(),
        reconnectAttempts: reconnectAttempts,
        uptime: process.uptime()
    });
});

// --- 10. بدء التشغيل ---
app.listen(port, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${port}`);
    console.log(`🌐 الرابط: https://threew3t3s3wts.onrender.com`);
    start();
});
