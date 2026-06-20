require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// ----------------- CONFIGURATIONS -----------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const META_TOKEN = process.env.META_ACCESS_TOKEN; // पुराना नाम सेट कर दिया
const PHONE_ID = process.env.PHONE_NUMBER_ID;     // पुराना नाम सेट कर दिया
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// इन-मेमोरी स्टेट मैनेजमेंट (यूजर की बातचीत याद रखने के लिए)
const userSessions = {}; 
const ownerSession = { step: null, shopName: 'ABC', products: [] };

const OWNER_NUMBER = "9667805579"; // ⚠️ यहाँ अपना (दुकानदार का) असली वॉट्सऐप नंबर डालो

// ----------------- HELPER FUNCTIONS -----------------
async function sendWhatsAppMessage(toNumber, textBody) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_ID}/messages`, {
            messaging_product: "whatsapp",
            to: toNumber,
            type: "text",
            text: { body: textBody }
        }, {
            headers: { 
                'Authorization': `Bearer ${META_TOKEN}`, 
                'Content-Type': 'application/json' 
            }
        });
    } catch (err) {
        console.error("❌ Error sending message:", err.response ? err.response.data : err.message);
    }
}

// ऑटोमैटिक पीडीएफ जनरेट करने का फंक्शन
function generatePDF(shopName, productsList, callback) {
    const doc = new PDFDocument();
    const filename = `catalog_${Date.now()}.pdf`;
    const filePath = path.join(__dirname, filename);
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);
    doc.fontSize(24).text(shopName, { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text("Product Catalog / प्रोडक्ट सूची", { align: 'center' });
    doc.moveDown();

    productsList.forEach(p => {
        doc.fontSize(12).text(`Code: ${p.unique_code} | Name: ${p.name} | Weight: ${p.weight} | Price: ₹${p.price}`);
        doc.moveDown(0.5);
    });

    doc.end();
    stream.on('finish', () => callback(filePath, filename));
}

// ----------------- WEBHOOK VALIDATION -----------------
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ----------------- MAIN WEBHOOK LOGIC -----------------
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Meta को तुरंत Response

    const body = req.body;
    if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) return;

    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const msgText = message.text?.body?.trim();

    if (!msgText) return;

    // ================= OWNER FLOW =================
    if (from === OWNER_NUMBER) {
        if (msgText.toUpperCase().startsWith("SHOP:")) {
            ownerSession.shopName = msgText.split(":")[1].trim();
            ownerSession.step = "ADD_PRODUCT";
            ownerSession.products = [];
            await sendWhatsAppMessage(OWNER_NUMBER, `🏪 शॉप का नाम "${ownerSession.shopName}" सेट हो गया है।\n\nअब पहले प्रोडक्ट की डिटेल इस फॉर्मेट में भेजें:\n*नाम, वजन, कीमत*\n\n(उदाहरण: आलू, 5kg, 120)`);
            return;
        }

        if (ownerSession.step === "ADD_PRODUCT") {
            if (msgText.toUpperCase() === "DONE") {
                if (ownerSession.products.length === 0) {
                    await sendWhatsAppMessage(OWNER_NUMBER, "❌ कम से कम एक प्रोडक्ट तो जोड़ो भाई!");
                    return;
                }
                
                generatePDF(ownerSession.shopName, ownerSession.products, async (filePath, filename) => {
                    await sendWhatsAppMessage(OWNER_NUMBER, `✅ कैटलॉग ऑटोमेशन से तैयार है! कुल ${ownerSession.products.length} प्रोडक्ट्स लिस्ट हो गए हैं और डेटाबेस में सुरक्षित सेव हो चुके हैं। अब कस्टमर्स ऑर्डर कर सकते हैं।`);
                    ownerSession.step = null;
                });
                return;
            }

            const parts = msgText.split(",");
            if (parts.length === 3) {
                const uniqueCode = "PROD" + Math.floor(1000 + Math.random() * 9000);
                const newProd = {
                    unique_code: uniqueCode,
                    name: parts[0].trim(),
                    weight: parts[1].trim(),
                    price: parseFloat(parts[2].trim())
                };

                // Supabase में सेव करें
                await supabase.from('products').insert([newProd]);
                ownerSession.products.push(newProd);

                await sendWhatsAppMessage(OWNER_NUMBER, `📥 जोड़ा गया: ${newProd.name} (${uniqueCode})\n\nअगला प्रोडक्ट भेजें या लिस्ट पूरी होने पर *DONE* लिखकर भेजें।`);
            } else {
                await sendWhatsAppMessage(OWNER_NUMBER, "❌ गलत फॉर्मेट! कृपया इस तरह भेजें: नाम, वजन, कीमत");
            }
            return;
        }
    }

    // ================= CUSTOMER FLOW =================
    if (!userSessions[from]) {
        userSessions[from] = { step: "LANG_SELECT" };
        await sendWhatsAppMessage(from, "👋 Welcome! Please select your language / कृपया अपनी भाषा चुनें:\n\n1. English\n2. Hindi (हिंदी)");
        return;
    }

    const session = userSessions[from];

    // 1. भाषा का चुनाव
    if (session.step === "LANG_SELECT") {
        if (msgText === "1") {
            session.lang = "en";
            session.step = "MAIN_MENU";
            await sendWhatsAppMessage(from, "English selected.\n\nType *1* to Buy\nType *2* for Return/Exchange");
        } else if (msgText === "2") {
            session.lang = "hi";
            session.step = "MAIN_MENU";
            await sendWhatsAppMessage(from, "हिंदी चुनी गई है।\n\nखरीदने के लिए *1* भेजें\nरिटर्न/एक्सचेंज के लिए *2* भेजें");
        } else {
            await sendWhatsAppMessage(from, "❌ Invalid Option. Please reply with 1 or 2.");
        }
        return;
    }

    // 2. मुख्य मेनू (Buy / Return)
    if (session.step === "MAIN_MENU") {
        if (msgText === "1") {
            session.step = "ENTER_CODE";
            
            // डेटाबेस से सारे प्रोडक्ट्स निकालना
            const { data: products } = await supabase.from('products').select('*');
            let catalogText = session.lang === "hi" ? "📋 उपलब्ध प्रोडक्ट्स की सूची (PDF जनरेटेड):\n\n" : "📋 Available Products List (PDF Generated):\n\n";
            
            if(!products || products.length === 0) {
                catalogText += session.lang === "hi" ? "अभी कोई प्रोडक्ट उपलब्ध नहीं है।" : "No products available right now.";
                await sendWhatsAppMessage(from, catalogText);
                return;
            }

            products.forEach(p => {
                catalogText += `🔹 Code: *${p.unique_code}* | ${p.name} (${p.weight}) - ₹${p.price}\n`;
            });

            catalogText += session.lang === "hi" ? "\n🛒 कृपया जो प्रोडक्ट खरीदना है उसका **Unique Code** लिखकर भेजें।" : "\n🛒 Please reply with the **Unique Code** of the product you want to buy.";
            await sendWhatsAppMessage(from, catalogText);
        } else if (msgText === "2") {
            const returnMsg = session.lang === "hi" ? "🔄 हमारे ओनर जल्द ही रिटर्न/एक्सचेंज के लिए आपसे संपर्क करेंगे।" : "🔄 Our owner will contact you shortly regarding Return/Exchange.";
            await sendWhatsAppMessage(from, returnMsg);
            delete userSessions[from];
        } else {
            await sendWhatsAppMessage(from, session.lang === "hi" ? "❌ कृपया 1 या 2 दबाएं।" : "❌ Please reply with 1 or 2.");
        }
        return;
    }

    // 3. प्रोडक्ट का यूनिक कोड डालना
    if (session.step === "ENTER_CODE") {
        const { data: product } = await supabase.from('products').select('*').eq('unique_code', msgText.toUpperCase()).single();

        if (product) {
            session.pendingOrder = product;
            session.step = "CONFIRM_ORDER";

            let confText = session.lang === "hi" ? 
                `🧐 *ऑर्डर की पुष्टि करें:*\n\n📦 नाम: ${product.name}\n⚖️ वजन: ${product.weight}\n💰 कीमत: ₹${product.price}\n\nटोटल अमाउंट: *₹${product.price}*\n\nऑर्डर फाइनल करने के लिए *YES* लिखें, कैंसिल करने के लिए *NO* लिखें।` :
                `🧐 *Confirm Your Order:*\n\n📦 Name: ${product.name}\n⚖️ Weight: ${product.weight}\n💰 Price: ₹${product.price}\n\nTotal Amount: *₹${product.price}*\n\nReply *YES* to confirm, *NO* to cancel.`;

            await sendWhatsAppMessage(from, confText);
        } else {
            await sendWhatsAppMessage(from, session.lang === "hi" ? "❌ गलत कोड! कृपया सही प्रोडक्ट कोड दोबारा डालें।" : "❌ Invalid code! Please enter a valid product code.");
        }
        return;
    }

    // 4. ऑर्डर कन्फर्मेशन और ओनर नोटिफिकेशन
    if (session.step === "CONFIRM_ORDER") {
        if (msgText.toUpperCase() === "YES") {
            const orderItem = session.pendingOrder;

            // डेटाबेस में ऑर्डर सेव करें
            await supabase.from('orders').insert([{
                customer_phone: from,
                items: orderItem,
                total_amount: orderItem.price
            }]);

            // कस्टमर को मैसेज
            await sendWhatsAppMessage(from, session.lang === "hi" ? "🎉 आपका ऑर्डर सफलतापूर्वक प्लेस हो गया है! धन्यवाद।" : "🎉 Your order has been successfully placed! Thank you.");

            // ओनर को तुरंत अलर्ट भेजना
            const ownerNotification = `🚨 *नया ऑर्डर आया है!* 🚨\n\n👤 कस्टमर नंबर: +${from}\n📦 प्रोडक्ट: ${orderItem.name}\n⚖️ वजन: ${orderItem.weight}\n💰 कुल कीमत: ₹${orderItem.price}`;
            await sendWhatsAppMessage(OWNER_NUMBER, ownerNotification);

            delete userSessions[from];
        } else {
            await sendWhatsAppMessage(from, session.lang === "hi" ? "❌ ऑर्डर कैंसिल कर दिया गया है। शुरू करने के लिए कुछ भी लिखकर भेजें।" : "❌ Order cancelled. Type anything to start again.");
            delete userSessions[from];
        }
        return;
    }
});

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Bot Server running on port ${PORT}`));