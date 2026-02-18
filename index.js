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

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
let isStarting = false;
const userState = new Map(); 
const myNumber = "966554526287";

// --- 1. إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
}
const db = admin.firestore();

// --- 2. النبض الحديدي ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر ${res.statusCode}`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دالة الإرسال الآمن
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال: السوكيت مغلق"); }
}

function normalizePhone(phone) {
    let clean = phone.replace(/\D/g, ''); 
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (clean.length === 9 && clean.startsWith('5')) clean = '966' + clean;
    else if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) clean = '967' + clean;
    else if (clean.length === 8 && /^[34567]/.test(clean)) clean = '974' + clean;
    return clean + "@s.whatsapp.net";
}

// --- 3. دوال استعادة وحفظ الهوية ---
async function restoreIdentity() {
    try {
        const authDir = './auth_info_stable';
        const credPath = path.join(authDir, 'creds.json');
        
        const sessionDoc = await db.collection('session').doc('session_vip_rashed').get();
        
        if (sessionDoc.exists) {
            if (!fs.existsSync(authDir)) {
                fs.mkdirSync(authDir, { recursive: true });
            }
            fs.writeFileSync(credPath, JSON.stringify(sessionDoc.data()));
            console.log("✅ تم استعادة هوية رقم 966554526287 بنجاح");
            return true;
        }
    } catch (error) {
        console.log("❌ فشل استعادة الهوية:", error.message);
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
            console.log("✅ تم حفظ الهوية في Firebase");
        }
    } catch (error) {
        console.log("❌ فشل حفظ الهوية:", error.message);
    }
}

// --- 4. محرك معالجة الأوامر (مختصر) ---
async function processCommand(jid, text, sender, isMe) {
    if (sender !== myNumber && !isMe) return false;
    
    if (text === "نجم" || text === "نجم مساعدة") {
        await safeSend(jid, { text: "🌟 نجم الإبداع يعمل" });
        return true;
    }
    if (text === "نجم احصا") {
        const snap = await db.collection('users').get();
        await safeSend(jid, { text: `📊 المستخدمين: ${snap.size}` });
        return true;
    }
    return true;
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
        version, auth: state, logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false, syncFullHistory: false,
        connectTimeoutMs: 60000, keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        await saveIdentity(); 
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || "").trim();

            if (!text) return;
            await processCommand(jid, text, sender, isMe);
            
        } catch (e) { console.log("❌ خطأ معالجة:", e.message); }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 النظام متصل");
            setTimeout(() => {
                safeSend(normalizePhone(myNumber), { text: "🌟 نجم الإبداع جاهز" });
            }, 2000);
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

// --- ممرات الـ API (مبسطة) ---
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName } = req.query;
        const snap = await db.collection('users').where("deviceId", "==", id).where("appName", "==", appName).get();
        res.status(snap.empty ? 404 : 200).send(snap.empty ? "NOT_FOUND" : "SUCCESS");
    } catch (error) {
        res.status(500).send("ERROR");
    }
});

// ✅ تخزين الكود مع ربطه بالجهاز
app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        const formattedPhone = phone.replace(/\D/g, '');
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        console.log(`📱 طلب كود: ${formattedPhone} الكود: ${otp}`);
        
        // تخزين الكود مع ربطه بالجهاز ورقم الهاتف
        const otpData = {
            phone: formattedPhone,
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // تخزين في مجموعتين للوصول السريع
        await db.collection('pending_otps').doc(deviceId).set(otpData);
        await db.collection('pending_phones').doc(formattedPhone).set({
            deviceId: deviceId,
            otp: otp,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // إرسال الكود
        await safeSend(normalizePhone(formattedPhone), { 
            text: `🔐 أهلاً ${name}، كود تفعيل تطبيق ${appName} هو: *${otp}*` 
        });
        
        res.status(200).send("OK");
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

// ✅ التحقق من الكود - يعيد SUCCESS فقط عند النجاح
app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        const formattedPhone = phone.replace(/\D/g, '');
        const inputCode = code.toString().trim();
        
        console.log(`🔍 محاولة تحقق: ${formattedPhone} الكود: ${inputCode}`);
        
        // البحث عن الجهاز المرتبط بالرقم
        const phoneDoc = await db.collection('pending_phones').doc(formattedPhone).get();
        
        if (!phoneDoc.exists) {
            console.log(`❌ لا يوجد طلب للرقم: ${formattedPhone}`);
            return res.status(401).send("FAIL");
        }
        
        const phoneData = phoneDoc.data();
        const deviceId = phoneData.deviceId;
        
        // البحث عن تفاصيل الكود
        const otpDoc = await db.collection('pending_otps').doc(deviceId).get();
        
        if (!otpDoc.exists) {
            console.log(`❌ لا يوجد كود للجهاز: ${deviceId}`);
            await phoneDoc.ref.delete();
            return res.status(401).send("FAIL");
        }
        
        const otpData = otpDoc.data();
        const storedOtp = otpData.otp.toString().trim();
        
        // التحقق من الصلاحية (10 دقائق)
        const createdAt = otpData.createdAt?.toDate?.() || new Date();
        const now = new Date();
        const diffMinutes = (now - createdAt) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            await otpDoc.ref.delete();
            await phoneDoc.ref.delete();
            return res.status(401).send("FAIL");
        }
        
        // مقارنة الكود
        if (storedOtp === inputCode) {
            console.log(`✅ تحقق ناجح: ${formattedPhone}`);
            
            // تسجيل المستخدم
            await db.collection('users').doc(formattedPhone).set({ 
                name: otpData.name || 'مستخدم',
                phone: formattedPhone,
                appName: otpData.appName || 'default',
                deviceId: deviceId,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            // تنظيف
            await otpDoc.ref.delete();
            await phoneDoc.ref.delete();
            
            // إبلاغ الإدمن
            await safeSend(normalizePhone(myNumber), { 
                text: `🆕 مستخدم جديد: ${otpData.name || 'مستخدم'} (${formattedPhone})` 
            });
            
            // تطبيقك ينتظر SUCCESS
            return res.status(200).send("SUCCESS");
        } else {
            console.log(`❌ كود غير صحيح: ${inputCode} ≠ ${storedOtp}`);
            return res.status(401).send("FAIL");
        }
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("FAIL");
    }
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => res.send(qrImage === "DONE" ? "✅ Connected" : `<img src="${qrImage}">`));

app.listen(process.env.PORT || 10000, () => startBot());
