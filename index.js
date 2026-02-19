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
const myNumber = "966554526287";

// --- 1. إعداد Firebase ---
const firebaseConfig = process.env.FIREBASE_CONFIG;
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(firebaseConfig);
    admin.initializeApp({ 
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// --- 2. النبض الحديدي ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        https.get(`https://${host}/ping`, (res) => {
            console.log(`💓 نبض النظام: مستقر`);
        }).on('error', () => {});
    }
}, 10 * 60 * 1000);

// دالة الإرسال الآمن
async function safeSend(jid, content) {
    try {
        if (sock && sock.user) {
            return await sock.sendMessage(jid, content);
        }
    } catch (e) { console.log("⚠️ فشل الإرسال"); }
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

// --- 3. استعادة الهوية ---
async function restoreIdentity() {
    try {
        const authDir = './auth_info_stable';
        const credPath = path.join(authDir, 'creds.json');
        
        const sessionDoc = await db.collection('session').doc('session_vip_rashed').get();
        
        if (sessionDoc.exists) {
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            fs.writeFileSync(credPath, JSON.stringify(sessionDoc.data()));
            console.log("✅ تم استعادة الهوية");
            return true;
        }
    } catch (error) {
        console.log("❌ فشل استعادة الهوية");
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
            console.log("✅ تم حفظ الهوية");
        }
    } catch (error) {
        console.log("❌ فشل حفظ الهوية");
    }
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
        version, 
        auth: state, 
        logger: pino({ level: "silent" }), 
        browser: ["CreativeStar", "Chrome", "1.0"],
        printQRInTerminal: false, 
        syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        await saveIdentity(); 
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrImage = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            qrImage = "DONE";
            isStarting = false;
            console.log("🚀 البوت متصل");
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

// --- تخزين مؤقت في الذاكرة ---
const tempStorage = new Map();

// --- API مطابق لتطبيقك تماماً ---
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName } = req.query;
        console.log(`🔍 فحص الجهاز: ${id}`);
        
        const snap = await db.collection('users').where("deviceId", "==", id).where("appName", "==", appName).get();
        
        if (!snap.empty) {
            return res.status(200).send("SUCCESS");
        } else {
            return res.status(404).send("NOT_FOUND");
        }
    } catch (error) {
        res.status(500).send("ERROR");
    }
});

app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        // مهم: لا تقم بتنسيق الرقم، استخدمه كما هو من التطبيق
        const rawPhone = phone;
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        console.log(`📱 طلب كود: ${rawPhone} الكود: ${otp}`);
        
        // تخزين في الذاكرة المؤقتة باستخدام الرقم الأصلي
        tempStorage.set(rawPhone, {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            timestamp: Date.now()
        });
        
        // تخزين في Firebase باستخدام الرقم الأصلي
        await db.collection('temp_codes').doc(rawPhone).set({
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // إرسال الكود (نستخدم normalizePhone فقط للإرسال)
        await safeSend(normalizePhone(rawPhone), { 
            text: `🔐 كود التفعيل: *${otp}*` 
        });
        
        res.status(200).send("OK");
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        // مهم: استخدم الرقم كما هو من التطبيق بدون تنسيق
        const rawPhone = phone;
        const inputCode = code.toString().trim();
        
        console.log(`🔍 تحقق: ${rawPhone} الكود: ${inputCode}`);
        
        // 1. البحث في الذاكرة المؤقتة أولاً باستخدام الرقم الأصلي
        let data = tempStorage.get(rawPhone);
        let source = "memory";
        
        // 2. إذا لم يوجد، ابحث في Firebase باستخدام الرقم الأصلي
        if (!data) {
            const fbDoc = await db.collection('temp_codes').doc(rawPhone).get();
            if (fbDoc.exists) {
                data = fbDoc.data();
                source = "firebase";
            }
        }
        
        if (!data) {
            console.log(`❌ لا يوجد كود للرقم: ${rawPhone}`);
            return res.status(401).send("FAIL");
        }
        
        const storedOtp = data.otp.toString().trim();
        
        // التحقق من الصلاحية (10 دقائق)
        const now = Date.now();
        const timestamp = data.timestamp || (data.createdAt?.toDate?.()?.getTime() || now);
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            tempStorage.delete(rawPhone);
            await db.collection('temp_codes').doc(rawPhone).delete();
            return res.status(401).send("FAIL");
        }
        
        // مقارنة الكود
        if (storedOtp === inputCode) {
            console.log(`✅ تحقق ناجح من ${source}: ${rawPhone}`);
            
            // تنسيق الرقم للتخزين في Firebase
            const formattedPhone = rawPhone.replace(/\D/g, '');
            
            // تسجيل المستخدم في Firebase
            await db.collection('users').doc(formattedPhone).set({ 
                name: data.name || 'مستخدم',
                phone: formattedPhone,
                appName: data.appName || 'default',
                deviceId: data.deviceId || '',
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            // تنظيف
            tempStorage.delete(rawPhone);
            await db.collection('temp_codes').doc(rawPhone).delete();
            
            // إبلاغ الإدمن
            await safeSend(normalizePhone(myNumber), { 
                text: `🆕 مستخدم جديد: ${formattedPhone}` 
            });
            
            return res.status(200).send("SUCCESS");
        } else {
            console.log(`❌ كود خطأ: المدخل ${inputCode} ≠ المخزن ${storedOtp}`);
            return res.status(401).send("FAIL");
        }
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("FAIL");
    }
});

app.get("/ping", (req, res) => res.send("💓"));
app.get("/", (req, res) => {
    if (qrImage === "DONE") {
        res.send("✅ البوت يعمل");
    } else if (qrImage) {
        res.send(`<img src="${qrImage}">`);
    } else {
        res.send("⏳ جاري التحميل...");
    }
});

app.listen(process.env.PORT || 10000, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${process.env.PORT || 10000}`);
    console.log(`📌 الرابط: https://threew3t3s3wts.onrender.com`);
    startBot();
});
