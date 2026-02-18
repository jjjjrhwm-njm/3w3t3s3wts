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

// --- 4. مسار check-device ---
app.get("/check-device", async (req, res) => {
    try {
        const deviceId = req.query.id;
        const appName = req.query.appName || "default";
        
        console.log(`🔍 فحص الجهاز: ${deviceId}`);
        
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

// --- 5. طلب الكود ---
app.get("/request-otp", async (req, res) => {
    try {
        const formattedPhone = smartFormat(req.query.phone);
        const deviceId = req.query.deviceId;
        const userName = req.query.name || 'مستخدم';
        const appName = req.query.app || 'default';
        
        console.log(`📱 طلب كود: ${formattedPhone} للجهاز: ${deviceId}`);
        
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // ✅ استخدام deviceId فقط كمفتاح رئيسي (كما في تطبيقك)
        await admin.firestore().collection('pending_otps').doc(deviceId).set({ 
            phone: formattedPhone,
            code: code,
            deviceId: deviceId,
            userName: userName,
            appName: appName,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // ✅ أيضاً نخزن برقم الهاتف للبحث السريع (مهم جداً)
        await admin.firestore().collection('phone_codes').doc(formattedPhone).set({
            deviceId: deviceId,
            code: code,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        if (isConnected && sock) {
            try {
                await sock.sendMessage(formattedPhone + "@s.whatsapp.net", { 
                    text: `مرحباً ${userName}،\n\n📱 كود التفعيل الخاص بك هو:\n🔑 ${code}\n\nأدخل هذا الكود في التطبيق.`
                });
                
                await sock.sendMessage(OWNER_JID, { 
                    text: `🔔 طلب تفعيل جديد\n👤 المستخدم: ${userName}\n📱 الرقم: ${formattedPhone}\n🔑 الكود: ${code}\n📱 الجهاز: ${deviceId}`
                });
            } catch (e) {}
        }
        
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

// --- 6. التحقق من الكود (معدل حسب طلبك) ---
app.get("/verify-otp", async (req, res) => {
    try {
        const formattedPhone = smartFormat(req.query.phone);
        const inputCode = req.query.code ? req.query.code.toString().trim() : "";
        
        console.log(`🔍 محاولة تحقق: الرقم ${formattedPhone}، الكود: ${inputCode}`);
        
        // ✅ 1. البحث عن الكود باستخدام رقم الهاتف أولاً
        const phoneCodeDoc = await admin.firestore().collection('phone_codes').doc(formattedPhone).get();
        
        if (!phoneCodeDoc.exists) {
            console.log(`❌ لا يوجد كود للرقم: ${formattedPhone}`);
            return res.status(401).send("Error");
        }
        
        const phoneData = phoneCodeDoc.data();
        const deviceId = phoneData.deviceId;
        const storedCode = phoneData.code.toString().trim();
        
        console.log(`📱 found deviceId: ${deviceId}, storedCode: ${storedCode}`);
        
        // ✅ 2. التحقق من وقت الصلاحية (10 دقائق)
        const timestamp = phoneData.timestamp?.toDate?.() || new Date();
        const now = new Date();
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            await phoneCodeDoc.ref.delete();
            await admin.firestore().collection('pending_otps').doc(deviceId).delete();
            return res.status(401).send("Error");
        }
        
        // ✅ 3. مقارنة الكود
        if (storedCode === inputCode) {
            console.log(`✅ تحقق ناجح للرقم: ${formattedPhone}`);
            
            // تسجيل الجهاز الموثوق
            await admin.firestore().collection('allowed_devices').doc(deviceId).set({ 
                phone: formattedPhone,
                userName: "مستخدم",
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // تنظيف البيانات المؤقتة
            await phoneCodeDoc.ref.delete();
            await admin.firestore().collection('pending_otps').doc(deviceId).delete();
            
            // إرسال تأكيد
            if (isConnected && sock) {
                await sock.sendMessage(OWNER_JID, { 
                    text: `✅ تم تفعيل جهاز جديد\n📱 الرقم: ${formattedPhone}`
                });
            }
            
            return res.status(200).send("Verified");
        } else {
            console.log(`❌ كود غير صحيح: المدخل ${inputCode} ≠ المخزن ${storedCode}`);
            return res.status(401).send("Error");
        }
        
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

// --- 7. تشغيل البوت ---
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
            keepAliveIntervalMs: 30000
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
                console.log("🛡️ الحارس متصل الآن");
            }
            
            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("❌ تم تسجيل الخروج");
                    try {
                        fs.rmSync('./auth_info', { recursive: true, force: true });
                        qrCodeImage = null;
                    } catch (e) {}
                } else {
                    reconnectAttempts++;
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        console.log(`🔄 محاولة استعادة الاتصال (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                        setTimeout(start, 5000);
                    }
                }
            }
        });

    } catch (error) {
        console.error("❌ خطأ:", error);
        setTimeout(start, 10000);
    }
}

// --- 8. الصفحة الرئيسية ---
app.get("/", (req, res) => {
    if (isConnected) {
        res.send(`<h1 style='color:green;text-align:center;'>✅ النظام يعمل</h1>`);
    } else if (qrCodeImage && qrCodeImage !== "DONE") {
        res.send(`<div style='text-align:center;'><h1>مسح QR code</h1><img src="${qrCodeImage}"></div>`);
    } else {
        res.send(`<h1 style='text-align:center;'>⏳ جاري التحميل...</h1>`);
    }
});

// --- 9. بدء التشغيل ---
app.listen(port, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${port}`);
    start();
});
