import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
  scheduleWebhookRetry
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

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
      return res.json({ success: result.status === 'success', status: result.status, error: result.errorMessage });
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
      const bodyComp = (t.components || []).find(c => (c.type || '').toUpperCase() === 'BODY');
      const text = bodyComp?.text || '';
      const paramCount = (text.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
      return {
        name: t.name,
        language: t.language || 'en',
        category: (t.category || 'UTILITY').toUpperCase(),
        status: t.status || '',
        paramCount,
        body: text
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
