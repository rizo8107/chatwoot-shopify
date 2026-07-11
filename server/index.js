import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  isValidShop, normalizeShop, buildInstallUrl, verifyHmac,
  exchangeToken, registerWebhooks, fetchAbandonedCheckouts
} from './shopify.js';

import { fetchChatwootContacts, importContacts } from './contacts.js';

import {
  authConfigured, signInWithPassword, sendResetPasswordEmail, resetPasswordWithCode,
  createToken, currentUser, sessionCookie
} from './auth.js';

import {
  initDb,
  logTransaction,
  getTransactions,
  getTransactionById,
  getMetrics,
  getAllSettings,
  saveSettings,
  saveFlow,
  getFlows,
  getFlowById,
  deleteFlow,
  toggleFlow,
  getFlowsByTrigger,
  scheduleJob,
  createCampaign,
  getCampaigns,
  getCampaignById,
  deleteCampaign,
  startCampaign,
  pauseCampaign,
  retryFailedRecipients,
  retryRecipient,
  scheduleWebhookRetry,
  saveAbandonedCart,
  getAbandonedCarts,
  getAbandonedCartById,
  updateAbandonedCartStatus,
  getAbandonedCartStats,
  saveAbandonedCartFlow,
  getAbandonedCartFlows,
  getAbandonedCartFlowById,
  deleteAbandonedCartFlow,
  toggleAbandonedCartFlow,
  setTransactionChatwootMessageId,
  updateDeliveryStatusByMessageId
} from './db.js';

import {
  executePipeline,
  extractOrderDetails,
  extractFulfillmentDetails,
  extractCheckoutDetails,
  executeFlow,
  normalizePhone
} from './chatwoot.js';

import { startScheduler } from './scheduler.js';
import { scheduleRecoveryForCart, cancelRecoveryForOrder } from './recovery.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// ─── Auth gate ──────────────────────────────────────────────────────────────
// Protects all /api routes except: auth endpoints, the Shopify webhook, and the
// Shopify OAuth callback (machine-called, secured by HMAC). Credentials are
// verified against InsForge Auth (server/auth.js); this app issues its own
// short-lived session cookie afterward so per-request checks stay local.
const PUBLIC_API = new Set([
  '/api/auth/login', '/api/auth/logout', '/api/auth/me',
  '/api/auth/forgot-password', '/api/auth/reset-password',
  '/api/webhook/shopify', '/api/shopify/auth/callback', '/api/webhook/chatwoot'
]);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();     // SPA + static assets
  if (!authConfigured()) return next();                // auth disabled
  if (PUBLIC_API.has(req.path)) return next();         // allowlisted
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const result = await signInWithPassword(email, password);
    if (!result.ok) return res.status(result.status === 403 ? 403 : 401).json({ error: result.message });
    res.setHeader('Set-Cookie', sessionCookie(createToken(email)));
    res.json({ success: true, email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie('', true));
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  res.json({ authRequired: authConfigured(), authenticated: !!user, email: user?.email || null });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    await sendResetPasswordEmail(email);
    // Always report success — don't reveal whether the email exists.
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Email, code, and new password are required' });
    const result = await resetPasswordWithCode(email, code, newPassword);
    if (!result.ok) return res.status(400).json({ error: result.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function genId(prefix = 'tx') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Queue a failed webhook/flow execution for automatic retry (first attempt in 1 min).
async function queueRetry(transactionId, rawBody, topic, flowId) {
  try {
    const settings = await getAllSettings();
    const max = parseInt(settings.WEBHOOK_MAX_RETRIES ?? '3', 10);
    if (!max || max <= 0) return;
    await scheduleWebhookRetry({
      transaction_id: transactionId, payload: rawBody, topic,
      flow_id: flowId || null, run_at: new Date(Date.now() + 60_000).toISOString(), max_attempts: max
    });
    console.log(`[Webhook] Queued auto-retry for ${transactionId} (max ${max})`);
  } catch (err) {
    console.error('[Webhook] Failed to queue retry:', err.message);
  }
}

// ─── Metrics ──────────────────────────────────────────────────────────────

app.get('/api/metrics', async (req, res) => {
  try { res.json(await getMetrics()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Transactions ─────────────────────────────────────────────────────────

app.get('/api/transactions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const status = req.query.status || null;
    res.json(await getTransactions(limit, offset, status));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transactions/:id', async (req, res) => {
  try {
    const item = await getTransactionById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Transaction not found' });
    res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Retry a failed message from the Logs view.
//  • campaign messages  → requeue the recipient
//  • webhook/flow/test  → re-run from the original payload stored in the steps
app.post('/api/transactions/:id/retry', async (req, res) => {
  try {
    const id = req.params.id;

    if (id.startsWith('cmp_')) {
      await retryRecipient(id.slice('cmp_'.length));
      return res.json({ success: true });
    }

    const tx = await getTransactionById(id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    const steps = Array.isArray(tx.steps) ? tx.steps : [];
    const extract = steps.find(s => s.name === 'Extract Details');
    const rawBody = extract?.request?.body;
    const topic = extract?.request?.topic || 'orders/create';

    if (rawBody) {
      const result = await executePipeline(rawBody, topic);
      await logTransaction({
        id, flow_id: tx.flow_id || null,
        order_number: tx.order_number, customer_name: tx.customer_name, phone_number: tx.phone_number,
        status: result.status, type: tx.type || 'webhook', steps: result.steps, error_message: result.errorMessage || null
      });
      if (result.chatwootMessageId) await setTransactionChatwootMessageId(id, result.chatwootMessageId);
      return res.json({ success: result.status === 'success', status: result.status, error: result.errorMessage, skipped: result.skipped || false });
    }

    return res.status(400).json({ error: 'No stored payload to retry this message. Re-send it from the Test Console.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings ─────────────────────────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  try { res.json(await getAllSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', async (req, res) => {
  try { await saveSettings(req.body); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Abandoned Carts ──────────────────────────────────────────────────────

app.get('/api/abandoned-carts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const status = req.query.status || 'abandoned';
    const carts = await getAbandonedCarts(limit, offset, status);
    res.json({ carts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/abandoned-carts/stats', async (req, res) => {
  try {
    const stats = await getAbandonedCartStats();
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/abandoned-carts/:id', async (req, res) => {
  try {
    const cart = await getAbandonedCartById(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    res.json(cart);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/abandoned-carts/:id/recover', async (req, res) => {
  try {
    await updateAbandonedCartStatus(req.params.id, 'recovered', new Date().toISOString());
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pull existing abandoned checkouts from Shopify's Admin API into our DB.
// Needed because webhooks only capture NEW checkouts created after the app
// connected — this backfills checkouts that already existed in Shopify.
app.post('/api/abandoned-carts/sync', async (req, res) => {
  try {
    const s = await getAllSettings();
    const shop = normalizeShop(s.SHOPIFY_STORE_URL);
    if (!shop || !s.SHOPIFY_ADMIN_TOKEN) {
      return res.status(400).json({ error: 'Shopify not connected. Connect a store in Settings first.' });
    }
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 250);
    const checkouts = await fetchAbandonedCheckouts({ shop, token: s.SHOPIFY_ADMIN_TOKEN, limit });

    let imported = 0;
    for (const checkout of checkouts) {
      // Skip checkouts that were actually completed (not abandoned)
      if (checkout.completed_at) continue;

      const cartItems = (checkout.line_items || []).map(item => ({
        id: item.id,
        title: item.title,
        quantity: item.quantity,
        price: item.price
      }));

      // Same extractor used for the live webhook — its fallback chain covers
      // customer, billing_address, and shipping_address so phone/email/name
      // aren't lost when Shopify only populated one of those sub-objects.
      const details = extractCheckoutDetails(checkout);

      await saveAbandonedCart({
        id: `cart_shopify_${checkout.token || checkout.id}`,
        checkout_token: String(checkout.token || checkout.id),
        customer_name: details.fullName || '',
        customer_email: details.email || '',
        customer_phone: details.phone || '',
        cart_items: cartItems,
        cart_total_price: checkout.total_price || checkout.total_line_items_price || '0',
        abandoned_at: checkout.created_at || new Date().toISOString(),
        shopify_checkout_url: checkout.abandoned_checkout_url || ''
      });
      imported++;
    }

    res.json({ success: true, imported, total: checkouts.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Abandoned Cart Recovery Flows ────────────────────────────────────────

app.get('/api/abandoned-cart-flows', async (req, res) => {
  try {
    const flows = await getAbandonedCartFlows();
    res.json(flows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/abandoned-cart-flows/:id', async (req, res) => {
  try {
    const flow = await getAbandonedCartFlowById(req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    res.json(flow);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/abandoned-cart-flows', async (req, res) => {
  try {
    const { id, name, description, is_active, messages } = req.body;
    const flowId = id || genId('acf');
    await saveAbandonedCartFlow({ id: flowId, name, description, is_active: is_active !== false, messages: messages || [] });
    res.json({ success: true, id: flowId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/abandoned-cart-flows/:id', async (req, res) => {
  try {
    const { name, description, is_active, messages } = req.body;
    await saveAbandonedCartFlow({ id: req.params.id, name, description, is_active: is_active !== false, messages: messages || [] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/abandoned-cart-flows/:id', async (req, res) => {
  try {
    await deleteAbandonedCartFlow(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/abandoned-cart-flows/:id/toggle', async (req, res) => {
  try {
    const { is_active } = req.body;
    await toggleAbandonedCartFlow(req.params.id, is_active);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Flows CRUD ───────────────────────────────────────────────────────────

app.get('/api/flows', async (req, res) => {
  try { res.json(await getFlows()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/flows/:id', async (req, res) => {
  try {
    const flow = await getFlowById(req.params.id);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    res.json(flow);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/flows', async (req, res) => {
  try {
    const { id, name, description, trigger_event, nodes, edges, is_active } = req.body;
    const flowId = id || genId('flow');
    await saveFlow({ id: flowId, name, description, trigger_event, nodes: nodes || [], edges: edges || [], is_active: is_active !== false });
    res.json({ success: true, id: flowId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/flows/:id', async (req, res) => {
  try { await deleteFlow(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/flows/:id/toggle', async (req, res) => {
  try {
    const { is_active } = req.body;
    await toggleFlow(req.params.id, is_active);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Webhook Info ─────────────────────────────────────────────────────────

app.get('/api/webhook/info', (req, res) => {
  const baseUrl = process.env.WEBHOOK_BASE_URL || `http://localhost:${PORT}`;
  res.json({
    webhookUrl: `${baseUrl}/api/webhook/shopify`,
    supportedEvents: [
      { event: 'checkouts/create', label: 'Checkout Created (Abandoned Cart)', description: 'Fires when a customer starts but does not complete a checkout' },
      { event: 'checkouts/update', label: 'Checkout Updated', description: 'Fires when a checkout is updated' },
      { event: 'orders/create', label: 'Order Created', description: 'Fires when a new order is placed' },
      { event: 'orders/paid', label: 'Order Paid', description: 'Fires when an order is marked as paid' },
      { event: 'fulfillments/create', label: 'Fulfillment Created (Order Shipped)', description: 'Fires when an order is fulfilled/shipped' }
    ]
  });
});

// ─── Chatwoot Webhook Registration (Delivery Reports) ─────────────────────

// Chatwoot's webhooks list response is nested as { payload: { webhooks: [...] } }.
function extractWebhookList(resBody) {
  if (Array.isArray(resBody)) return resBody;
  if (Array.isArray(resBody?.payload)) return resBody.payload;
  if (Array.isArray(resBody?.payload?.webhooks)) return resBody.payload.webhooks;
  if (Array.isArray(resBody?.webhooks)) return resBody.webhooks;
  return [];
}

// Register an account-level webhook in Chatwoot so it POSTs message status
// changes (sent/delivered/read/failed) back to our /api/webhook/chatwoot receiver.
app.post('/api/chatwoot/webhook/register', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
    const token = settings.CHATWOOT_API_TOKEN;
    const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
    if (!apiBaseUrl || !token) return res.status(400).json({ error: 'Chatwoot API not configured in Settings' });

    const webhookUrl = `${appBaseUrl(req, settings)}/api/webhook/chatwoot`;
    const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/webhooks`;
    const body = { webhook: { url: webhookUrl, subscriptions: ['message_created', 'message_updated', 'conversation_status_changed'] } };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(body) });
    const resBody = await r.json();

    // Chatwoot enforces a unique URL per webhook — treat "already registered" as success.
    if (!r.ok) {
      const alreadyExists = r.status === 422 && JSON.stringify(resBody).includes('has already been taken');
      if (!alreadyExists) return res.status(r.status).json({ error: `Chatwoot error ${r.status}`, detail: resBody });
    }
    res.json({ success: true, webhookUrl, webhook: resBody });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check whether our delivery-report webhook is already registered in Chatwoot.
app.get('/api/chatwoot/webhook/status', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
    const token = settings.CHATWOOT_API_TOKEN;
    const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
    const webhookUrl = `${appBaseUrl(req, settings)}/api/webhook/chatwoot`;
    if (!apiBaseUrl || !token) return res.json({ registered: false, webhookUrl });

    const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/webhooks`;
    const r = await fetch(url, { headers: { api_access_token: token } });
    const resBody = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: `Chatwoot error ${r.status}`, detail: resBody });
    const list = extractWebhookList(resBody);
    const found = list.find(w => w.url === webhookUrl);
    res.json({ registered: !!found, webhookUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Shopify Proxy ────────────────────────────────────────────────────────

app.get('/api/shopify/checkout/:token', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const storeUrl = (settings.SHOPIFY_STORE_URL || '').replace(/\/$/, '');
    const adminToken = settings.SHOPIFY_ADMIN_TOKEN;

    if (!storeUrl || !adminToken) {
      return res.status(400).json({ error: 'Shopify Admin API not configured. Add SHOPIFY_STORE_URL and SHOPIFY_ADMIN_TOKEN in Settings.' });
    }

    const url = `https://${storeUrl}/admin/api/2024-01/checkouts/${req.params.token}.json`;
    const shopifyRes = await fetch(url, { headers: { 'X-Shopify-Access-Token': adminToken } });
    const body = await shopifyRes.json();

    if (!shopifyRes.ok) return res.status(shopifyRes.status).json({ error: `Shopify error: ${shopifyRes.status}`, detail: body });
    res.json(body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Shopify OAuth (Connect store → Admin API token) ──────────────────────

// Short-lived CSRF state store for the OAuth round-trip (single instance).
const oauthStates = new Map();
function rememberState(state, shop) {
  oauthStates.set(state, { shop, exp: Date.now() + 10 * 60_000 });
}
function consumeState(state) {
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.exp < Date.now()) return null;
  return entry;
}

function appBaseUrl(req, settings) {
  return (settings.SHOPIFY_APP_URL || process.env.WEBHOOK_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Connection status for the Settings UI
app.get('/api/shopify/status', async (req, res) => {
  try {
    const s = await getAllSettings();
    res.json({
      connected: !!(s.SHOPIFY_STORE_URL && s.SHOPIFY_ADMIN_TOKEN),
      shop: s.SHOPIFY_STORE_URL || '',
      scopes: s.SHOPIFY_SCOPES || '',
      hasCredentials: !!(s.SHOPIFY_API_KEY && s.SHOPIFY_API_SECRET)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 1: begin OAuth — redirect the merchant to Shopify's consent screen
app.get('/api/shopify/auth', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const shop = normalizeShop(req.query.shop || settings.SHOPIFY_STORE_URL);
    const apiKey = settings.SHOPIFY_API_KEY;
    const scopes = settings.SHOPIFY_SCOPES || 'read_orders,read_checkouts,read_fulfillments';

    if (!apiKey || !settings.SHOPIFY_API_SECRET) {
      return res.status(400).send('Shopify API key/secret not set. Add them in Settings first.');
    }
    if (!isValidShop(shop)) {
      return res.status(400).send('Invalid shop domain. Expected something like your-store.myshopify.com');
    }

    const state = crypto.randomBytes(16).toString('hex');
    rememberState(state, shop);
    const redirectUri = `${appBaseUrl(req, settings)}/api/shopify/auth/callback`;
    res.redirect(buildInstallUrl({ shop, apiKey, scopes, redirectUri, state }));
  } catch (err) { res.status(500).send(`OAuth start failed: ${err.message}`); }
});

// Step 2: OAuth callback — verify, exchange code for token, store it, register webhooks
app.get('/api/shopify/auth/callback', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const { shop, code, state } = req.query;

    if (!verifyHmac(req.query, settings.SHOPIFY_API_SECRET)) {
      return res.status(401).send('HMAC validation failed.');
    }
    const remembered = consumeState(state);
    if (!remembered || remembered.shop !== shop) {
      return res.status(403).send('Invalid or expired OAuth state.');
    }
    if (!isValidShop(shop) || !code) {
      return res.status(400).send('Invalid OAuth callback parameters.');
    }

    const { accessToken, scope } = await exchangeToken({
      shop, apiKey: settings.SHOPIFY_API_KEY, apiSecret: settings.SHOPIFY_API_SECRET, code
    });

    await saveSettings({ SHOPIFY_STORE_URL: shop, SHOPIFY_ADMIN_TOKEN: accessToken, SHOPIFY_SCOPES: scope });

    // Best-effort webhook registration (don't fail the connect if this errors)
    let webhooks = [];
    try { webhooks = await registerWebhooks({ shop, token: accessToken, appUrl: appBaseUrl(req, settings) }); }
    catch (e) { console.error('[Shopify] Webhook registration error:', e.message); }
    console.log(`[Shopify] Connected ${shop} — webhooks:`, webhooks.map(w => `${w.topic}:${w.ok ? 'ok' : 'fail'}`).join(', '));

    res.redirect('/?shopify=connected');
  } catch (err) {
    console.error('[Shopify] OAuth callback failed:', err.message);
    res.status(500).send(`Shopify connect failed: ${err.message}`);
  }
});

// Disconnect — clear the stored token
app.post('/api/shopify/disconnect', async (req, res) => {
  try {
    await saveSettings({ SHOPIFY_ADMIN_TOKEN: '' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read abandoned checkouts via the connected store's Admin API
app.get('/api/shopify/abandoned-checkouts', async (req, res) => {
  try {
    const s = await getAllSettings();
    const shop = normalizeShop(s.SHOPIFY_STORE_URL);
    if (!shop || !s.SHOPIFY_ADMIN_TOKEN) {
      return res.status(400).json({ error: 'Shopify not connected. Connect a store in Settings first.' });
    }
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 250);
    const checkouts = await fetchAbandonedCheckouts({ shop, token: s.SHOPIFY_ADMIN_TOKEN, limit });
    res.json({ count: checkouts.length, checkouts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Chatwoot Contacts (segmentation + import) ────────────────────────────

// Fetch contacts from Chatwoot for segmentation (client applies filters)
app.get('/api/chatwoot/contacts', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const contacts = await fetchChatwootContacts({ settings, maxPages: req.query.maxPages || 20 });
    res.json({ count: contacts.length, contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk-create contacts in Chatwoot from CSV rows [{ name, phone, email }]
app.post('/api/chatwoot/contacts/import', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ error: 'No contact rows provided' });
    const settings = await getAllSettings();
    const result = await importContacts({ settings, rows });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Webhook Handler (Shopify → Flow Engine) ─────────────────────────────

function parseWebhookPayload(req) {
  let rawBody = req.body;
  let topic = req.headers['x-shopify-topic'] || '';

  if (Array.isArray(req.body) && req.body[0]) {
    rawBody = req.body[0].body || req.body[0];
    if (req.body[0].headers) topic = req.body[0].headers['x-shopify-topic'] || topic;
  } else if (req.body && req.body.body) {
    rawBody = req.body.body;
    if (req.body.headers) topic = req.body.headers['x-shopify-topic'] || topic;
  }

  // Auto-detect from payload shape if topic not set
  if (!topic) {
    if (rawBody && (rawBody.destination || rawBody.tracking_number)) topic = 'fulfillments/create';
    else if (rawBody && (rawBody.abandoned_checkout_url || rawBody.token) && !rawBody.order_number) topic = 'checkouts/create';
    else topic = 'orders/create';
  }

  const isCheckout = topic.startsWith('checkouts/');
  const isFulfillment = topic.startsWith('fulfillments/');

  const details = isCheckout
    ? extractCheckoutDetails(rawBody)
    : isFulfillment
      ? extractFulfillmentDetails(rawBody)
      : extractOrderDetails(rawBody);

  return { rawBody, topic, details };
}

app.post('/api/webhook/shopify', async (req, res) => {
  const transactionId = genId('tx');

  let rawBody, topic, details;
  try {
    ({ rawBody, topic, details } = parseWebhookPayload(req));
  } catch (err) {
    return res.status(400).json({ success: false, error: `Payload parse error: ${err.message}` });
  }

  // Respond immediately to Shopify
  res.status(202).json({ success: true, id: transactionId, message: 'Processing in background' });

  // Track abandoned carts (if enabled). checkouts/create fires the instant a
  // checkout session starts — often before the customer has typed in their
  // name/email/phone — so also listen for checkouts/update, which fires as
  // Shopify learns more, and let the upsert in saveAbandonedCart fill gaps
  // without ever blanking out data already captured.
  if ((topic === 'checkouts/create' || topic === 'checkouts/update') && rawBody) {
    try {
      const settings = await getAllSettings();
      const trackingEnabled = settings.ABANDONED_CARTS_ENABLED !== '0';
      if (trackingEnabled) {
        const cartId = genId('cart');
        const cartToken = rawBody.token || rawBody.id;
        const cartItems = (rawBody.line_items || []).map(item => ({
          id: item.id,
          title: item.title,
          quantity: item.quantity,
          price: item.price
        }));
        await saveAbandonedCart({
          id: cartId,
          checkout_token: cartToken,
          customer_name: details.fullName || '',
          customer_email: details.email || '',
          customer_phone: details.phone || '',
          cart_items: cartItems,
          cart_total_price: rawBody.total_price || rawBody.total_line_items_price || '0',
          abandoned_at: new Date().toISOString(),
          shopify_checkout_url: rawBody.abandoned_checkout_url || rawBody.checkout_url || ''
        });
        console.log(`[Webhook] Tracked abandoned cart (${topic}): ${cartId}`);

        // Kick off the Recovery Flow schedule for this cart. Idempotent —
        // repeated create/update webhooks can't double-schedule a message.
        scheduleRecoveryForCart(cartToken).catch(err =>
          console.error('[Recovery] Scheduling failed:', err.message));
      }
    } catch (err) {
      console.error('[Webhook] Failed to track abandoned cart:', err.message);
    }
  }

  // Customer completed this checkout — mark the cart recovered and cancel any
  // pending recovery follow-ups so buyers never get "you left items" messages.
  if (topic.startsWith('orders/') && rawBody?.checkout_token) {
    cancelRecoveryForOrder(rawBody.checkout_token).catch(err =>
      console.error('[Recovery] Cancel-on-order failed:', err.message));
  }

  // Find matching active flows
  const matchingFlows = await getFlowsByTrigger(topic).catch(() => []);

  if (matchingFlows.length > 0) {
    // Execute each matching flow
    for (const flow of matchingFlows) {
      const flowTxId = genId('tx');
      await logTransaction({
        id: flowTxId, flow_id: flow.id,
        order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
        status: 'processing', type: 'flow', steps: [], error_message: null
      });

      executeFlow(flow, { ...details })
        .then(async (result) => {
          if (result.status === 'delayed') {
            // Schedule the next step
            const runAt = new Date(Date.now() + result.delayMs).toISOString();
            const jobId = genId('job');
            await scheduleJob({ id: jobId, flow_id: flow.id, transaction_id: flowTxId, node_id: result.nextNodeId, context: result.context || details, run_at: runAt });
            await logTransaction({
              id: flowTxId, flow_id: flow.id,
              order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
              status: 'processing', type: 'flow', steps: result.steps, error_message: null
            });
            console.log(`[Webhook] Flow ${flow.id}: delayed, next job at ${runAt}`);
          } else {
            await logTransaction({
              id: flowTxId, flow_id: flow.id,
              order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
              status: result.status, type: 'flow', steps: result.steps, error_message: result.errorMessage || null
            });
            if (result.chatwootMessageId) await setTransactionChatwootMessageId(flowTxId, result.chatwootMessageId);
            console.log(`[Webhook] Flow ${flow.id}: ${result.status}`);
            if (result.status === 'failed') await queueRetry(flowTxId, rawBody, topic, flow.id);
          }
        })
        .catch(async (err) => {
          console.error(`[Webhook] Flow ${flow.id} unhandled error:`, err.message);
          await logTransaction({
            id: flowTxId, flow_id: flow.id,
            order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
            status: 'failed', type: 'flow', steps: [], error_message: err.message
          });
          await queueRetry(flowTxId, rawBody, topic, flow.id);
        });
    }
  } else {
    // No flows — fall back to legacy pipeline
    await logTransaction({
      id: transactionId, flow_id: null,
      order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
      status: 'processing', type: 'webhook', steps: [], error_message: null
    });

    executePipeline(rawBody, topic)
      .then(async (result) => {
        await logTransaction({
          id: transactionId, flow_id: null,
          order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
          status: result.status, type: 'webhook', steps: result.steps, error_message: result.errorMessage || null
        });
        if (result.chatwootMessageId) await setTransactionChatwootMessageId(transactionId, result.chatwootMessageId);
        if (result.status === 'failed') await queueRetry(transactionId, rawBody, topic, null);
      })
      .catch(async (err) => {
        await logTransaction({
          id: transactionId, flow_id: null,
          order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
          status: 'failed', type: 'webhook', steps: [], error_message: err.message
        });
        await queueRetry(transactionId, rawBody, topic, null);
      });
  }
});

// ─── Chatwoot Webhook (Delivery Reports) ──────────────────────────────────
// Chatwoot calls this when a message's WhatsApp delivery status changes
// (sent → delivered → read, or failed). Registered via /api/chatwoot/webhook/register.
app.post('/api/webhook/chatwoot', async (req, res) => {
  try {
    const body = req.body || {};
    const messageId = body.id;
    // Chatwoot sends the WhatsApp-reported status on message_updated events;
    // fall back to conversation_status_changed payloads being no-ops here.
    const status = body.status;
    if (messageId && ['sent', 'delivered', 'read', 'failed'].includes(status)) {
      await updateDeliveryStatusByMessageId(messageId, status);
    }
    res.status(200).json({ success: true });
  } catch (err) {
    // Always 200 — a non-2xx response makes Chatwoot retry-storm the webhook.
    console.error('[Chatwoot Webhook] error:', err.message);
    res.status(200).json({ success: false, error: err.message });
  }
});

// ─── Test Flow (Sync) ─────────────────────────────────────────────────────

app.post('/api/test-flow', async (req, res) => {
  const transactionId = genId('test');
  let rawBody, topic, details;
  try {
    ({ rawBody, topic, details } = parseWebhookPayload(req));
  } catch (err) {
    return res.status(400).json({ success: false, error: `Payload parse error: ${err.message}` });
  }

  await logTransaction({ id: transactionId, order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone, status: 'processing', type: 'test', steps: [], error_message: null });

  try {
    const result = await executePipeline(rawBody, topic);
    await logTransaction({ id: transactionId, order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone, status: result.status, type: 'test', steps: result.steps, error_message: result.errorMessage || null });
    res.json({ success: result.status === 'success', id: transactionId, ...result });
  } catch (err) {
    await logTransaction({ id: transactionId, order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone, status: 'failed', type: 'test', steps: [], error_message: err.message });
    res.status(500).json({ success: false, id: transactionId, error: err.message });
  }
});

// ─── Test Specific Flow (Sync) ────────────────────────────────────────────

app.post('/api/test-flow/:flowId', async (req, res) => {
  const { flowId } = req.params;
  const transactionId = genId('test');
  let rawBody, topic, details;
  try {
    ({ rawBody, topic, details } = parseWebhookPayload(req));
  } catch (err) {
    return res.status(400).json({ success: false, error: `Payload parse error: ${err.message}` });
  }

  const flow = await getFlowById(flowId);
  if (!flow) return res.status(404).json({ error: 'Flow not found' });

  await logTransaction({ id: transactionId, flow_id: flowId, order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone, status: 'processing', type: 'test', steps: [], error_message: null });

  try {
    const result = await executeFlow(flow, { ...details });
    await logTransaction({ id: transactionId, flow_id: flowId, order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone, status: result.status === 'delayed' ? 'processing' : result.status, type: 'test', steps: result.steps, error_message: result.errorMessage || null });
    res.json({ success: true, id: transactionId, note: result.status === 'delayed' ? 'Flow paused at a Delay node (not scheduled in test mode)' : undefined, ...result });
  } catch (err) {
    await logTransaction({ id: transactionId, flow_id: flowId, order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone, status: 'failed', type: 'test', steps: [], error_message: err.message });
    res.status(500).json({ success: false, id: transactionId, error: err.message });
  }
});

// ─── WhatsApp Templates (from Chatwoot inbox) ─────────────────────────────

app.get('/api/whatsapp/templates', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
    const token = settings.CHATWOOT_API_TOKEN;
    const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
    const inboxId = settings.CHATWOOT_INBOX_ID || '1';
    if (!apiBaseUrl || !token) return res.status(400).json({ error: 'Chatwoot API not configured in Settings' });

    const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/inboxes/${inboxId}`;
    const r = await fetch(url, { headers: { api_access_token: token } });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: `Chatwoot error ${r.status}`, detail: body });

    const raw = body.message_templates || body.payload?.message_templates || [];
    const templates = raw.map(t => {
      const comps = t.components || [];
      const bodyComp = comps.find(c => (c.type || '').toUpperCase() === 'BODY');
      const text = bodyComp?.text || '';

      // Extract each {{N}} placeholder in order (deduped, sorted numerically)
      const placeholderSet = new Set((text.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(p => p.replace(/\s/g, '')));
      const variables = [...placeholderSet]
        .sort((a, b) => parseInt(a.replace(/\D/g, '')) - parseInt(b.replace(/\D/g, '')))
        .map(p => ({ placeholder: p, index: parseInt(p.replace(/\D/g, '')) }));

      // Extract dynamic-URL buttons
      const buttonComps = comps.filter(c => (c.type || '').toUpperCase() === 'BUTTONS');
      const buttons = [];
      buttonComps.forEach(bc => {
        const btns = Array.isArray(bc.buttons) ? bc.buttons : (bc.buttons ? [bc.buttons] : [bc]);
        btns.forEach((btn, idx) => {
          const urlText = btn.url || btn.text || '';
          const hasVar = /\{\{\d+\}\}/.test(urlText);
          if (hasVar || btn.type === 'URL') {
            buttons.push({ index: idx, type: btn.type || 'URL', text: btn.text || 'Button', url: btn.url || '' });
          }
        });
      });

      return {
        name: t.name,
        language: t.language || 'en',
        category: (t.category || 'UTILITY').toUpperCase(),
        status: t.status || '',
        paramCount: variables.length,
        body: text,
        variables,
        buttons
      };
    });
    res.json(templates);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Campaigns ────────────────────────────────────────────────────────────

app.get('/api/campaigns', async (req, res) => {
  try { res.json(await getCampaigns()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await getCampaignById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, delay_seconds, template_name, language, category, phone_column, name_column, param_mapping, rows, autostart } = req.body;

    if (!name) return res.status(400).json({ error: 'Campaign name is required' });
    if (!phone_column) return res.status(400).json({ error: 'A phone column must be selected' });
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No recipients found in the CSV' });

    const settings = await getAllSettings();
    const tmplName = template_name || settings.WHATSAPP_TEMPLATE_NAME || '';
    if (!tmplName) return res.status(400).json({ error: 'No WhatsApp template name — set one in Settings or the campaign form' });

    const mapping = Array.isArray(param_mapping) ? param_mapping : [];
    const recipients = rows.map((row, i) => {
      const { formattedPhone } = normalizePhone(row[phone_column], '');
      const variables = {};
      mapping.forEach((col, idx) => { variables[String(idx + 1)] = col ? String(row[col] ?? '') : ''; });
      return {
        row_index: i,
        phone: formattedPhone,
        name: name_column ? String(row[name_column] ?? '') : '',
        variables
      };
    });

    const id = genId('cmp');
    await createCampaign({
      id, name,
      template_name: tmplName,
      language: language || 'en',
      category: category || 'UTILITY',
      delay_seconds: parseInt(delay_seconds || 5, 10),
      phone_column, name_column, param_mapping: mapping, recipients
    });

    if (autostart) await startCampaign(id);
    res.json({ success: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:id/start', async (req, res) => {
  try { await startCampaign(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:id/pause', async (req, res) => {
  try { await pauseCampaign(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:id/retry', async (req, res) => {
  try {
    const count = await retryFailedRecipients(req.params.id);
    res.json({ success: true, retried: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/:id/recipients/:rid/retry', async (req, res) => {
  try { await retryRecipient(req.params.rid); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/campaigns/:id', async (req, res) => {
  try { await deleteCampaign(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Serve Frontend ───────────────────────────────────────────────────────

const clientDistPath = join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(join(clientDistPath, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────

async function start() {
  try {
    await initDb();
    startScheduler();
    app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
