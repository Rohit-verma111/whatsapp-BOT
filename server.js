require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
app.use(bodyParser.json());

// ----------------- CONFIGURATIONS -----------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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

// Function to download incoming media files from Meta servers
async function downloadWhatsAppMedia(mediaId, localPath) {
    try {
        const resUrl = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}` }
        });
        const downloadUrl = resUrl.data.url;
        const response = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            headers: { 'Authorization': `Bearer ${META_TOKEN}` }
        });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(localPath);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (err) {
        console.error("❌ Failed downloading media:", err.message);
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
    doc.fontSize(14).text("Product Catalog", { align: 'center' });
    doc.moveDown();

    productsList.forEach(p => {
        doc.fontSize(12).text(`Code: ${p.unique_code} | Name: ${p.name} | Weight: ${p.weight} | Price: INR ${p.price}`);
        doc.moveDown(0.5);
    });

    doc.end();
    stream.on('finish', () => callback(filePath, filename));
}

// ----------------- OWNER DASHBOARD WEB PAGE -----------------
app.get('/dashboard/:ownerPhone', async (req, res) => {
    const ownerPhone = req.params.ownerPhone;
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
            <td style="padding: 12px;">${new Date(o.created_at).toLocaleString('en-IN')}</td>
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

    // 🚨 DEBUG LINE: Logs every single incoming event from Meta
    console.log("📥 Raw Webhook Received:", JSON.stringify(body));

    if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const msgText = message.text?.body?.trim();
    const document = message.document; 

    // 🚨 SUPER BYPASS: सीधे तुम्हारा नंबर डिटेक्ट करके ओनर मान लेते हैं ताकि सुपबेस हैंग न हो
    let isOwner = (from === "919667805579"); 
    let checkStore = null;

    try {
        if (!isOwner) {
            const { data: storeData } = await supabase.from('stores').select('*').eq('owner_phone', from).single();
            checkStore = storeData;
            if (checkStore || (msgText && msgText.toUpperCase().startsWith("SHOP:"))) {
                isOwner = true;
            }
        } else {
            const { data: storeData } = await supabase.from('stores').select('*').eq('owner_phone', from).single();
            checkStore = storeData;
        }
    } catch (dbErr) {
        console.error("⚠️ Supabase Fetch Error (Bypassed):", dbErr.message);
    }

    if (!sessions[from]) sessions[from] = { step: "START" };
    const session = sessions[from];

    // ================= 🏪 MULTI-OWNER MERCHANT FLOW =================
    if (isOwner) {
        // Handle new shop registration command
        if (msgText && msgText.toUpperCase().startsWith("SHOP:")) {
            const shopName = msgText.split(":")[1].trim();
            await supabase.from('stores').upsert({ owner_phone: from, shop_name: shopName });
            session.step = "AWAITING_CATALOG";
            session.shopName = shopName;
            await sendWhatsAppMessage(from, `🏪 Your shop *"${shopName}"* has been registered!\n\n📊 *BULK UPLOAD ENABLED:* Please upload/send your product catalog Excel file (.xlsx) directly to this chat.\n\nMake sure the file columns match exactly: Unique Code, Product Name, Weight/Quantity, Price.`);
            return;
        }

        // Handle dashboard view link requested by merchant
        if (msgText && (msgText.toUpperCase() === "ORDERS" || msgText === "ऑर्डर")) {
            const dashboardLink = `https://${req.headers.host}/dashboard/${from}`;
            await sendWhatsAppMessage(from, `📋 To view all live incoming orders for your store, open this link on your phone:\n\n🔗 ${dashboardLink}`);
            return;
        }

        // Process document attachments (Excel sheet parser)
        if (document) {
            console.log("📄 Document received! Filename:", document.filename, "Mime:", document.mime_type);
            
            await sendWhatsAppMessage(from, "📥 Processing your Excel catalog, please wait...");
            
            const tempFilePath = path.join(__dirname, `bulk_${Date.now()}.xlsx`);
            await downloadWhatsAppMedia(document.id, tempFilePath);

            try {
                const workbook = XLSX.readFile(tempFilePath);
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                
                const rawData = XLSX.utils.sheet_to_json(worksheet, { range: 2 });
                console.log("📊 Raw Rows Extracted from Excel:", rawData.length);
                const parsedProducts = [];

                rawData.forEach(row => {
                    const uniqueCode = row['Unique Code'] || Object.values(row)[0];
                    const pName = row['Product Name'] || Object.values(row)[1];
                    const weight = row['Weight/Quantity'] || Object.values(row)[2];
                    const priceRaw = row['Price (₹)'] || Object.values(row)[3];
                    const price = parseFloat(String(priceRaw).replace(/[^0-9.]/g, ''));

                    if (uniqueCode && pName && !isNaN(price)) {
                        parsedProducts.push({
                            owner_phone: from,
                            unique_code: String(uniqueCode).trim().toUpperCase(),
                            name: String(pName).trim(),
                            weight: String(weight || "N/A").trim(),
                            price: price
                        });
                    }
                });

                if (parsedProducts.length === 0) {
                    await sendWhatsAppMessage(from, "❌ Excel parsing failed. Could not read data rows. Please use the exact template layout.");
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                    return;
                }

                // Delete older products
                await supabase.from('products').delete().eq('owner_phone', from);
                
                // Bulk Insert
                const { error: insertErr } = await supabase.from('products').insert(parsedProducts);
                if (insertErr) throw insertErr;

                const currentShopName = session.shopName || (checkStore ? checkStore.shop_name : "My Shop");
                generatePDF(currentShopName, parsedProducts, async (filePath, filename) => {
                    await sendWhatsAppMessage(from, `✅ *Bulk Upload Successful!*\n\n🚀 Loaded *${parsedProducts.length}* items into your live digital store.\n\nYou can text *ORDERS* at any time to monitor customer purchases.`);
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
                });

            } catch (excelErr) {
                console.error("❌ Detailed Excel Error:", excelErr.message);
                await sendWhatsAppMessage(from, `❌ System Error during processing: ${excelErr.message}`);
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            }
            return;
        }
        return;
    }

    // ================= 👤 CONSUMER END-USER FLOW =================
    if (session.step === "START") {
        session.step = "LANG_SELECT";
        await sendWhatsAppMessage(from, "👋 Welcome! Please select your language / कृपया अपनी भाषा चुनें:\n\n1. English\n2. Hindi (हिंदी)");
        return;
    }

    if (session.step === "LANG_SELECT") {
        session.lang = msgText === "2" ? "hi" : "en";
        session.step = "ENTER_OWNER_SHOP";
        const msg = session.lang === "hi" ? "🏪 कृपया उस दुकानदार का मोबाइल नंबर डालें जिससे आप सामान खरीदना चाहते हैं (बिना + के, जैसे: 919876543210):" : "🏪 Please enter the Shop Owner's mobile number you want to buy from (e.g., 919876543210):";
        await sendWhatsAppMessage(from, msg);
        return;
    }

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

    if (session.step === "MAIN_MENU") {
        if (msgText === "1") {
            session.step = "ENTER_CODE";
            const { data: products } = await supabase.from('products').select('*').eq('owner_phone', session.targetOwner);
            
            let catalogText = session.lang === "hi" ? "📋 उपलब्ध बीएसटीसी सूची:\n\n" : "📋 Available Products List:\n\n";
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

    if (session.step === "CONFIRM_ORDER") {
        if (msgText && msgText.toUpperCase() === "YES") {
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