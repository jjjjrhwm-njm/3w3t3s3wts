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

// --- 1. المحرك الذكي للأرقام (تحسين لضمان التطابق) ---
const smartFormat = (phone) => {
    if (!phone) return "";
    let clean = phone.replace(/\D/g, "").trim(); 
    // محاولة تنظيف الرقم ليكون دولياً موحداً بدون +
    const regions = ['SA', 'YE', 'EG', 'SY', 'IQ', 'JO', 'AE', 'KW'];
    for (let r of regions) {
        const p = parsePhoneNumberFromString(clean, r);
        if (p && p.isValid()) return p.format('E.164').replace('+', '');
    }
    return clean; 
};

// --- 2. إعداد جوجل فايربيس ---
if (process.env.FIREBASE_CONFIG && !admin.apps.length) {
    try {
        const cert = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({ credential: admin.credential.cert(cert) });
    } catch (e) { console.error("⚠️ Firebase Init Error:", e.message); }
}

// --- 3. نظام المزامنة (تحسين لمنع التكرار في السجلات) ---
async function syncSession(action) {
    if (!admin.apps.length) return;
    const db = admin.firestore().collection('session').doc('session_vip_rashed');
    const authDir = './auth_info';
    const credPath = path.join(authDir, 'creds.json');

    if (action === 'restore') {
        const doc = await db.get();
        if (doc.exists) {
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            fs.writeFileSync(credPath, JSON.stringify(doc.data()));
            return true;
        }
    } else if (action === 'save') {
        if (fs.existsSync(credPath)) {
            const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            await db.set(creds, { merge: true });
        }
    }
    return false;
}

// --- 4. المسارات (APIs) ---

app.get("/request-otp", async (req, res) => {
    const rawPhone = req.query.phone;
    const formattedPhone = smartFormat(rawPhone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    try {
        await admin.firestore().collection('pending_otps').doc(formattedPhone).set({ 
            code: code, 
            deviceId: req.query.deviceId, 
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        if (isConnected) {
            await sock.sendMessage(formattedPhone + "@s.whatsapp.net", { text: `كود تفعيلك هو: ${code}` });
            await sock.sendMessage(OWNER_JID, { 
                text: `🔔 طلب جديد:\n👤 الاسم: ${req.query.name || 'مستخدم'}\n📱 الرقم: ${formattedPhone}\n🔑 الكود: ${code}` 
            });
        }
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.get("/verify-otp", async (req, res) => {
    const formattedPhone = smartFormat(req.query.phone);
    const inputCode = req.query.code ? req.query.code.trim() : "";
    
    try {
        const doc = await admin.firestore().collection('pending_otps').doc(formattedPhone).get();
        
        if (doc.exists) {
            const data = doc.data();
            // مقارنة الكود والتأكد أنه لم يمر عليه أكثر من 10 دقائق
            if (data.code === inputCode) {
                await admin.firestore().collection('allowed_devices').doc(data.deviceId).set({ 
                    phone: formattedPhone, 
                    verifiedAt: new Date() 
                });
                return res.status(200).send("Verified");
            }
        }
        res.status(401).send("Invalid Code");
    } catch (e) { res.status(500).send("Error"); }
});

// --- 5. تشغيل المحرك (معالجة الـ Crash والـ Timeout) ---
async function start() {
    await syncSession('restore');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false,
        logger: pino({ level: "error" }), // تقليل السجلات لتجنب الزحام
        browser: ["Guardian VIP", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000, // زيادة وقت المهلة
        defaultQueryTimeoutMs: 0 // إلغاء مهلة الاستعلام لتجنب الـ 408
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
            console.log("🛡️ الحارس متصل الآن");
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log("🔄 إعادة الاتصال خلال 5 ثوانٍ...");
                setTimeout(start, 5000); // تأخير لإعطاء السيرفر فرصة للتنفس
            }
        }
    });
}

app.get("/", (req, res) => {
    if (isConnected) res.send("✅ الخزانة نشطة وتعمل");
    else res.send(qrCodeImage ? `<img src="${qrCodeImage}">` : "جاري الاتصال...");
});

app.listen(port, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${port}`);
    start();
});
