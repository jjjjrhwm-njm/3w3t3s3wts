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

// الهوية الأصلية: الرقم الذي ستصل عليه التنبيهات
const OWNER_JID = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";

let sock, qrCodeImage, isConnected = false;

// --- 1. المحرك الذكي لتنسيق الأرقام (السعودية، اليمن، مصر...) ---
const smartFormat = (phone) => {
    let clean = phone.replace(/\D/g, "");
    if (clean.startsWith("0")) clean = clean.substring(1);
    
    // محاولة التمييز التلقائي للدول العربية
    const regions = ['SA', 'YE', 'EG', 'SY', 'IQ', 'JO', 'AE'];
    for (let r of regions) {
        const p = parsePhoneNumberFromString(clean, r);
        if (p && p.isValid()) return p.format('E.164').replace('+', '');
    }
    return clean;
};

// --- 2. إعداد جوجل فايربيس (الخزانة) ---
if (process.env.FIREBASE_CONFIG) {
    try {
        const cert = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cert) });
        console.log("✅ متصل بخزانة جوجل");
    } catch (e) { console.log("⚠️ خطأ في إعدادات Firebase"); }
}

// --- 3. نظام استعادة الهوية (عشان ما يطلب QR) ---
// تم تعديل المجلد إلى auth_info ليطابق الهوية القديمة تماماً
async function syncSession(action) {
    if (!admin.apps.length) return;
    const db = admin.firestore().collection('session').doc('session_vip_rashed');
    const authDir = './auth_info';

    if (action === 'restore') {
        const doc = await db.get();
        if (doc.exists) {
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify(doc.data()));
            console.log("🔄 تم سحب هويتك القديمة بنجاح - الدخول تلقائي");
        }
    } else {
        const credPath = path.join(authDir, 'creds.json');
        if (fs.existsSync(credPath)) {
            const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            await db.set(creds, { merge: true });
        }
    }
}

// --- 4. مسارات الحارس (API) ---
app.get("/check-device", async (req, res) => {
    const doc = await admin.firestore().collection('allowed_devices').doc(req.query.id || 'none').get();
    res.status(doc.exists ? 200 : 403).send(doc.exists ? "OK" : "NO");
});

app.get("/request-otp", async (req, res) => {
    const phone = smartFormat(req.query.phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // تخزين الكود في جوجل للتحقق لاحقاً
    await admin.firestore().collection('pending_otps').doc(phone).set({ 
        code, 
        deviceId: req.query.deviceId, 
        time: new Date() 
    });
    
    if (isConnected) {
        // إرسال الكود للمستخدم
        await sock.sendMessage(phone + "@s.whatsapp.net", { text: `كود تفعيلك هو: ${code}` });
        // إرسال تنبيه لرقمك الأساسي
        await sock.sendMessage(OWNER_JID, { 
            text: `🔔 طلب جديد:\n👤 الاسم: ${req.query.name || 'مستخدم'}\n📱 الرقم: ${phone}\n🔑 الكود: ${code}` 
        });
    }
    res.status(200).send("OK");
});

app.get("/verify-otp", async (req, res) => {
    const phone = smartFormat(req.query.phone);
    const doc = await admin.firestore().collection('pending_otps').doc(phone).get();
    if (doc.exists && doc.data().code === req.query.code) {
        await admin.firestore().collection('allowed_devices').doc(doc.data().deviceId).set({ phone, date: new Date() });
        return res.status(200).send("Verified");
    }
    res.status(401).send("Error");
});

// --- 5. تشغيل المحرك والنبض ---
async function start() {
    await syncSession('restore');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ 
        version,
        auth: state, 
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        // محاكاة نفس المتصفح القديم لضمان قبول الهوية
        browser: ["Mac OS", "Chrome", "114.0.5735.198"]
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
            console.log("🛡️ الحارس متصل بنفس الهوية القديمة!"); 
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) start();
        }
    });
    
    // نبض كل 10 دقائق لمنع تعليق الجلسة
    setInterval(async () => { 
        if (isConnected) await sock.sendPresenceUpdate('available'); 
    }, 10 * 60 * 1000);
}

app.get("/", (req, res) => {
    if (isConnected) res.send("✅ الخزانة نشطة وتعمل بهويتك الأصلية");
    else res.send(qrCodeImage ? `<img src="${qrCodeImage}">` : "جاري استعادة الهوية من جوجل...");
});

app.listen(port, () => start());
