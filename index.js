require("dotenv").config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const admin = require("firebase-admin");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 10000;

// رقمك الأساسي لاستقبال المعلومات (يُجلب من إعدادات ريندر)
const OWNER_JID = (process.env.OWNER_NUMBER || "966554526287") + "@s.whatsapp.net";

let sock, qrCodeImage, isConnected = false;

// --- محرك الأرقام الذكي ---
const formatPhone = (phone) => {
    let clean = phone.replace(/\D/g, "");
    if (clean.startsWith("0")) clean = clean.substring(1);
    const regions = ['SA', 'YE', 'EG', 'SY', 'IQ', 'JO', 'AE'];
    for (let r of regions) {
        const p = parsePhoneNumberFromString(clean, r);
        if (p && p.isValid()) return p.format('E.164').replace('+', '');
    }
    return clean;
};

// --- إعداد خزانة جوجل (Firebase) ---
if (process.env.FIREBASE_CONFIG) {
    try {
        const cert = JSON.parse(process.env.FIREBASE_CONFIG);
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cert) });
    } catch (e) { console.log("⚠️ فشل الاتصال بجوجل"); }
}

// --- استعادة الهوية من جوجل ---
async function syncSession(action) {
    if (!admin.apps.length) return;
    const db = admin.firestore().collection('session').doc('session_vip_rashed');
    if (action === 'restore') {
        const doc = await db.get();
        if (doc.exists) {
            if (!fs.existsSync('./auth')) fs.mkdirSync('./auth');
            fs.writeFileSync('./auth/creds.json', JSON.stringify(doc.data()));
            console.log("🔄 تم سحب الهوية من جوجل");
        }
    } else if (fs.existsSync('./auth/creds.json')) {
        const creds = JSON.parse(fs.readFileSync('./auth/creds.json'));
        await db.set(creds, { merge: true });
    }
}

// --- العمليات الأساسية ---
app.get("/request-otp", async (req, res) => {
    const phone = formatPhone(req.query.phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await admin.firestore().collection('pending_otps').doc(phone).set({ code, deviceId: req.query.deviceId, time: new Date() });
    
    if (isConnected) {
        await sock.sendMessage(phone + "@s.whatsapp.net", { text: `كود تفعيلك: ${code}` });
        // إرسال المعلومة لرقمك الأساسي فوراً
        await sock.sendMessage(OWNER_JID, { text: `🔔 معلومة جديدة:\n📱 الرقم: ${phone}\n🔑 الكود: ${code}` });
    }
    res.status(200).send("OK");
});

app.get("/verify-otp", async (req, res) => {
    const phone = formatPhone(req.query.phone);
    const doc = await admin.firestore().collection('pending_otps').doc(phone).get();
    if (doc.exists && doc.data().code === req.query.code) {
        await admin.firestore().collection('allowed_devices').doc(doc.data().deviceId).set({ phone, date: new Date() });
        return res.status(200).send("Verified");
    }
    res.status(401).send("Error");
});

// --- تشغيل المحرك ---
async function start() {
    await syncSession('restore');
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on('creds.update', async () => { await saveCreds(); await syncSession('save'); });
    sock.ev.on('connection.update', (u) => {
        if (u.qr) QRCode.toDataURL(u.qr, (err, url) => { qrCodeImage = url; });
        if (u.connection === 'open') { isConnected = true; qrCodeImage = "DONE"; console.log("✅ الخزانة متصلة"); }
        if (u.connection === 'close') start();
    });
    setInterval(async () => { if (isConnected) await sock.sendPresenceUpdate('available'); }, 10 * 60 * 1000);
}

app.get("/", (req, res) => {
    if (isConnected) res.send("✅ الخزانة نشطة وتعمل بمفتاح جوجل");
    else res.send(qrCodeImage ? `<img src="${qrCodeImage}">` : "جاري استعادة هويتك من جوجل...");
});

app.listen(port, () => start());
