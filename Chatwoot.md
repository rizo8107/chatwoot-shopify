Shopify Webhook → Our Server → Chatwoot Contact Search/Create → Create Conversation → Send WhatsApp Template

Below is a clean working version.

1. Create project
mkdir shopify-chatwoot-server
cd shopify-chatwoot-server
npm init -y
npm install express axios dotenv
2. Create .env
PORT=3000

CHATWOOT_BASE_URL=https://chat.stomatalfarms.com
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=1
CHATWOOT_API_ACCESS_TOKEN=YOUR_NEW_CHATWOOT_TOKEN

WHATSAPP_TEMPLATE_NAME=order_confirmation_01
WHATSAPP_TEMPLATE_LANGUAGE=en
3. Create server.js
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();

app.use(express.json({ limit: "5mb" }));

const {
  PORT,
  CHATWOOT_BASE_URL,
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_INBOX_ID,
  CHATWOOT_API_ACCESS_TOKEN,
  WHATSAPP_TEMPLATE_NAME,
  WHATSAPP_TEMPLATE_LANGUAGE,
} = process.env;

const chatwoot = axios.create({
  baseURL: `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`,
  headers: {
    api_access_token: CHATWOOT_API_ACCESS_TOKEN,
    "Content-Type": "application/json",
  },
});

function formatIndianPhone(rawPhone) {
  let cleanPhone = String(rawPhone || "").replace(/\D/g, "");

  if (!cleanPhone) return "";

  if (cleanPhone.startsWith("91") && cleanPhone.length === 12) {
    return `+${cleanPhone}`;
  }

  if (cleanPhone.startsWith("0") && cleanPhone.length === 11) {
    cleanPhone = "91" + cleanPhone.slice(1);
    return `+${cleanPhone}`;
  }

  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone;
    return `+${cleanPhone}`;
  }

  if (cleanPhone.startsWith("91") && cleanPhone.length > 12) {
    cleanPhone = cleanPhone.slice(0, 12);
    return `+${cleanPhone}`;
  }

  return `+${cleanPhone}`;
}

function extractOrderDetails(body) {
  const firstName =
    body.customer?.first_name ||
    body.billing_address?.first_name ||
    body.shipping_address?.first_name ||
    "";

  const lastName =
    body.customer?.last_name ||
    body.billing_address?.last_name ||
    body.shipping_address?.last_name ||
    "";

  const fullName = `${firstName} ${lastName}`.trim();

  const rawPhone =
    body.customer?.phone ||
    body.billing_address?.phone ||
    body.shipping_address?.phone ||
    "";

  const phone = formatIndianPhone(rawPhone);
  const sourceId = phone.replace(/\D/g, "");

  const email = body.customer?.email || body.email || "";

  const orderNumber = body.order_number || "";
  const orderName = body.name || `#${orderNumber}`;
  const totalPrice = body.total_price || "0.00";

  const createdAt = body.created_at || new Date().toISOString();

  const orderDate = new Date(createdAt).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const itemsSummary =
    (body.line_items || [])
      .map((item) => `${item.name} x${item.quantity} @ Rs.${item.price}`)
      .join(", ") || "N/A";

  const shippingCity = body.shipping_address?.city || "";
  const orderStatusUrl = body.order_status_url || "";

  return {
    firstName,
    lastName,
    fullName: fullName || phone,
    phone,
    sourceId,
    email,
    orderNumber: String(orderNumber),
    orderName,
    totalPrice,
    orderDate,
    itemsSummary,
    shippingCity,
    orderStatusUrl,
  };
}

async function searchContact(phone) {
  const response = await chatwoot.get("/contacts/search", {
    params: {
      q: phone,
    },
  });

  const contacts = response.data?.payload || [];

  if (contacts.length > 0) {
    return contacts[0];
  }

  return null;
}

async function createContact(order) {
  const payload = {
    inbox_id: Number(CHATWOOT_INBOX_ID),
    name: order.fullName || order.phone,
    phone_number: order.phone,
  };

  if (order.email && order.email.includes("@")) {
    payload.email = order.email;
  }

  const response = await chatwoot.post("/contacts", payload);

  return response.data?.payload || response.data;
}

async function getOrCreateContact(order) {
  const existingContact = await searchContact(order.phone);

  if (existingContact) {
    return existingContact;
  }

  return await createContact(order);
}

async function createConversation(contact, order) {
  const response = await chatwoot.post("/conversations", {
    contact_id: contact.id,
    inbox_id: Number(CHATWOOT_INBOX_ID),
    source_id: order.sourceId,
    status: "open",
  });

  return response.data;
}

async function sendWhatsAppTemplate(conversationId, order) {
  const message = `Hi ${order.fullName}, Thank you for your purchase from Stomatal Farms! Your order ${order.orderName} is now being prepared. View your order details here: ${order.orderStatusUrl}`;

  const response = await chatwoot.post(
    `/conversations/${conversationId}/messages`,
    {
      message_type: "outgoing",
      content: message,
      template_params: {
        name: WHATSAPP_TEMPLATE_NAME,
        category: "UTILITY",
        language: WHATSAPP_TEMPLATE_LANGUAGE || "en",
        processed_params: {
          body: {
            1: order.fullName,
            2: order.orderName,
            3: order.orderStatusUrl,
          },
        },
      },
    }
  );

  return response.data;
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Shopify to Chatwoot server is running",
  });
});

app.post("/webhook/shopify-order", async (req, res) => {
  try {
    const order = extractOrderDetails(req.body);

    console.log("Order extracted:", order);

    if (!order.phone || !order.phone.startsWith("+")) {
      return res.status(400).json({
        success: false,
        error: "Invalid phone number",
        phone: order.phone,
      });
    }

    const contact = await getOrCreateContact(order);

    console.log("Contact:", contact);

    const conversation = await createConversation(contact, order);

    console.log("Conversation:", conversation);

    const conversationId = conversation.id || conversation.payload?.id;

    if (!conversationId) {
      return res.status(500).json({
        success: false,
        error: "Conversation ID not found",
        conversation,
      });
    }

    const message = await sendWhatsAppTemplate(conversationId, order);

    return res.json({
      success: true,
      order,
      contact_id: contact.id,
      conversation_id: conversationId,
      message,
    });
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

app.listen(PORT || 3000, () => {
  console.log(`Server running on port ${PORT || 3000}`);
});
4. Run server
node server.js

Test in browser:

http://localhost:3000

You should see:

{
  "success": true,
  "message": "Shopify to Chatwoot server is running"
}
5. Shopify webhook URL

If deployed, your Shopify webhook URL will be:

https://your-domain.com/webhook/shopify-order

Use this for Shopify:

Order creation webhook
POST
JSON
