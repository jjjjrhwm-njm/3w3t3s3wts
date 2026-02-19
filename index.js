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
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const app = express();
app.use(express.json());

let sock;
let qrImage = ""; 
let isStarting = false;

// ============================================
// نظام بسيط وفعال
// ============================================

// --- تخزين مؤقت في الذاكرة (بسيط) ---
const pendingCodes = new Map(); // مفتاح: رقم الهاتف، قيمة: الكود والبيانات

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
    } catch (e) { 
        console.log("⚠️ فشل الإرسال:", e.message); 
    }
}

// دالة تنسيق الرقم
function formatPhoneNumber(phone) {
    let clean = phone.replace(/\D/g, '');
    if (clean.startsWith('00')) clean = clean.substring(2);
    if (clean.startsWith('0')) clean = clean.substring(1);
    
    // إذا كان الرقم سعودي (9 أرقام ويبدأ بـ 5)
    if (clean.length === 9 && clean.startsWith('5')) {
        return {
            local: clean,
            full: '966' + clean,
            international: '966' + clean
        };
    }
    
    // إذا كان الرقم يمني (9 أرقام ويبدأ بـ 7)
    if (clean.length === 9 && clean.startsWith('7')) {
        return {
            local: clean,
            full: '967' + clean,
            international: '967' + clean
        };
    }
    
    // إذا كان الرقطري (8 أرقام)
    if (clean.length === 8 && /^[34567]/.test(clean)) {
        return {
            local: clean,
            full: '974' + clean,
            international: '974' + clean
        };
    }
    
    return {
        local: clean,
        full: clean,
        international: clean
    };
}

function normalizePhone(phone) {
    const formatted = formatPhoneNumber(phone);
    return formatted.full + "@s.whatsapp.net";
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

// ============================================
// API مبسط ومضمون
// ============================================

// فحص الجهاز
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName } = req.query;
        console.log(`🔍 فحص الجهاز: ${id}, التطبيق: ${appName}`);
        
        const snap = await db.collection('users')
            .where("deviceId", "==", id)
            .where("appName", "==", appName)
            .get();
        
        if (!snap.empty) {
            return res.status(200).send("SUCCESS");
        } else {
            return res.status(404).send("NOT_FOUND");
        }
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("ERROR");
    }
});

// طلب كود
app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        
        console.log("=".repeat(40));
        console.log("📱 طلب كود جديد");
        console.log("=".repeat(40));
        console.log("الرقم:", phone);
        
        const formatted = formatPhoneNumber(phone);
        const localPhone = formatted.local;
        const fullPhone = formatted.full;
        
        console.log("الرقم الموحد:", fullPhone);
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // تخزين بسيط باستخدام رقم الهاتف فقط كمفتاح
        const codeData = {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            phone: fullPhone,
            timestamp: Date.now()
        };
        
        // تخزين في الذاكرة
        pendingCodes.set(fullPhone, codeData);
        
        // تخزين في Firebase
        await db.collection('pending_codes').doc(fullPhone).set({
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            phone: fullPhone,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`📦 تم تخزين الكود ${otp} للرقم ${fullPhone}`);
        console.log(`📱 جاري إرسال الكود...`);
        
        await safeSend(normalizePhone(fullPhone), { 
            text: `🔐 كود التفعيل الخاص بك هو: *${otp}*` 
        });
        
        console.log(`✅ تم الإرسال`);
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

// التحقق من الكود (مبسط جداً)
app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        
        console.log("=".repeat(40));
        console.log("🔍 محاولة تحقق");
        console.log("=".repeat(40));
        console.log("الرقم:", phone);
        console.log("الكود:", code);
        
        const formatted = formatPhoneNumber(phone);
        const fullPhone = formatted.full;
        
        console.log("الرقم الموحد:", fullPhone);
        
        // 1. البحث في الذاكرة أولاً
        let codeData = pendingCodes.get(fullPhone);
        let source = "memory";
        
        // 2. إذا لم يوجد، ابحث في Firebase
        if (!codeData) {
            console.log(`🔍 البحث في Firebase...`);
            const fbDoc = await db.collection('pending_codes').doc(fullPhone).get();
            if (fbDoc.exists) {
                codeData = fbDoc.data();
                source = "firebase";
            }
        }
        
        // 3. إذا لم يوجد نهائياً
        if (!codeData) {
            console.log(`❌ لا يوجد كود للرقم: ${fullPhone}`);
            return res.status(401).send("FAIL");
        }
        
        console.log(`📦 الكود المخزن: ${codeData.otp} (${source})`);
        
        // 4. التحقق من الصلاحية (10 دقائق)
        const timestamp = codeData.timestamp || (codeData.createdAt?.toDate?.()?.getTime() || 0);
        const now = Date.now();
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            pendingCodes.delete(fullPhone);
            await db.collection('pending_codes').doc(fullPhone).delete();
            return res.status(401).send("FAIL");
        }
        
        // 5. مقارنة الكود
        if (codeData.otp === code) {
            console.log(`✅ تحقق ناجح!`);
            
            // تسجيل المستخدم
            await db.collection('users').doc(fullPhone + "_" + codeData.appName).set({ 
                name: codeData.name || 'مستخدم',
                phone: fullPhone,
                appName: codeData.appName || 'default',
                deviceId: codeData.deviceId || '',
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            // تنظيف
            pendingCodes.delete(fullPhone);
            await db.collection('pending_codes').doc(fullPhone).delete();
            
            return res.status(200).send("SUCCESS");
        } else {
            console.log(`❌ كود خطأ`);
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
    console.log("=".repeat(40));
    console.log(`🚀 السيرفر يعمل على المنفذ ${process.env.PORT || 10000}`);
    console.log("=".repeat(40));
    startBot();
});
