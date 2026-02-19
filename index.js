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

// دالة ذكية لتوحيد صيغة الرقم
function formatPhoneNumber(phone) {
    // إزالة كل الرموز غير الرقمية
    let clean = phone.replace(/\D/g, '');
    
    // إذا كان الرقم يبدأ بـ 00
    if (clean.startsWith('00')) {
        clean = clean.substring(2);
    }
    
    // إذا كان الرقم يبدأ بـ 0 (صفر عربي أو إنجليزي)
    if (clean.startsWith('0')) {
        clean = clean.substring(1);
    }
    
    // إذا كان الرقم 9 أرقام ويبدأ بـ 5 (سعودي)
    if (clean.length === 9 && clean.startsWith('5')) {
        return {
            local: clean,           // 554526287
            full: '966' + clean,    // 966554526287
            international: '966' + clean
        };
    }
    
    // إذا كان الرقم 12 رقم ويبدأ بـ 966
    if (clean.length === 12 && clean.startsWith('966')) {
        return {
            local: clean.substring(3),  // 554526287
            full: clean,                // 966554526287
            international: clean
        };
    }
    
    // إذا كان الرقم 10 أرقام (مثل 0554526287)
    if (clean.length === 10 && clean.startsWith('5')) {
        return {
            local: clean.substring(1),  // 554526287
            full: '966' + clean.substring(1),
            international: '966' + clean.substring(1)
        };
    }
    
    // إذا كان الرقم 10 أرقام ويبدأ بـ 0
    if (clean.length === 10 && clean.startsWith('0')) {
        return {
            local: clean.substring(1),  // 554526287
            full: '966' + clean.substring(1),
            international: '966' + clean.substring(1)
        };
    }
    
    // إذا كان الرقم 9 أرقام ولا يبدأ بـ 5
    if (clean.length === 9) {
        return {
            local: clean,
            full: '966' + clean,
            international: '966' + clean
        };
    }
    
    // إذا كان الرقم 8 أرقام (قطر مثلاً)
    if (clean.length === 8 && /^[34567]/.test(clean)) {
        return {
            local: clean,
            full: '974' + clean,
            international: '974' + clean
        };
    }
    
    // إذا كان الرقم 9 أرقام ويبدأ بـ 77 (يمني)
    if (clean.length === 9 && /^(77|73|71|70)/.test(clean)) {
        return {
            local: clean,
            full: '967' + clean,
            international: '967' + clean
        };
    }
    
    // إذا لم يتطابق مع أي صيغة، نعيد الرقم كما هو
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

// --- تخزين مؤقت في الذاكرة ---
const tempStorage = new Map();

// --- API ذكي يتعامل مع أي صيغة رقم ---
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName } = req.query;
        console.log("=".repeat(50));
        console.log("🔍 فحص الجهاز");
        console.log("=".repeat(50));
        console.log("معرف الجهاز:", id);
        console.log("اسم التطبيق:", appName);
        
        // البحث بالجهاز واسم التطبيق معاً
        const snap = await db.collection('users')
            .where("deviceId", "==", id)
            .where("appName", "==", appName)
            .get();
        
        if (!snap.empty) {
            console.log(`✅ جهاز موجود مسجل لهذا التطبيق`);
            return res.status(200).send("SUCCESS");
        } else {
            console.log(`❌ جهاز غير مسجل لهذا التطبيق`);
            return res.status(404).send("NOT_FOUND");
        }
    } catch (error) {
        console.error("❌ خطأ في check-device:", error);
        res.status(500).send("ERROR");
    }
});

app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        
        console.log("=".repeat(50));
        console.log("📱 طلب كود جديد");
        console.log("=".repeat(50));
        console.log("الرقم المرسل من التطبيق:", phone);
        
        // تنسيق الرقم بشكل ذكي
        const formatted = formatPhoneNumber(phone);
        const localPhone = formatted.local;  // 554526287
        const fullPhone = formatted.full;    // 966554526287
        
        console.log("الرقم بعد التنسيق (محلي):", localPhone);
        console.log("الرقم بعد التنسيق (كامل):", fullPhone);
        console.log("الاسم:", name);
        console.log("التطبيق:", appName);
        console.log("معرف الجهاز:", deviceId);
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // تخزين في الذاكرة المؤقتة مع اسم التطبيق (باستخدام الرقم المحلي)
        tempStorage.set(localPhone + "_" + appName, {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            localPhone: localPhone,
            fullPhone: fullPhone,
            timestamp: Date.now()
        });
        
        // تخزين في Firebase مع اسم التطبيق (باستخدام الرقم المحلي)
        await db.collection('temp_codes').doc(localPhone + "_" + appName).set({
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            localPhone: localPhone,
            fullPhone: fullPhone,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`📦 تم تخزين الكود ${otp} للرقم ${localPhone} للتطبيق ${appName}`);
        console.log(`📱 جاري إرسال الكود إلى: ${fullPhone}`);
        
        await safeSend(normalizePhone(fullPhone), { 
            text: `🔐 كود تفعيل تطبيق ${appName} هو: *${otp}*` 
        });
        
        console.log(`✅ تم إرسال الكود بنجاح`);
        res.status(200).send("OK");
        
    } catch (error) {
        console.error("❌ خطأ في request-otp:", error);
        res.status(500).send("Error");
    }
});

app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        
        console.log("=".repeat(50));
        console.log("🔍 محاولة تحقق");
        console.log("=".repeat(50));
        console.log("الرقم المرسل من التطبيق:", phone);
        
        // تنسيق الرقم بشكل ذكي
        const formatted = formatPhoneNumber(phone);
        const localPhone = formatted.local;  // 554526287
        const fullPhone = formatted.full;    // 966554526287
        
        console.log("الرقم بعد التنسيق (محلي):", localPhone);
        console.log("الرقم بعد التنسيق (كامل):", fullPhone);
        console.log("الكود المرسل من التطبيق:", code);
        
        const inputCode = code.toString().trim();
        
        console.log(`🔍 البحث عن الكود للرقم: ${localPhone}`);
        
        // البحث في الذاكرة المؤقتة
        let foundData = null;
        let foundKey = null;
        let source = "memory";
        
        // البحث في الذاكرة المؤقتة
        for (let [key, value] of tempStorage.entries()) {
            if (key.startsWith(localPhone + "_") && value.otp.toString().trim() === inputCode) {
                foundData = value;
                foundKey = key;
                break;
            }
        }
        
        // إذا لم يوجد، ابحث في Firebase
        if (!foundData) {
            console.log(`🔍 البحث في Firebase`);
            const fbSnapshot = await db.collection('temp_codes').get();
            
            for (const doc of fbSnapshot.docs) {
                const docId = doc.id;
                if (docId.startsWith(localPhone + "_")) {
                    const data = doc.data();
                    if (data.otp.toString().trim() === inputCode) {
                        foundData = data;
                        foundKey = docId;
                        source = "firebase";
                        break;
                    }
                }
            }
        }
        
        if (!foundData) {
            console.log(`❌ لا يوجد كود صحيح للرقم: ${localPhone}`);
            return res.status(401).send("FAIL");
        }
        
        console.log(`📦 الكود المخزن: ${foundData.otp} (المصدر: ${source})`);
        console.log(`📱 اسم التطبيق: ${foundData.appName}`);
        
        // التحقق من الصلاحية (10 دقائق)
        const now = Date.now();
        const timestamp = foundData.timestamp || (foundData.createdAt?.toDate?.()?.getTime() || now);
        const diffMinutes = (now - timestamp) / (1000 * 60);
        
        console.log(`⏰ عمر الكود: ${diffMinutes.toFixed(1)} دقيقة`);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            if (foundKey) {
                tempStorage.delete(foundKey);
                await db.collection('temp_codes').doc(foundKey).delete();
            }
            return res.status(401).send("FAIL");
        }
        
        console.log(`✅ تحقق ناجح! الكود صحيح`);
        
        // استخدام الرقم الكامل من البيانات المخزنة أو تنسيقه
        const userFullPhone = foundData.fullPhone || fullPhone;
        
        // تسجيل المستخدم مع اسم التطبيق الخاص به
        await db.collection('users').doc(userFullPhone + "_" + foundData.appName).set({ 
            name: foundData.name || 'مستخدم',
            phone: userFullPhone,
            appName: foundData.appName || 'default',
            deviceId: foundData.deviceId || '',
            verifiedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // تنظيف
        if (foundKey) {
            tempStorage.delete(foundKey);
            await db.collection('temp_codes').doc(foundKey).delete();
        }
        
        // إبلاغ الإدمن
        await safeSend(normalizePhone(myNumber), { 
            text: `🆕 مستخدم جديد: ${userFullPhone}\n📱 التطبيق: ${foundData.appName}` 
        });
        
        console.log(`🎉 تم تسجيل المستخدم بنجاح للتطبيق ${foundData.appName}`);
        return res.status(200).send("SUCCESS");
        
    } catch (error) {
        console.error("❌ خطأ في verify-otp:", error);
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
    console.log("=".repeat(50));
    console.log(`🚀 السيرفر يعمل على المنفذ ${process.env.PORT || 10000}`);
    console.log(`📌 الرابط: https://threew3t3s3wts.onrender.com`);
    console.log("=".repeat(50));
    startBot();
});
