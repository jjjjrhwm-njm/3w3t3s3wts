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
const myNumber = "966554526287"; // رقم الإدمن

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

// --- 2. النبض الحديدي (كل 10 دقائق) ---
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
        } else {
            console.log("⚠️ لا توجد هوية محفوظة في Firebase");
            return false;
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

// --- 4. محرك معالجة الأوامر ---
async function processCommand(jid, text, sender, isMe) {
    const botTokens = ["أرسل", "تم استلام", "رقم غير صحيح", "✅", "❌", "🎯", "🌟", "🚀"];
    if (isMe && botTokens.some(token => text.includes(token))) return true;

    if (sender !== myNumber && !isMe) return false;

    const currentState = userState.get(jid);

    if (currentState) {
        if (text.toLowerCase() === "خروج") {
            userState.delete(jid);
            await safeSend(jid, { text: "❌ تم إلغاء العملية والعودة للوضع الطبيعي." });
            return true;
        }

        if (currentState.command === "نشر") {
            if (currentState.step === "waiting_link") {
                if (!text.startsWith('http')) {
                    await safeSend(jid, { text: "❌ رابط غير صحيح. أرسل رابطاً يبدأ بـ http" });
                    return true;
                }
                currentState.link = text;
                currentState.step = "waiting_desc";
                userState.set(jid, currentState);
                await safeSend(jid, { text: "✅ تم استلام الرابط. الآن أرسل *الوصف*:" });
                return true;
            }

            if (currentState.step === "waiting_desc") {
                currentState.desc = text;
                currentState.step = "waiting_target";
                userState.set(jid, currentState);
                
                const snap = await db.collection('users').get();
                let apps = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                let menu = "🎯 *اختر الجمهور المستهدف:*\n\n0 - 🌐 إرسال للجميع\n";
                apps.forEach((n, i) => menu += `${i + 1} - 📱 مستخدمي [${n}]\n`);
                await safeSend(jid, { text: menu + "\n💡 أرسل رقم الخيار المطلوب." });
                return true;
            }

            if (currentState.step === "waiting_target") {
                const snap = await db.collection('users').get();
                let appsArr = [...new Set(snap.docs.map(d => d.data().appName || "عام"))];
                let targets = [];

                if (text === "0") { 
                    targets = snap.docs; 
                } else {
                    const idx = parseInt(text) - 1;
                    if (isNaN(idx) || !appsArr[idx]) {
                        await safeSend(jid, { text: "❌ رقم غير صحيح. اختر من القائمة أو أرسل *خروج*:" });
                        return true;
                    }
                    targets = snap.docs.filter(d => (d.data().appName || "عام") === appsArr[idx]);
                }

                await safeSend(jid, { text: `🚀 جاري النشر لـ ${targets.length} مستخدم...` });
                
                let successCount = 0;
                for (const d of targets) {
                    try {
                        await safeSend(normalizePhone(d.data().phone), { 
                            text: `📢 *تحديث جديد من نجم الإبداع!*\n\n${currentState.desc}\n\n🔗 ${currentState.link}` 
                        });
                        successCount++;
                    } catch (e) {}
                }
                
                userState.delete(jid);
                await safeSend(jid, { text: `✅ تم النشر بنجاح لـ ${successCount} من أصل ${targets.length} مستخدم!` });
                return true;
            }
        }
        return true;
    }

    if (!text.startsWith("نجم")) return false;

    switch (text) {
        case "نجم":
        case "نجم مساعدة":
            await safeSend(jid, { text: `🌟 *أوامر نجم الإبداع:*

1️⃣ *نجم نشر* - إعلان تفاعلي (3 خطوات)
2️⃣ *نجم احصا* - إحصائيات المستخدمين
3️⃣ *نجم بنج* - فحص سرعة الاتصال

💡 أرسل *خروج* للإلغاء أثناء النشر.` });
            break;
            
        case "نجم نشر":
            userState.set(jid, { command: "نشر", step: "waiting_link" });
            await safeSend(jid, { text: "🔗 *خطوة 1/3*\nأرسل *رابط التطبيق* الآن:" });
            break;
            
        case "نجم احصا":
            const snap = await db.collection('users').get();
            await safeSend(jid, { text: `📊 إجمالي الموثقين: ${snap.size}` });
            break;
            
        case "نجم بنج":
            const start = Date.now();
            await safeSend(jid, { text: "🏓 جاري الفحص..." });
            await safeSend(jid, { text: `✅ الاستجابة: ${Date.now() - start}ms` });
            break;
    }
    return true;
}

async function startBot() {
    if (isStarting) return;
    isStarting = true;

    const folder = './auth_info_stable';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    
    // استعادة الهوية
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

            const now = Math.floor(Date.now() / 1000);
            if (now - msg.messageTimestamp > 15) return;

            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();

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
            console.log("🚀 النظام متصل ومستقر بهوية 966554526287");
            setTimeout(() => {
                safeSend(normalizePhone(myNumber), { text: "🌟 *نجم الإبداع جاهز للعمل!*\nأرسل *نجم* للتحكم." });
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

// --- ممرات الـ API (معدلة بالكامل) ---
app.get("/check-device", async (req, res) => {
    try {
        const { id, appName } = req.query;
        const snap = await db.collection('users').where("deviceId", "==", id).where("appName", "==", appName).get();
        res.status(snap.empty ? 404 : 200).send(snap.empty ? "NOT_FOUND" : "SUCCESS");
    } catch (error) {
        res.status(500).send("ERROR");
    }
});

// ✅ تخزين الكود في Firebase مع deviceId
app.get("/request-otp", async (req, res) => {
    try {
        const { phone, name, app: appName, deviceId } = req.query;
        const formattedPhone = phone.replace(/\D/g, '');
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        console.log(`📱 طلب كود: ${formattedPhone} الكود: ${otp} الجهاز: ${deviceId}`);
        
        // تخزين الكود مع ربطه بالجهاز
        await db.collection('pending_otps').doc(deviceId).set({
            phone: formattedPhone,
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // أيضاً تخزين مؤشر للبحث بالرقم
        await db.collection('phone_codes').doc(formattedPhone).set({
            deviceId: deviceId,
            otp: otp,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // إرسال الكود
        await safeSend(normalizePhone(formattedPhone), { 
            text: `🔐 أهلاً ${name}، كود دخولك لـ [${appName}] هو: *${otp}*` 
        });
        
        res.status(200).send("OK");
    } catch (error) {
        console.error("❌ خطأ:", error);
        res.status(500).send("Error");
    }
});

// ✅ التحقق من الكود بالبحث في كلا المجموعتين
app.get("/verify-otp", async (req, res) => {
    try {
        const { phone, code } = req.query;
        const formattedPhone = phone.replace(/\D/g, '');
        const inputCode = code.toString().trim();
        
        console.log(`🔍 محاولة تحقق: الرقم ${formattedPhone}، الكود: ${inputCode}`);
        
        // البحث في phone_codes أولاً
        const phoneDoc = await db.collection('phone_codes').doc(formattedPhone).get();
        
        if (!phoneDoc.exists) {
            console.log(`❌ لا يوجد كود للرقم: ${formattedPhone}`);
            return res.status(401).send("FAIL");
        }
        
        const phoneData = phoneDoc.data();
        const deviceId = phoneData.deviceId;
        const storedOtp = phoneData.otp.toString().trim();
        
        // التحقق من الصلاحية
        const createdAt = phoneData.createdAt?.toDate?.() || new Date();
        const now = new Date();
        const diffMinutes = (now - createdAt) / (1000 * 60);
        
        if (diffMinutes > 10) {
            console.log(`⏰ الكود منتهي الصلاحية`);
            await phoneDoc.ref.delete();
            await db.collection('pending_otps').doc(deviceId).delete();
            return res.status(401).send("FAIL");
        }
        
        // مقارنة الكود
        if (storedOtp === inputCode) {
            console.log(`✅ تحقق ناجح للرقم: ${formattedPhone}`);
            
            // البحث عن البيانات الكاملة
            const otpDoc = await db.collection('pending_otps').doc(deviceId).get();
            const fullData = otpDoc.exists ? otpDoc.data() : phoneData;
            
            // تسجيل المستخدم
            await db.collection('users').doc(formattedPhone).set({ 
                name: fullData.name || 'مستخدم',
                phone: formattedPhone,
                appName: fullData.appName || 'default',
                deviceId: deviceId,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            // تنظيف البيانات المؤقتة
            await phoneDoc.ref.delete();
            await db.collection('pending_otps').doc(deviceId).delete();
            
            // إبلاغ الإدمن
            await safeSend(normalizePhone(myNumber), { 
                text: `🆕 مستخدم جديد: ${fullData.name || 'مستخدم'} (${formattedPhone})` 
            });
            
            return res.status(200).send("SUCCESS");
        } else {
            console.log(`❌ كود غير صحيح: المدخل ${inputCode} ≠ المخزن ${storedOtp}`);
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
