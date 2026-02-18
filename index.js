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

// رقمك الأساسي لاستقبال المعلومات
const OWNER_JID = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";

let sock, qrCodeImage, isConnected = false;

// --- 1. المحرك الذكي العالمي للأرقام (تصحيح تلقائي فوري) ---
const smartFormat = (phone) => {
    if (!phone) return "";
    let clean = phone.replace(/\D/g, ""); // تنظيف من أي رموز أو مسافات
    
    // إزالة الأصفار الزائدة في البداية (مثل 00 أو 0)
    if (clean.startsWith("00")) clean = clean.substring(2);
    if (clean.startsWith("0")) clean = clean.substring(1);
    
    // محاولة المعالجة الذكية (الأولوية للسعودية SA واليمن YE)
    const regions = ['SA', 'YE', 'EG', 'SY', 'IQ', 'JO', 'AE', 'KW'];
    for (let r of regions) {
        const p = parsePhoneNumberFromString(clean, r);
        if (p && p.isValid()) return p.format('E.164').replace('+', '');
    }
    
    // إذا لم يطابق الأنماط العربية، نحاول المعالجة كـ رقم دولي عام
    const globalP = parsePhoneNumberFromString("+" + clean);
    if (globalP && globalP.isValid()) return globalP.format('E.164').replace('+', '');

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

// --- 3. نظام استعادة الهوية (Vault) ---
async function syncSession(action) {
    if (!admin.apps.length) return;
    const db = admin.firestore().collection('session').doc('session_vip_rashed');
    const authDir = './auth_info';

    if (action === 'restore') {
        const doc = await db.get();
        if (doc.exists) {
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify(doc.data()));
            console.log("🔄 تم استعادة هويتك من جوجل");
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
    const rawPhone = req.query.phone;
    const name = req.query.name || "مستخدم";
    const formattedPhone = smartFormat(rawPhone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // الهوية الفريدة للطلب: (الرقم + الكود) لضمان عدم التداخل
    const requestId = `${formattedPhone}_${code}`;
    
    await admin.firestore().collection('pending_otps').doc(requestId).set({ 
        code, 
        phone: formattedPhone,
        name,
        deviceId: req.query.deviceId, 
        time: new Date() 
    });
    
    if (isConnected) {
        const targetJid = formattedPhone + "@s.whatsapp.net";
        await sock.sendMessage(targetJid, { text: `كود تفعيلك هو: ${code}` });
        await sock.sendMessage(OWNER_JID, { 
            text: `🔔 طلب جديد:\n👤 الاسم: ${name}\n📱 الرقم: ${formattedPhone}\n🔑 الكود: ${code}` 
        });
    }
    res.status(200).send("OK");
});

app.get("/verify-otp", async (req, res) => {
    const formattedPhone = smartFormat(req.query.phone);
    const inputCode = req.query.code ? req.query.code.trim() : "";
    
    // البحث عن الوثيقة التي تطابق (الرقم + الكود) معاً
    const requestId = `${formattedPhone}_${inputCode}`;
    const doc = await admin.firestore().collection('pending_otps').doc(requestId).get();
    
    if (doc.exists && doc.data().code === inputCode) {
        // نجاح: تسجيل الجهاز في القائمة البيضاء
        await admin.firestore().collection('allowed_devices').doc(doc.data().deviceId).set({ 
            phone: formattedPhone, 
            name: doc.data().name,
            date: new Date() 
        });
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
        browser: ["Guardian VIP", "Chrome", "114.0.5735.198"]
    });

    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        await syncSession('save'); 
    });

    sock.ev.on('connection.update', (u) => {
        const { connection, qr, lastDisconnect } = u;
        if (qr) QRCode.toDataURL(u.qr, (err, url) => { qrCodeImage = url; });
        if (connection === 'open') { 
            isConnected = true; 
            qrCodeImage = "DONE"; 
            console.log("🛡️ الحارس متصل وبصمت تام"); 
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) start();
        }
    });
    
    // نبض النظام كل 10 دقائق
    setInterval(async () => { 
        if (isConnected) await sock.sendPresenceUpdate('available'); 
    }, 10 * 60 * 1000);
}

app.get("/", (req, res) => {
    if (isConnected) res.send("✅ الخزانة نشطة وتعمل بهويتك الأصلية");
    else res.send(qrCodeImage ? `<img src="${qrCodeImage}">` : "جاري استعادة الهوية من جوجل...");
});

app.listen(port, () => start());
