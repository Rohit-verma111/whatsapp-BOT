require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.json());

// Initialize Supabase and Meta Cloud API credentials securely
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;

// Function to send WhatsApp messages using Meta Cloud API
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

// 1. Meta Webhook Verification Endpoint
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 2. Main Chatbot Logic Webhook Endpoint
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        
        // Validate the incoming WhatsApp message structure
        if (!body.object || !body.entry?.[0]?.changes?.[0]?.value?.messages) {
            return res.sendStatus(200);
        }

        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from; 
        const msgText = message.text ? message.text.body.trim().toLowerCase() : "";

        console.log(`Received message from ${from}: ${msgText}`);

        // --- Bot Flow Handling ---
        
        // Step 1: Greeting and Language Selection
        if (msgText === 'hi' || msgText === 'hello' || msgText === 'start') {
            await sendWhatsAppMessage(from, "👋 नमस्ते / Hello!\n\nPlease select your language:\n1. English\n2. Hindi");
            return res.sendStatus(200);
        }

        // Step 2: Main Menu Option Configuration
        if (msgText === '1' || msgText === '2' || msgText === 'english' || msgText === 'hindi') {
            await sendWhatsAppMessage(from, "📋 *Main Menu:*\n\nType *BUY* to purchase products.\nType *RETURN* for return & exchange options.");
            return res.sendStatus(200);
        }

        // Step 3: Fetch Products from Supabase and show List
        if (msgText === 'buy') {
            const { data: products, error } = await supabase.from('products').select('*');
            if (error || !products) throw new Error("Failed to fetch products from database");

            let list = "🛒 *Store Items:*\n\n";
            products.forEach(p => {
                list += `🆔 Serial No: *${p.id}*\n📦 ${p.product_name}\n💰 Price: ₹${p.price}\n\n`;
            });
            list += "To buy items, please reply with their Serial Numbers separated by commas. Example: 1, 3";
            await sendWhatsAppMessage(from, list);
            return res.sendStatus(200);
        }

        // Step 4: Process comma-separated Serial Numbers and Calculate Bill
        if (msgText.includes(',')) {
            const serials = msgText.split(',').map(num => parseInt(num.trim())).filter(Boolean);
            const { data: products, error } = await supabase.from('products').select('*').in('id', serials);

            if (error || !products || products.length === 0) {
                await sendWhatsAppMessage(from, "❌ Invalid Serial Numbers. Please try again with correct numbers.");
                return res.sendStatus(200);
            }

            let total = 0;
            let summary = "📝 *Your Order Summary:* \n\n";
            products.forEach(p => {
                summary += `• ${p.product_name} - ₹${p.price}\n`;
                total += parseFloat(p.price);
            });
            summary += `\n*Total Amount: ₹${total}*\n\nType *YES* to confirm and book your order.`;
            await sendWhatsAppMessage(from, summary);
            return res.sendStatus(200);
        }

        // Step 5: Final Order Booking Confirmation
        if (msgText === 'yes') {
            await sendWhatsAppMessage(from, "🎉 Your order has been confirmed successfully! The shop owner has been notified.");
            return res.sendStatus(200);
        }

        // Default Fallback Response
        await sendWhatsAppMessage(from, "❌ Command not recognized. Type *START* to go back to the Main Menu.");
        res.sendStatus(200);

    } catch (error) {
        // Global Error Handling to keep server running smoothly
        console.error("🚨 Critical Exception Handled:", error.message);
        res.sendStatus(500); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Bot Server is running on port ${PORT}...`));