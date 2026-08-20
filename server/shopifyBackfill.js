import crypto from 'node:crypto';
import { API_VERSION, normalizeShop } from './shopify.js';
import { executeFlow, normalizePhone } from './chatwoot.js';
import {
  getAllSettings,
  getFlows,
  getSuccessfulTemplateSendsSince,
  logTransaction,
  setTransactionChatwootMessageId
} from './db.js';

const CONFIRMATION_TEMPLATE = 'order_confirmation_01';
const SHIPPING_TEMPLATE = 'order_shipped';

function normalizeSince(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error('Choose a valid recovery start date');
  if (date > new Date()) throw new Error('Recovery start date cannot be in the future');
  return date.toISOString();
}

async function fetchOrdersSince(shop, token, since) {
  const orders = [];
  let cursor = null;
  do {
    const query = `
      query MissedOrderRecovery($after: String) {
        orders(first: 250, after: $after, query: "created_at:>=${since}", sortKey: CREATED_AT) {
          nodes {
            name createdAt cancelledAt statusPageUrl
            phone email displayFinancialStatus displayFulfillmentStatus
            customer { firstName lastName displayName email phone }
            shippingAddress { firstName lastName phone }
            billingAddress { firstName lastName phone }
            fulfillments { status trackingInfo { company number url } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`;
    const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables: { after: cursor } })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.errors) {
      throw new Error(body.errors?.[0]?.message || `Shopify order recovery failed (HTTP ${response.status})`);
    }
    const page = body.data?.orders;
    orders.push(...(page?.nodes || []));
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return orders;
}

function orderContext(order) {
  const firstName = order.customer?.firstName || order.shippingAddress?.firstName || order.billingAddress?.firstName || '';
  const lastName = order.customer?.lastName || order.shippingAddress?.lastName || order.billingAddress?.lastName || '';
  const fullName = `${firstName} ${lastName}`.trim() || order.customer?.displayName || 'Valued Customer';
  const rawPhone = order.phone || order.customer?.phone || order.shippingAddress?.phone || order.billingAddress?.phone || '';
  const { formattedPhone, sourceId } = normalizePhone(rawPhone, '');
  const tracking = (order.fulfillments || [])
    .flatMap(fulfillment => fulfillment.trackingInfo || [])
    .find(info => info.number && info.url);
  const orderName = String(order.name || '');
  const orderNumber = orderName.replace(/^#/, '');
  return {
    firstName, lastName, fullName,
    email: order.email || order.customer?.email || '',
    phone: formattedPhone, sourceId,
    orderName, orderNumber,
    orderStatusUrl: order.statusPageUrl || '',
    trackingCompany: tracking?.company || 'Manual',
    trackingNumber: tracking?.number || '',
    trackingUrl: tracking?.url || ''
  };
}

function flowTemplate(flow) {
  return flow.nodes.find(node => node.type === 'whatsapp')?.data?.templateName || '';
}

export async function auditMissedShopifyMessages(sinceInput) {
  const since = normalizeSince(sinceInput);
  const settings = await getAllSettings();
  const shop = normalizeShop(settings.SHOPIFY_STORE_URL);
  if (!shop || !settings.SHOPIFY_ADMIN_TOKEN) throw new Error('Shopify is not connected');

  const flows = await getFlows();
  const confirmationFlow = flows.find(flow => flow.trigger_event === 'orders/paid' && flowTemplate(flow) === CONFIRMATION_TEMPLATE)
    || flows.find(flow => flow.trigger_event === 'orders/create' && flowTemplate(flow) === CONFIRMATION_TEMPLATE);
  const shippingFlow = flows.find(flow => flow.trigger_event === 'fulfillments/create' && flowTemplate(flow) === SHIPPING_TEMPLATE);
  if (!confirmationFlow || !shippingFlow) throw new Error('Order confirmation and shipping flows must both exist');

  const [orders, priorSends] = await Promise.all([
    fetchOrdersSince(shop, settings.SHOPIFY_ADMIN_TOKEN, since),
    getSuccessfulTemplateSendsSince(since)
  ]);
  const sent = new Set(priorSends.map(item => `${item.orderNumber}|${item.template}`));
  const candidates = [];
  const summary = {
    since,
    scanned: orders.length,
    alreadySent: 0,
    confirmation: 0,
    shipping: 0,
    skippedCancelled: 0,
    skippedMissingPhone: 0,
    skippedMissingTracking: 0,
    totalEligible: 0
  };

  for (const order of orders) {
    if (order.cancelledAt) { summary.skippedCancelled++; continue; }
    const context = orderContext(order);
    const fulfilled = String(order.displayFulfillmentStatus || '').toUpperCase() === 'FULFILLED';
    const paid = ['PAID', 'PARTIALLY_PAID'].includes(String(order.displayFinancialStatus || '').toUpperCase());
    if (!fulfilled && !paid) continue;
    const template = fulfilled ? SHIPPING_TEMPLATE : CONFIRMATION_TEMPLATE;
    if (sent.has(`${context.orderNumber}|${template}`)) { summary.alreadySent++; continue; }
    if (!context.phone) { summary.skippedMissingPhone++; continue; }
    if (fulfilled && (!context.trackingNumber || !context.trackingUrl)) {
      summary.skippedMissingTracking++;
      continue;
    }
    if (!fulfilled && !context.orderStatusUrl) continue;
    const flow = fulfilled ? shippingFlow : confirmationFlow;
    candidates.push({ flow, context, template });
    if (fulfilled) summary.shipping++; else summary.confirmation++;
  }
  summary.totalEligible = candidates.length;
  return { summary, candidates };
}

export async function sendMissedShopifyMessages(sinceInput, onProgress = () => {}) {
  const audit = await auditMissedShopifyMessages(sinceInput);
  const result = { ...audit.summary, attempted: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  onProgress(result);

  for (const candidate of audit.candidates) {
    const { flow, context, template } = candidate;
    const idSeed = `${flow.id}|${context.orderNumber}|${template}`;
    const transactionId = `backfill_${crypto.createHash('sha256').update(idSeed).digest('hex').slice(0, 24)}`;
    result.attempted++;
    await logTransaction({
      id: transactionId, flow_id: flow.id, order_number: context.orderNumber,
      customer_name: context.fullName, phone_number: context.phone,
      status: 'processing', type: 'flow', steps: [], error_message: null
    });
    try {
      const execution = await executeFlow(flow, { ...context });
      const skipped = execution.steps.some(step => String(step.response?.note || '').includes('already sent'));
      await logTransaction({
        id: transactionId, flow_id: flow.id, order_number: context.orderNumber,
        customer_name: context.fullName, phone_number: context.phone,
        status: execution.status, type: 'flow', steps: execution.steps,
        error_message: execution.errorMessage || null
      });
      if (execution.chatwootMessageId) {
        await setTransactionChatwootMessageId(transactionId, execution.chatwootMessageId);
        result.sent++;
      } else if (skipped) {
        result.skipped++;
      } else {
        result.failed++;
        result.errors.push({ orderNumber: context.orderNumber, error: execution.errorMessage || 'No message ID returned' });
      }
    } catch (error) {
      result.failed++;
      result.errors.push({ orderNumber: context.orderNumber, error: error.message });
      await logTransaction({
        id: transactionId, flow_id: flow.id, order_number: context.orderNumber,
        customer_name: context.fullName, phone_number: context.phone,
        status: 'failed', type: 'flow', steps: [], error_message: error.message
      });
    }
    onProgress(result);
  }
  return result;
}
