import { getAllSettings } from './db.js';

// ─── Extractors ────────────────────────────────────────────────────────────

export function extractOrderDetails(body) {
  const customer = body.customer || {};
  const billing = body.billing_address || {};
  const shipping = body.shipping_address || {};

  const firstName = customer.first_name || billing.first_name || '';
  const lastName = customer.last_name || billing.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'Valued Customer';
  const phone = customer.phone || billing.phone || shipping.phone || '';
  const email = customer.email || body.email || '';
  const orderNumber = String(body.order_number || '');
  const orderName = body.name || `#${orderNumber}`;
  const totalPrice = body.total_price || '0.00';
  const createdAt = body.created_at || new Date().toISOString();
  const orderDate = new Date(createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const lineItems = (body.line_items || []).map(i => `${i.name} x${i.quantity} @ Rs.${i.price}`);
  const itemsSummary = lineItems.join(', ') || 'N/A';
  const shippingCity = shipping.city || '';
  const orderStatusUrl = body.order_status_url || '';

  const { cleanPhone, formattedPhone, sourceId } = normalizePhone(phone, `shopify-${orderNumber || Date.now()}`);

  return {
    type: 'order',
    fullName, firstName, lastName,
    phone: formattedPhone, sourceId, email,
    orderNumber, orderName, totalPrice,
    itemsSummary, orderDate, shippingCity, orderStatusUrl,
    isFulfillment: false
  };
}

export function extractFulfillmentDetails(body) {
  const destination = body.destination || {};
  const firstName = destination.first_name || '';
  const lastName = destination.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || body.email || 'Customer';
  const phone = destination.phone || '';
  const email = body.email || '';
  const fulfillmentName = body.name || '';
  const orderId = body.order_id || '';
  const orderName = fulfillmentName ? fulfillmentName.split('.')[0] : `#${orderId}`;
  const orderNumber = orderName.replace('#', '');
  const trackingCompany = body.tracking_company || '';
  const trackingNumber = body.tracking_number || '';
  const trackingUrl = body.tracking_url || '';

  const { formattedPhone, sourceId } = normalizePhone(phone, `shopify-fulfillment-${body.id || Date.now()}`);

  return {
    type: 'fulfillment',
    fullName, firstName, lastName,
    phone: formattedPhone, sourceId, email,
    orderNumber, orderName,
    trackingCompany, trackingNumber, trackingUrl, fulfillmentName,
    isFulfillment: true
  };
}

export function extractCheckoutDetails(body) {
  const billingAddress = body.billing_address || {};
  const shippingAddress = body.shipping_address || {};
  const customer = body.customer || {};

  const firstName = customer.first_name || billingAddress.first_name || shippingAddress.first_name || '';
  const lastName = customer.last_name || billingAddress.last_name || shippingAddress.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || body.email || 'Customer';
  const phone = customer.phone || billingAddress.phone || shippingAddress.phone || body.phone || '';
  const email = body.email || customer.email || '';

  const checkoutId = String(body.id || '');
  const token = body.token || '';
  const totalPrice = body.total_price || body.subtotal_price || '0.00';
  const currency = body.currency || 'INR';
  const abandonedCheckoutUrl = body.abandoned_checkout_url || '';
  const createdAt = body.created_at || new Date().toISOString();
  const checkoutDate = new Date(createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const lineItems = (body.line_items || []).map(i => `${i.title || i.name} x${i.quantity} @ ${currency} ${i.price}`);
  const itemsSummary = lineItems.join(', ') || 'N/A';

  const { formattedPhone, sourceId } = normalizePhone(phone, `checkout-${checkoutId || Date.now()}`);

  return {
    type: 'checkout',
    fullName, firstName, lastName,
    phone: formattedPhone, sourceId, email,
    checkoutId, token,
    orderNumber: checkoutId,
    orderName: `Checkout #${checkoutId}`,
    totalPrice, currency,
    abandonedCheckoutUrl,
    itemsSummary, checkoutDate,
    isFulfillment: false
  };
}

function normalizePhone(phone, fallbackSourceId) {
  let cleanPhone = String(phone || '').replace(/[\s\-().+]/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = '91' + cleanPhone.slice(1);
  else if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
  const sourceId = cleanPhone || fallbackSourceId;
  const formattedPhone = cleanPhone ? `+${cleanPhone}` : '';
  return { cleanPhone, formattedPhone, sourceId };
}

// ─── Single Node Executor ─────────────────────────────────────────────────

export async function executeFlowNode(node, context, settings, steps) {
  const step = {
    name: node.data?.label || node.type,
    nodeId: node.id,
    nodeType: node.type,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: 0,
    request: null,
    response: null,
    error: null
  };
  steps.push(step);
  const start = Date.now();

  const finish = (status, response = null, error = null) => {
    step.status = status;
    step.endedAt = new Date().toISOString();
    step.durationMs = Date.now() - start;
    if (response) step.response = response;
    if (error) step.error = error;
  };

  try {
    switch (node.type) {

      case 'trigger': {
        finish('success', { note: `Triggered by ${node.data?.event || 'webhook'}`, context });
        return { type: 'trigger' };
      }

      case 'delay': {
        const duration = parseInt(node.data?.duration || 1, 10);
        const unit = node.data?.unit || 'hours';
        const multiplier = unit === 'minutes' ? 60000 : unit === 'hours' ? 3600000 : 86400000;
        const delayMs = duration * multiplier;
        finish('scheduled', { note: `Waiting ${duration} ${unit} before next step`, delayMs });
        return { type: 'delay', delayMs };
      }

      case 'condition': {
        const field = node.data?.field || '';
        const operator = node.data?.operator || 'exists';
        const value = node.data?.value || '';
        const actual = context[field];
        let result = false;
        switch (operator) {
          case 'exists': result = !!actual && String(actual).length > 0; break;
          case 'not_exists': result = !actual || String(actual).length === 0; break;
          case 'equals': result = String(actual) === String(value); break;
          case 'not_equals': result = String(actual) !== String(value); break;
          case 'contains': result = String(actual || '').toLowerCase().includes(String(value).toLowerCase()); break;
        }
        step.request = { field, operator, expected: value };
        finish('success', { result, actual: actual || 'N/A', branch: result ? 'yes' : 'no' });
        return { type: 'condition', result };
      }

      case 'whatsapp': {
        const result = await sendWhatsAppTemplate(node.data, context, settings, step);
        finish(result.ok ? 'success' : 'failed', result.response, result.ok ? null : { message: result.error });
        if (!result.ok) throw new Error(result.error);
        return { type: 'action' };
      }

      case 'fetchShopify': {
        const result = await fetchShopifyData(node.data, context, settings, step);
        if (result.data) Object.assign(context, result.data);
        finish(result.ok ? 'success' : 'failed', result.response, result.ok ? null : { message: result.error });
        return { type: 'action', updatedContext: context };
      }

      default:
        finish('success', { note: `Unknown node type: ${node.type}` });
        return { type: 'unknown' };
    }
  } catch (err) {
    finish('failed', null, { message: err.message, stack: err.stack });
    throw err;
  }
}

// ─── Flow Graph Executor ──────────────────────────────────────────────────

/**
 * Execute a flow starting from a given nodeId (or the trigger's output).
 * Returns { status, steps, nextNodeId?, delayMs?, context }
 */
export async function executeFlow(flow, context, startNodeId = null) {
  const { nodes, edges } = flow;
  const settings = await getAllSettings();
  const steps = [];

  // Determine starting node
  let currentNodeId = startNodeId;
  if (!currentNodeId) {
    const triggerNode = nodes.find(n => n.type === 'trigger');
    if (!triggerNode) {
      return { status: 'failed', steps, errorMessage: 'No trigger node found in flow' };
    }
    // Start from the first node after the trigger
    const firstEdge = edges.find(e => e.source === triggerNode.id);
    if (!firstEdge) {
      return { status: 'success', steps, message: 'Flow has no action nodes connected' };
    }
    currentNodeId = firstEdge.target;
  }

  while (currentNodeId) {
    const node = nodes.find(n => n.id === currentNodeId);
    if (!node) break;

    let result;
    try {
      result = await executeFlowNode(node, context, settings, steps);
    } catch (err) {
      return {
        status: 'failed',
        steps,
        context,
        errorMessage: `Step "${node.data?.label || node.type}" failed: ${err.message}`
      };
    }

    // Handle special return types
    if (result.type === 'delay') {
      // Find the next node after this delay
      const nextEdge = edges.find(e => e.source === currentNodeId);
      return {
        status: 'delayed',
        steps,
        context,
        nextNodeId: nextEdge?.target || null,
        delayMs: result.delayMs
      };
    }

    if (result.type === 'condition') {
      const handle = result.result ? 'yes' : 'no';
      // Look for an edge from this node with the matching handle
      const nextEdge = edges.find(e => e.source === currentNodeId && (e.sourceHandle === handle || e.sourceHandle === null));
      // If no handle match, try any edge for that branch label
      const fallbackEdge = !nextEdge ? edges.find(e => e.source === currentNodeId) : null;
      currentNodeId = (nextEdge || fallbackEdge)?.target || null;
    } else {
      const nextEdge = edges.find(e => e.source === currentNodeId);
      currentNodeId = nextEdge?.target || null;
    }

    // Update context if a node augmented it
    if (result.updatedContext) Object.assign(context, result.updatedContext);
  }

  return { status: 'success', steps, context };
}

// ─── WhatsApp Send Helper ─────────────────────────────────────────────────

async function sendWhatsAppTemplate(nodeData, context, settings, step) {
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const token = settings.CHATWOOT_API_TOKEN;
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = parseInt(settings.CHATWOOT_INBOX_ID || '1', 10);
  const templateName = nodeData?.templateName || settings.WHATSAPP_TEMPLATE_NAME || '';
  const mappingStr = nodeData?.templateMapping || settings.WHATSAPP_TEMPLATE_MAPPING || '';

  // Ensure contact + conversation exist
  let contactId = context._contactId;
  let conversationId = context._conversationId;

  try {
    if (!contactId) {
      // Search for existing contact
      const searchUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(context.phone || context.sourceId)}`;
      step.request = { url: searchUrl, method: 'GET' };
      const searchRes = await fetch(searchUrl, { headers: { api_access_token: token } });
      const searchBody = await searchRes.json();
      const contacts = Array.isArray(searchBody) ? searchBody : (searchBody.payload || []);
      if (contacts.length > 0) {
        contactId = contacts[0].id;
      } else {
        // Create contact
        const createUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/contacts`;
        const createBody = { inbox_id: inboxId, name: context.fullName, phone_number: context.phone, email: context.email || undefined };
        const createRes = await fetch(createUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(createBody) });
        const createResBody = await createRes.json();

        if (createRes.status === 422) {
          // Fallback: search again
          const fb = await fetch(`${apiBaseUrl}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(context.sourceId)}`, { headers: { api_access_token: token } });
          if (fb.ok) {
            const fbBody = await fb.json();
            const fbContacts = Array.isArray(fbBody) ? fbBody : (fbBody.payload || []);
            if (fbContacts.length > 0) contactId = fbContacts[0].id;
          }
        } else if (createRes.ok) {
          contactId = createResBody.payload?.contact?.id || createResBody.id || createResBody.contact?.id;
        }

        if (!contactId) throw new Error('Could not find or create contact');
      }
      context._contactId = contactId;
    }

    if (!conversationId) {
      // Create conversation
      const convUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations`;
      const convBody = { contact_id: contactId, inbox_id: inboxId, source_id: context.sourceId, status: 'open' };
      const convRes = await fetch(convUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(convBody) });
      const convResBody = await convRes.json();
      if (!convRes.ok) throw new Error(`Create Conversation failed: ${convRes.status}`);
      conversationId = convResBody.id;
      if (!conversationId) throw new Error('No conversation ID returned');
      context._conversationId = conversationId;
    }

    // Build template params
    const mapping = mappingStr.split(',').map(s => s.trim()).filter(Boolean);
    const processedParamsBody = {};
    mapping.forEach((key, i) => {
      let val = context[key] || '';
      if (!val) {
        if (key === 'trackingUrl') val = 'https://stomatalfarms.com';
        else if (key === 'trackingCompany') val = 'Manual';
        else if (key === 'trackingNumber') val = 'Shipped';
        else if (key === 'abandonedCheckoutUrl') val = 'https://stomatalfarms.com/checkout';
      }
      processedParamsBody[String(i + 1)] = val;
    });

    let content = `Template "${templateName}" sent:\n`;
    mapping.forEach((key, i) => { content += `• {{${i + 1}}} (${key}): ${processedParamsBody[String(i + 1)]}\n`; });

    const msgUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    const msgBody = {
      message_type: 'outgoing',
      content,
      template_params: {
        name: templateName,
        category: 'UTILITY',
        language: 'en',
        processed_params: { body: processedParamsBody }
      }
    };

    step.request = { url: msgUrl, method: 'POST', body: msgBody };
    const msgRes = await fetch(msgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(msgBody) });
    const msgResBody = await msgRes.json();
    step.response = { status: msgRes.status, body: msgResBody };

    if (!msgRes.ok) throw new Error(`Send WhatsApp failed: ${msgRes.status}`);
    return { ok: true, response: { status: msgRes.status, body: msgResBody } };
  } catch (err) {
    return { ok: false, error: err.message, response: step.response };
  }
}

// ─── Fetch Shopify Helper ─────────────────────────────────────────────────

async function fetchShopifyData(nodeData, context, settings, step) {
  const storeUrl = (settings.SHOPIFY_STORE_URL || '').replace(/\/$/, '');
  const adminToken = settings.SHOPIFY_ADMIN_TOKEN;
  const fetchType = nodeData?.fetchType || 'order';

  if (!storeUrl || !adminToken) {
    return { ok: false, error: 'Shopify Admin API not configured in Settings' };
  }

  try {
    let url;
    if (fetchType === 'checkout') {
      url = `https://${storeUrl}/admin/api/2024-01/checkouts/${context.token || context.checkoutId}.json`;
    } else {
      url = `https://${storeUrl}/admin/api/2024-01/orders/${context.orderNumber}.json`;
    }

    step.request = { url, method: 'GET' };
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': adminToken } });
    const resBody = await res.json();
    step.response = { status: res.status, body: resBody };

    if (!res.ok) return { ok: false, error: `Shopify API error: ${res.status}` };

    const data = resBody.checkout || resBody.order || resBody;
    return { ok: true, data: { _shopifyData: data }, response: { status: res.status, body: resBody } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Legacy pipeline (still used by direct webhook handler) ───────────────

export async function executePipeline(shopifyPayload, topic = 'orders/create') {
  const steps = [];
  let rawBody = shopifyPayload;
  if (Array.isArray(shopifyPayload) && shopifyPayload[0]) rawBody = shopifyPayload[0].body || shopifyPayload[0];
  else if (shopifyPayload && shopifyPayload.body) rawBody = shopifyPayload.body;

  let detectedTopic = topic;
  const actualPayload = Array.isArray(shopifyPayload) ? (shopifyPayload[0]?.body || shopifyPayload[0]) : (shopifyPayload?.body || shopifyPayload);
  if (actualPayload && (actualPayload.destination || actualPayload.tracking_number || actualPayload.order_id)) detectedTopic = 'fulfillments/create';
  if (actualPayload && (actualPayload.abandoned_checkout_url || actualPayload.token) && !actualPayload.order_number) detectedTopic = 'checkouts/create';

  const isFulfillment = detectedTopic.startsWith('fulfillments/');
  const isCheckout = detectedTopic.startsWith('checkouts/');

  const context = isCheckout
    ? extractCheckoutDetails(rawBody)
    : isFulfillment
      ? extractFulfillmentDetails(rawBody)
      : extractOrderDetails(rawBody);

  const settings = await getAllSettings();
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const token = settings.CHATWOOT_API_TOKEN;
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = parseInt(settings.CHATWOOT_INBOX_ID || '1', 10);
  const templateName = isFulfillment ? settings.WHATSAPP_SHIPPING_TEMPLATE_NAME : isCheckout ? settings.WHATSAPP_ABANDONED_CART_TEMPLATE_NAME : settings.WHATSAPP_TEMPLATE_NAME;
  const templateMapping = isFulfillment ? settings.WHATSAPP_SHIPPING_TEMPLATE_MAPPING : isCheckout ? settings.WHATSAPP_ABANDONED_CART_TEMPLATE_MAPPING : settings.WHATSAPP_TEMPLATE_MAPPING;

  const runStep = async (name, fn) => {
    const step = { name, status: 'pending', startedAt: new Date().toISOString(), endedAt: null, durationMs: 0, request: null, response: null, error: null };
    steps.push(step);
    const start = Date.now();
    try {
      const r = await fn(step);
      step.status = 'success';
      step.endedAt = new Date().toISOString();
      step.durationMs = Date.now() - start;
      return r;
    } catch (err) {
      step.status = 'failed';
      step.endedAt = new Date().toISOString();
      step.durationMs = Date.now() - start;
      step.error = { message: err.message, stack: err.stack };
      throw err;
    }
  };

  try {
    let orderDetails = null;
    let contactId = null;
    let conversationId = null;

    orderDetails = await runStep('Extract Details', async (step) => {
      step.request = { body: rawBody, topic: detectedTopic };
      step.response = { body: context };
      return context;
    });

    const searchResult = await runStep('Search Contact', async (step) => {
      if (!context.phone) { step.response = { note: 'No phone, skipping' }; return []; }
      const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(context.phone)}`;
      step.request = { url, method: 'GET' };
      const res = await fetch(url, { headers: { api_access_token: token } });
      const body = await res.json();
      step.response = { status: res.status, body };
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      return body;
    });

    await runStep('Verify/Create Contact', async (step) => {
      const contacts = Array.isArray(searchResult) ? searchResult : (searchResult.payload || []);
      if (contacts.length > 0) {
        contactId = contacts[0].id;
        step.response = { note: `Reusing contact ID: ${contactId}`, body: contacts[0] };
      } else {
        const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/contacts`;
        const body = { inbox_id: inboxId, name: context.fullName, phone_number: context.phone, email: context.email || undefined };
        step.request = { url, method: 'POST', body };
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(body) });
        const resBody = await res.json();
        step.response = { status: res.status, body: resBody };

        if (res.status === 422) {
          const fb = await fetch(`${apiBaseUrl}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(context.sourceId)}`, { headers: { api_access_token: token } });
          if (fb.ok) {
            const fbBody = await fb.json();
            const fbContacts = Array.isArray(fbBody) ? fbBody : (fbBody.payload || []);
            if (fbContacts.length > 0) { contactId = fbContacts[0].id; return contactId; }
          }
        }
        if (!res.ok) throw new Error(`Create Contact failed: ${resBody.message || res.statusText} (${res.status})`);
        contactId = resBody.payload?.contact?.id || resBody.id || resBody.contact?.id;
        if (!contactId) throw new Error('No contact ID returned');
      }
      return contactId;
    });

    conversationId = await runStep('Create Conversation', async (step) => {
      const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations`;
      const body = { contact_id: contactId, inbox_id: inboxId, source_id: context.sourceId, status: 'open' };
      step.request = { url, method: 'POST', body };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(body) });
      const resBody = await res.json();
      step.response = { status: res.status, body: resBody };
      if (!res.ok) throw new Error(`Create Conversation failed: ${res.status}`);
      if (!resBody.id) throw new Error('No conversation ID returned');
      return resBody.id;
    });

    await runStep('Send WhatsApp Template', async (step) => {
      const mapping = (templateMapping || '').split(',').map(s => s.trim()).filter(Boolean);
      const processedParamsBody = {};
      mapping.forEach((key, i) => {
        let val = context[key] || '';
        if (!val && key === 'trackingUrl') val = 'https://stomatalfarms.com';
        if (!val && key === 'abandonedCheckoutUrl') val = 'https://stomatalfarms.com/checkout';
        processedParamsBody[String(i + 1)] = val;
      });
      let content = `Template "${templateName}" sent:\n`;
      mapping.forEach((key, i) => { content += `• {{${i + 1}}} (${key}): ${processedParamsBody[String(i + 1)]}\n`; });
      const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
      const body = { message_type: 'outgoing', content, template_params: { name: templateName, category: 'UTILITY', language: 'en', processed_params: { body: processedParamsBody } } };
      step.request = { url, method: 'POST', body };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(body) });
      const resBody = await res.json();
      step.response = { status: res.status, body: resBody };
      if (!res.ok) throw new Error(`Send WhatsApp failed: ${res.status}`);
      return resBody;
    });

    return { status: 'success', orderDetails: context, steps };
  } catch (error) {
    return { status: 'failed', orderDetails: context, steps, errorMessage: error.message };
  }
}
