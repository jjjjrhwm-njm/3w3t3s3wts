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

// --- 4. معالجة طلبات OTP والتحقق ---

app.get("/request-otp", async (req, res) => {
    const formattedPhone = smartFormat(req.query.phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // حفظ الكود كنص لضمان المطابقة الدقيقة
    await admin.firestore().collection('pending_otps').doc(formattedPhone).set({ 
        code: code, 
        deviceId: req.query.deviceId, 
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    if (isConnected) {
        await sock.sendMessage(formattedPhone + "@s.whatsapp.net", { text: `كود تفعيلك هو: ${code}` });
        await sock.sendMessage(OWNER_JID, { text: `🔔 طلب كود لـ ${req.query.name || 'مستخدم'}\n📱 الرقم: ${formattedPhone}\n🔑 الكود: ${code}` });
    }
    res.status(200).send("OK");
});

app.get("/verify-otp", async (req, res) => {
    const formattedPhone = smartFormat(req.query.phone);
    const inputCode = req.query.code ? req.query.code.toString().trim() : "";
    
    const doc = await admin.firestore().collection('pending_otps').doc(formattedPhone).get();
    
    if (doc.exists) {
        const storedData = doc.data();
        // التأكد من مطابقة الكود كنص (String)
        if (storedData.code.toString().trim() === inputCode) {
            await admin.firestore().collection('allowed_devices').doc(storedData.deviceId).set({ 
                phone: formattedPhone, 
                verifiedAt: new Date() 
            });
            return res.status(200).send("Verified");
        }
    }
    res.status(401).send("Error");
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
        logger: pino({ level: "error" }), // تقليل الزحام في السجلات
        browser: ["Guardian VIP", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0
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
            // لا تعيد الاتصال إذا تم تسجيل الخروج يدوياً، غير ذلك حاول مجدداً
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log("🔄 محاولة استعادة الاتصال...");
                setTimeout(start, 5000);
            }
        }
    });
}

app.get("/", (req, res) => {
    if (isConnected) res.send("<h1 style='color:green;text-align:center;'>✅ النظام يعمل بهويتك الأصلية</h1>");
    else if (qrCodeImage) res.send(`<div style='text-align:center;'><h1>الهوية غير مستقرة.. يرجى الانتظار أو المسح</h1><img src="${qrCodeImage}"></div>`);
    else res.send("<h1 style='text-align:center;'>جاري استعادة البيانات من Firebase...</h1>");
});

app.listen(port, () => start());
