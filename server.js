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
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// In-memory sessions to manage user states for both owners and customers
const sessions = {}; 

// ----------------- HELPER FUNCTIONS -----------------
// Function to send WhatsApp text messages via Meta Cloud API
async function sendWhatsAppMessage(toNumber, textBody) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_ID}/messages`, {
            messaging_product: "whatsapp",
            to: toNumber,
            type: "text",
            text: { body: textBody }
        }, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' }
        });
    } catch (err) {
        console.error("❌ Error sending message:", err.response ? err.response.data : err.message);
    }
}

// Function to automatically generate product catalog PDF
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

// ----------------- OWNER DASHBOARD WEB PAGE -----------------
// Web endpoint for owners to view their live customer orders on mobile browser
app.get('/dashboard/:ownerPhone', async (req, res) => {
    const ownerPhone = req.params.ownerPhone;
    
    // Fetch shop name and orders list from Supabase
    const { data: store } = await supabase.from('stores').select('shop_name').eq('owner_phone', ownerPhone).single();
    const { data: orders } = await supabase.from('orders').select('*').eq('owner_phone', ownerPhone).order('created_at', { ascending: false });

    if (!store) return res.send("<h3>❌ Store not found. Please register on WhatsApp first.</h3>");

    let rows = "";
    orders?.forEach(o => {
        rows += `
        <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 12px;">+${o.customer_phone}</td>
            <td style="padding: 12px;">${o.items.name} (${o.items.weight})</td>
            <td style="padding: 12px;">₹${o.total_amount}</td>
            <td style="padding: 12px;"><span style="background: #e1f5fe; color: #0288d1; padding: 4px 8px; border-radius: 4px;">${o.status}</span></td>
            <td style="padding: 12px;">${new Date(o.created_at).toLocaleString('hi-IN')}</td>
        </tr>`;
    });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>${store.shop_name} - Orders</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; margin: 20px; background: #f4f7f6;">
        <h2 style="color: #2e7d32;">🏪 ${store.shop_name} - Live Orders</h2>
        <p>Owner Number: +${ownerPhone}</p>
        <div style="overflow-x:auto; background: white; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
            <table style="width: 100%; border-collapse: collapse; text-align: left;">
                <tr style="background: #2e7d32; color: white;">
                    <th style="padding: 12px;">Customer Phone</th>
                    <th style="padding: 12px;">Product</th>
                    <th style="padding: 12px;">Total</th>
                    <th style="padding: 12px;">Status</th>
                    <th style="padding: 12px;">Time</th>
                </tr>
                ${rows || '<tr><td colspan="5" style="padding: 20px; text-align:center;">No orders received yet.</td></tr>'}
            </table>
        </div>
        <br>
        <button onclick="window.location.reload()" style="background: #2e7d32; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer;">🔄 Refresh Page</button>
    </body>
    </html>`;
    
    res.send(html);
});

// ----------------- WEBHOOK VALIDATION -----------------
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

// ----------------- MAIN WEBHOOK LOGIC -----------------
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const msgText = message.text?.body?.trim();
    if (!msgText) return;

    // Verify if the incoming phone number is a registered owner or attempting registration
    const { data: checkStore } = await supabase.from('stores').select('*').eq('owner_phone', from).single();
    const isOwner = checkStore || msgText.toUpperCase().startsWith("SHOP:");

    if (!sessions[from]) sessions[from] = { step: "START" };
    const session = sessions[from];

    // ================= 🏪 MULTI-OWNER FLOW =================
    if (isOwner) {
        // Owner sets or updates their shop name
        if (msgText.toUpperCase().startsWith("SHOP:")) {
            const shopName = msgText.split(":")[1].trim();
            await supabase.from('stores').upsert({ owner_phone: from, shop_name: shopName });
            session.step = "ASK_PRODUCT_NAME";
            session.products = [];
            session.shopName = shopName;
            await sendWhatsAppMessage(from, `🏪 Your shop *"${shopName}"* has been registered successfully!\n\nTo build your product catalog, please send the **Name** of your first product:`);
            return;
        }

        // Owner requests their live dashboard tracking link
        if (msgText.toUpperCase() === "ORDERS" || msgText === "ऑर्डर") {
            const dashboardLink = `https://${req.headers.host}/dashboard/${from}`;
            await sendWhatsAppMessage(from, `📋 To view all live incoming orders for your store, open this link on your phone:\n\n🔗 ${dashboardLink}`);
            return;
        }

        // Handle product name input
        if (session.step === "ASK_PRODUCT_NAME") {
            session.currentProduct = { name: msgText };
            session.step = "ASK_PRODUCT_WEIGHT";
            await sendWhatsAppMessage(from, `⚖️ Product name is set to "${msgText}". Now send its **Weight/Quantity** (e.g., 1kg, 500g, 1 Packet):`);
            return;
        }

        // Handle product weight input
        if (session.step === "ASK_PRODUCT_WEIGHT") {
            session.currentProduct.weight = msgText;
            session.step = "ASK_PRODUCT_PRICE";
            await sendWhatsAppMessage(from, `💰 Weight is set to "${msgText}". Now enter its **Price** using numbers only (e.g., 150):`);
            return;
        }

        // Handle product price input and insert into database
        if (session.step === "ASK_PRODUCT_PRICE") {
            const priceNum = parseFloat(msgText);
            if (isNaN(priceNum)) {
                await sendWhatsAppMessage(from, "❌ Invalid input. Please enter the price in numbers only. Try again:");
                return;
            }
            session.currentProduct.price = priceNum;
            const uniqueCode = "PROD" + Math.floor(1000 + Math.random() * 9000);

            const finalProduct = {
                owner_phone: from,
                unique_code: uniqueCode,
                name: session.currentProduct.name,
                weight: session.currentProduct.weight,
                price: session.currentProduct.price
            };

            await supabase.from('products').insert([finalProduct]);
            session.products.push(finalProduct);

            session.step = "ASK_NEXT_OR_DONE";
            await sendWhatsAppMessage(from, `📥 *Product Added Successfully!*\n🔹 Code: ${uniqueCode}\n🔹 Name: ${finalProduct.name}\n🔹 Weight: ${finalProduct.weight}\n🔹 Price: ₹${finalProduct.price}\n\nWhat would you like to do next?\nReply *1* - To add another product\nReply *DONE* - To finish listing and generate PDF catalog\nReply *ORDERS* - To view your dashboard`);
            return;
        }

        // Check whether owner wants to add more items or finish configuration
        if (session.step === "ASK_NEXT_OR_DONE") {
            if (msgText === "1") {
                session.step = "ASK_PRODUCT_NAME";
                await sendWhatsAppMessage(from, "📦 Please send the **Name** of the next product:");
            } else if (msgText.toUpperCase() === "DONE") {
                generatePDF(session.shopName || checkStore.shop_name, session.products, async (filePath, filename) => {
                    await sendWhatsAppMessage(from, `✅ Digital catalog is ready! All products are securely saved.\n\nYou can text *ORDERS* at any time to track incoming customer purchases.`);
                    session.step = "OWNER_IDLE";
                });
            }
            return;
        }
        return;
    }

    // ================= 👤 CUSTOMER FLOW =================
    // Customer initiates chat session
    if (session.step === "START") {
        session.step = "LANG_SELECT";
        await sendWhatsAppMessage(from, "👋 Welcome! Please select your language / कृपया अपनी भाषा चुनें:\n\n1. English\n2. Hindi (हिंदी)");
        return;
    }

    // Capture customer language selection
    if (session.step === "LANG_SELECT") {
        session.lang = msgText === "2" ? "hi" : "en";
        session.step = "ENTER_OWNER_SHOP";
        const msg = session.lang === "hi" ? "🏪 कृपया उस दुकानदार का मोबाइल नंबर डालें जिससे आप सामान खरीदना चाहते हैं (बिना + के, जैसे: 919876543210):" : "🏪 Please enter the Shop Owner's mobile number you want to buy from (e.g., 919876543210):";
        await sendWhatsAppMessage(from, msg);
        return;
    }

    // Verify shop owner existence for standard multi-tenant testing configuration
    if (session.step === "ENTER_OWNER_SHOP") {
        const { data: store } = await supabase.from('stores').select('*').eq('owner_phone', msgText).single();
        if (!store) {
            await sendWhatsAppMessage(from, "❌ This shop is not registered in our system. Please enter a valid owner phone number:");
            return;
        }
        session.targetOwner = msgText;
        session.step = "MAIN_MENU";
        const menuMsg = session.lang === "hi" ? `🏪 आप *"${store.shop_name}"* से जुड़े हैं।\n\nखरीदने के लिए *1* भेजें\nरिटर्न/एक्सचेंज के लिए *2* भेजें` : `🏪 You are connected to *"${store.shop_name}"*.\n\nReply *1* to Buy\nReply *2* for Return/Exchange`;
        await sendWhatsAppMessage(from, menuMsg);
        return;
    }

    // Handle Buy or Return navigation choice
    if (session.step === "MAIN_MENU") {
        if (msgText === "1") {
            session.step = "ENTER_CODE";
            const { data: products } = await supabase.from('products').select('*').eq('owner_phone', session.targetOwner);
            
            let catalogText = session.lang === "hi" ? "📋 उपलब्ध प्रोडक्ट्स की सूची:\n\n" : "📋 Available Products List:\n\n";
            products?.forEach(p => {
                catalogText += `🔹 Code: *${p.unique_code}* | ${p.name} (${p.weight}) - ₹${p.price}\n`;
            });
            catalogText += session.lang === "hi" ? "\n🛒 कृपया जो प्रोडक्ट खरीदना है उसका **Unique Code** लिखकर भेजें।" : "\n🛒 Please reply with the **Unique Code** of the product.";
            await sendWhatsAppMessage(from, catalogText);
        } else {
            await sendWhatsAppMessage(from, session.lang === "hi" ? "🔄 ओनर आपसे जल्द संपर्क करेंगे।" : "🔄 Owner will contact you soon.");
            delete sessions[from];
        }
        return;
    }

    // Match unique product code submitted by the customer
    if (session.step === "ENTER_CODE") {
        const { data: product } = await supabase.from('products').select('*').eq('owner_phone', session.targetOwner).eq('unique_code', msgText.toUpperCase()).single();
        if (product) {
            session.pendingOrder = product;
            session.step = "CONFIRM_ORDER";
            let confText = session.lang === "hi" ? 
                `🧐 *ऑर्डर की पुष्टि करें:*\n\n📦 नाम: ${product.name}\n⚖️ वजन: ${product.weight}\n💰 कीमत: ₹${product.price}\n\nटोटल अमाउंट: *₹${product.price}*\n\nऑर्डर फाइनल करने के लिए *YES* लिखें, कैंसिल के लिए *NO* लिखें.` :
                `🧐 *Confirm Order:*\n\n📦 Name: ${product.name}\n⚖️ Weight: ${product.weight}\n💰 Price: ₹${product.price}\n\nTotal: *₹${product.price}*\n\nReply *YES* to confirm, *NO* to cancel.`;
            await sendWhatsAppMessage(from, confText);
        } else {
            await sendWhatsAppMessage(from, "❌ Invalid Code!");
        }
        return;
    }

    // Save finalized order logs and send direct confirmation to customer & merchant
    if (session.step === "CONFIRM_ORDER") {
        if (msgText.toUpperCase() === "YES") {
            const item = session.pendingOrder;
            
            await supabase.from('orders').insert([{
                owner_phone: session.targetOwner,
                customer_phone: from,
                items: item,
                total_amount: item.price
            }]);

            await sendWhatsAppMessage(from, session.lang === "hi" ? "🎉 आपका ऑर्डर प्लेस हो गया है!" : "🎉 Order placed successfully!");
            
            const ownerAlert = `🚨 *New Order Received!* 🚨\n\n👤 Customer: +${from}\n📦 Product: ${item.name}\n💰 Price: ₹${item.price}\n\n📱 To look at all incoming orders, reply with *ORDERS*.`;
            await sendWhatsAppMessage(session.targetOwner, ownerAlert);
        }
        delete sessions[from];
        return;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Multi-Tenant Server running on port ${PORT}`));