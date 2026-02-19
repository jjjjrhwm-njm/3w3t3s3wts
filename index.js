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
const myNumber = "966554526287";

// --- حالة المستخدمين للأوامر التفاعلية ---
const userState = new Map(); // لتخزين حالة كل مستخدم

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

// دالة عالمية لتوحيد صيغة الرقم لأي دولة
function formatPhoneNumber(phone) {
    // إزالة كل الرموز غير الرقمية
    let clean = phone.replace(/\D/g, '');
    
    // محاولة تحليل الرقم باستخدام مكتبة libphonenumber
    try {
        // محاولة تحليل الرقم كمحلي أولاً (بدون مفتاح دولة)
        let phoneNumber = parsePhoneNumberFromString(clean);
        
        // إذا فشل التحليل، حاول مع إضافة + في البداية
        if (!phoneNumber || !phoneNumber.isValid()) {
            phoneNumber = parsePhoneNumberFromString('+' + clean);
        }
        
        // إذا كان الرقم صحيحاً
        if (phoneNumber && phoneNumber.isValid()) {
            return {
                local: phoneNumber.nationalNumber,           // الرقم المحلي بدون مفتاح الدولة
                full: phoneNumber.number,                     // الرقم كاملاً مع +
                international: phoneNumber.number,            // نفس الرقم كاملاً
                countryCode: phoneNumber.countryCallingCode,  // مفتاح الدولة (مثل 966 للسعودية)
                isValid: true
            };
        }
    } catch (e) {
        console.log("⚠️ خطأ في تحليل الرقم:", e.message);
    }
    
    // إذا فشل التحليل، نحاول التعامل مع الصيغ الشائعة يدوياً
    console.log("⚠️ استخدام الطريقة اليدوية للرقم:", clean);
    
    // إزالة الأصفار البادئة
    while (clean.startsWith('0')) {
        clean = clean.substring(1);
    }
    
    // التعامل مع الصيغ المختلفة
    if (clean.startsWith('966') && clean.length > 9) { // سعودي مع المفتاح
        return {
            local: clean.substring(3),
            full: '+' + clean,
            international: '+' + clean,
            countryCode: '966',
            isValid: true
        };
    } else if (clean.startsWith('967') && clean.length > 9) { // يمني مع المفتاح
        return {
            local: clean.substring(3),
            full: '+' + clean,
            international: '+' + clean,
            countryCode: '967',
            isValid: true
        };
    } else if (clean.startsWith('974') && clean.length > 9) { // قطري مع المفتاح
        return {
            local: clean.substring(3),
            full: '+' + clean,
            international: '+' + clean,
            countryCode: '974',
            isValid: true
        };
    } else if (clean.startsWith('966') && clean.length === 12) { // سعودي
        return {
            local: clean.substring(3),
            full: '+' + clean,
            international: '+' + clean,
            countryCode: '966',
            isValid: true
        };
    } else if (clean.startsWith('967') && clean.length === 12) { // يمني
        return {
            local: clean.substring(3),
            full: '+' + clean,
            international: '+' + clean,
            countryCode: '967',
            isValid: true
        };
    } else if (clean.startsWith('974') && clean.length === 11) { // قطري
        return {
            local: clean.substring(3),
            full: '+' + clean,
            international: '+' + clean,
            countryCode: '974',
            isValid: true
        };
    } else if (clean.length === 9 && clean.startsWith('7')) { // يمني بدون مفتاح
        return {
            local: clean,
            full: '+967' + clean,
            international: '+967' + clean,
            countryCode: '967',
            isValid: true
        };
    } else if (clean.length === 8 && /^[34567]/.test(clean)) { // قطري بدون مفتاح
        return {
            local: clean,
            full: '+974' + clean,
            international: '+974' + clean,
            countryCode: '974',
            isValid: true
        };
    } else if (clean.length === 9 && clean.startsWith('5')) { // سعودي بدون مفتاح
        return {
            local: clean,
            full: '+966' + clean,
            international: '+966' + clean,
            countryCode: '966',
            isValid: true
        };
    }
    
    // إذا لم نتمكن من التعرف على الدولة، نفترض أن الرقم مكتمل
    return {
        local: clean,
        full: '+' + clean,
        international: '+' + clean,
        countryCode: 'unknown',
        isValid: true
    };
}

function normalizePhone(phone) {
    const formatted = formatPhoneNumber(phone);
    // إزالة + للإرسال عبر واتساب
    const withoutPlus = formatted.full.replace('+', '');
    return withoutPlus + "@s.whatsapp.net";
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

// --- 4. محرك الأوامر التفاعلي (لأي رقم) ---
async function processCommand(jid, text, sender, isMe) {
    // ✅ تم التعديل هنا: إزالة شرط التحقق من الرقم
    // الآن أي شخص يمكنه استخدام الأوامر

    const currentState = userState.get(jid);

    // إذا كان المستخدم في حالة تفاعلية (نشر)
    if (currentState) {
        // أمر الإلغاء
        if (text.toLowerCase() === "الغاء" || text === "خروج" || text === "إلغاء") {
            userState.delete(jid);
            await safeSend(jid, { text: "❌ تم إلغاء العملية بنجاح." });
            return true;
        }

        // معالجة خطوات النشر
        if (currentState.command === "نشر") {
            // الخطوة 1: استلام الرابط
            if (currentState.step === "waiting_link") {
                if (!text.startsWith('http')) {
                    await safeSend(jid, { text: "❌ رابط غير صحيح. أرسل رابطاً يبدأ بـ http" });
                    return true;
                }
                currentState.link = text;
                currentState.step = "waiting_desc";
                userState.set(jid, currentState);
                await safeSend(jid, { text: "✅ تم استلام الرابط.\nالآن أرسل *الوصف* (يمكن أن يكون نصاً مع صور)" });
                return true;
            }

            // الخطوة 2: استلام الوصف
            if (currentState.step === "waiting_desc") {
                currentState.desc = text;
                currentState.step = "waiting_target";
                userState.set(jid, currentState);
                
                // جلب جميع أسماء التطبيقات الفريدة من قاعدة البيانات
                const usersSnapshot = await db.collection('users').get();
                const appNames = [...new Set(usersSnapshot.docs.map(d => d.data().appName))].filter(name => name && name !== 'default');
                
                let menu = "🎯 *اختر الجمهور المستهدف:*\n\n";
                menu += "0 - 🌐 *الجميع*\n\n";
                
                appNames.forEach((app, index) => {
                    menu += `${index + 1} - 📱 *${app}*\n`;
                });
                
                menu += "\n💡 أرسل رقم الخيار المطلوب.\n";
                menu += "❌ أرسل *إلغاء* للإلغاء.";
                
                await safeSend(jid, { text: menu });
                return true;
            }

            // الخطوة 3: التنفيذ النهائي
            if (currentState.step === "waiting_target") {
                const usersSnapshot = await db.collection('users').get();
                const appNames = [...new Set(usersSnapshot.docs.map(d => d.data().appName))].filter(name => name && name !== 'default');
                
                let targets = [];
                let targetDescription = "";

                // إذا اختار الجميع
                if (text === "0") { 
                    targets = usersSnapshot.docs;
                    targetDescription = "الجميع";
                } else {
                    const idx = parseInt(text) - 1;
                    if (isNaN(idx) || idx < 0 || idx >= appNames.length) {
                        await safeSend(jid, { text: "❌ رقم غير صحيح. اختر من القائمة أو أرسل *إلغاء*." });
                        return true;
                    }
                    const selectedApp = appNames[idx];
                    targets = usersSnapshot.docs.filter(d => d.data().appName === selectedApp);
                    targetDescription = `تطبيق *${selectedApp}*`;
                }

                await safeSend(jid, { text: `🚀 جاري النشر لـ ${targets.length} مستخدم من ${targetDescription}...` });
                
                let successCount = 0;
                let failCount = 0;
                
                for (const d of targets) {
                    try {
                        const userPhone = d.data().phone;
                        // تنسيق الرسالة
                        const messageContent = { 
                            text: `📢 *تحديث جديد!*\n\n${currentState.desc}\n\n🔗 ${currentState.link}` 
                        };
                        
                        await safeSend(normalizePhone(userPhone), messageContent);
                        successCount++;
                    } catch (e) {
                        failCount++;
                        console.log(`❌ فشل إرسال إلى ${d.data().phone}:`, e.message);
                    }
                    
                    // تأخير بسيط بين الرسائل
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                // إنهاء الحالة التفاعلية
                userState.delete(jid);
                
                // إرسال تقرير نهائي
                const report = `✅ *تم النشر بنجاح!*\n\n📊 *الإحصائيات:*\n✓ تم الإرسال: ${successCount}\n✗ فشل: ${failCount}\n👥 المجموع: ${targets.length}\n🎯 المستهدف: ${targetDescription}`;
                await safeSend(jid, { text: report });
                
                return true;
            }
        }
        return true;
    }

    // الأوامر الرئيسية - أي شخص يمكنه استخدامها الآن
    if (!text.startsWith("نجم")) return false;

    switch (text) {
        case "نجم":
        case "نجم مساعدة":
            await safeSend(jid, { text: `🌟 *أوامر نجم الإبداع:*

1️⃣ *نجم نشر* - نشر إعلان (خطوات تفاعلية)
2️⃣ *نجم احصا* - إحصائيات المستخدمين
3️⃣ *نجم حالة* - حالة البوت

💡 أرسل *إلغاء* أثناء النشر للإلغاء.` });
            break;
            
        case "نجم نشر":
            userState.set(jid, { command: "نشر", step: "waiting_link" });
            await safeSend(jid, { text: "🔗 *خطوة 1/3*\nأرسل *رابط التطبيق* الآن:" });
            break;
            
        case "نجم احصا":
            const usersSnap = await db.collection('users').get();
            const appStats = {};
            usersSnap.docs.forEach(doc => {
                const appName = doc.data().appName || 'غير معروف';
                appStats[appName] = (appStats[appName] || 0) + 1;
            });
            
            let statsText = "📊 *إحصائيات المستخدمين:*\n\n";
            statsText += `👥 *الإجمالي:* ${usersSnap.size}\n\n`;
            statsText += "📱 *حسب التطبيق:*\n";
            
            for (const [app, count] of Object.entries(appStats)) {
                statsText += `• ${app}: ${count} مستخدم\n`;
            }
            
            await safeSend(jid, { text: statsText });
            break;
            
        case "نجم حالة":
            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            
            await safeSend(jid, { text: `⚡ *حالة البوت:*\n\n✅ البوت: متصل\n⏱️ وقت التشغيل: ${hours} ساعة ${minutes} دقيقة` });
            break;
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

    // معالجة الرسائل الواردة
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const jid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const sender = jid.split('@')[0].split(':')[0];
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();

            if (!text) return;

            // معالجة الأوامر
            await processCommand(jid, text, sender, isMe);
            
        } catch (e) { console.log("❌ خطأ معالجة الرسالة:", e.message); }
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

// --- API عالمي يتعامل مع أي رقم من أي دولة ---
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
        
        // تنسيق الرقم بشكل عالمي
        const formatted = formatPhoneNumber(phone);
        const localPhone = formatted.local;
        const fullPhone = formatted.full.replace('+', ''); // نزيل + للتخزين
        const countryCode = formatted.countryCode;
        
        console.log("الرقم بعد التنسيق (محلي):", localPhone);
        console.log("الرقم بعد التنسيق (كامل):", fullPhone);
        console.log("مفتاح الدولة:", countryCode);
        console.log("الاسم:", name);
        console.log("التطبيق:", appName);
        console.log("معرف الجهاز:", deviceId);
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // مفتاح تخزين فريد (الرقم المحلي + اسم التطبيق)
        const storageKey = localPhone + "_" + appName;
        
        // تخزين في الذاكرة المؤقتة
        tempStorage.set(storageKey, {
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            localPhone: localPhone,
            fullPhone: fullPhone,
            countryCode: countryCode,
            timestamp: Date.now()
        });
        
        // تخزين في Firebase
        await db.collection('temp_codes').doc(storageKey).set({
            otp: otp,
            name: name || 'مستخدم',
            appName: appName || 'default',
            deviceId: deviceId || '',
            localPhone: localPhone,
            fullPhone: fullPhone,
            countryCode: countryCode,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`📦 تم تخزين الكود ${otp} للرقم ${fullPhone} للتطبيق ${appName}`);
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
        
        // تنسيق الرقم بشكل عالمي
        const formatted = formatPhoneNumber(phone);
        const localPhone = formatted.local;
        const fullPhone = formatted.full.replace('+', '');
        
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
        console.log(`🌍 مفتاح الدولة: ${foundData.countryCode || 'unknown'}`);
        
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
        
        // استخدام الرقم الكامل من البيانات المخزنة
        const userFullPhone = foundData.fullPhone || fullPhone;
        
        // مفتاح فريد للمستخدم (الرقم الكامل + اسم التطبيق)
        const userKey = userFullPhone + "_" + foundData.appName;
        
        // تسجيل المستخدم مع اسم التطبيق الخاص به
        await db.collection('users').doc(userKey).set({ 
            name: foundData.name || 'مستخدم',
            phone: userFullPhone,
            localPhone: foundData.localPhone,
            countryCode: foundData.countryCode || 'unknown',
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
            text: `🆕 مستخدم جديد: ${userFullPhone}\n📱 التطبيق: ${foundData.appName}\n🌍 الدولة: ${foundData.countryCode || 'unknown'}` 
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
