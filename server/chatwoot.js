import { getAllSettings, claimNotification, markNotificationSent, markNotificationFailed } from './db.js';

/** Build the idempotency key for a WhatsApp send: one send per (scope, topic, order/checkout). */
function buildDedupeKey(scope, topic, context) {
  const identifier = context.orderNumber || context.checkoutId || context.trackingNumber || context.sourceId || 'unknown';
  return `${scope}:${topic || 'unknown'}:${identifier}`;
}

/**
 * Build the payload for POST /conversations. If CHATWOOT_AUTOMATION_ASSIGNEE_ID
 * is configured, every conversation this app creates (campaigns, abandoned-cart
 * notifications, order/shipping confirmations) is assigned to that agent up
 * front — since it already has an owner, Chatwoot's own Inbox "Default Policy"
 * auto-assignment has nothing to grab and won't round-robin it into a real
 * agent's queue. Leave the setting empty to send no assignee_id (unchanged
 * behavior — whatever the inbox's own policy does).
 */
export function buildConversationBody({ contactId, inboxId, sourceId, settings }) {
  const body = { contact_id: contactId, inbox_id: inboxId, source_id: sourceId, status: 'open' };
  const assigneeId = parseInt(settings?.CHATWOOT_AUTOMATION_ASSIGNEE_ID || '', 10);
  if (Number.isInteger(assigneeId) && assigneeId > 0) body.assignee_id = assigneeId;
  return body;
}

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

export function normalizePhone(phone, fallbackSourceId) {
  let cleanPhone = String(phone || '').replace(/[\s\-().+]/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = '91' + cleanPhone.slice(1);
  else if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
  // For WhatsApp inbox, sourceId must be numeric (1-15 digits) or business account format.
  // If no phone available, generate numeric ID from timestamp + random
  const sourceId = cleanPhone || (fallbackSourceId ? String(Date.now() % 999999999999999).slice(0, 15) : '');
  const formattedPhone = cleanPhone ? `+${cleanPhone}` : '';
  return { cleanPhone, formattedPhone, sourceId };
}

// ─── WhatsApp template body + button info (so messages read like the real template) ───

/**
 * Cached template info: body text and button components keyed by template name.
 * Shape: { at: timestamp, templates: { [name]: {
 *   body, bodyParamCount, buttons, category, language, status
 * } } }
 */
let _templateCache = { at: 0, key: '', templates: {} };

/**
 * Refresh the template cache from Chatwoot once every 60s.
 * Stores both the BODY text and the BUTTONS (with how many {{N}} vars each has).
 */
async function refreshTemplateCache(settings) {
  const now = Date.now();
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = settings.CHATWOOT_INBOX_ID || '1';
  const cacheKey = `${apiBaseUrl}|${accountId}|${inboxId}`;
  if (_templateCache.key === cacheKey && now - _templateCache.at < 60_000) return;
  if (_templateCache.key !== cacheKey) {
    _templateCache = { at: 0, key: cacheKey, templates: {} };
  }
  try {
    const token = settings.CHATWOOT_API_TOKEN;
    if (!apiBaseUrl || !token) return;
    const r = await fetch(`${apiBaseUrl}/api/v1/accounts/${accountId}/inboxes/${inboxId}`, { headers: { api_access_token: token } });
    if (!r.ok) return;
    const b = await r.json();
    const raw = b.message_templates || b.payload?.message_templates || [];
    const templates = {};
    for (const t of raw) {
      const comps = t.components || [];
      const bodyComp = comps.find(c => (c.type || '').toUpperCase() === 'BODY');
      const buttonComps = comps.filter(c => (c.type || '').toUpperCase() === 'BUTTONS');
      // Flatten button sub-entries; each button may itself be an array or object
      const buttons = [];
      buttonComps.forEach(bc => {
        const btns = Array.isArray(bc.buttons) ? bc.buttons : (bc.buttons ? [bc.buttons] : [bc]);
        btns.forEach((btn, idx) => {
          // Count how many {{N}} placeholders are in the button's URL or text
          const urlText = btn.url || btn.text || '';
          const varCount = (urlText.match(/\{\{\d+\}\}/g) || []).length;
          // Static URL buttons do not accept a parameter. Only expose buttons
          // whose URL contains a placeholder such as {{1}}.
          if (varCount > 0) {
            buttons.push({ index: idx, type: btn.type || 'URL', varCount, url: btn.url || '' });
          }
        });
      });
      const body = bodyComp?.text || '';
      const bodyParamIndexes = [...new Set(
        (body.match(/\{\{\s*(\d+)\s*\}\}/g) || [])
          .map(value => Number(value.replace(/\D/g, '')))
          .filter(Number.isInteger)
      )];
      templates[t.name] = {
        body,
        bodyParamCount: bodyParamIndexes.length ? Math.max(...bodyParamIndexes) : 0,
        buttons,
        category: String(t.category || 'MARKETING').toUpperCase(),
        language: t.language || 'en',
        status: String(t.status || '').toUpperCase()
      };
    }
    _templateCache = { at: now, key: cacheKey, templates };
  } catch (_) { /* keep stale cache on failure */ }
}

/**
 * Return the BODY text for a template by name. Cached for 60s.
 */
export async function getTemplateBody(settings, templateName) {
  if (!templateName) return null;
  await refreshTemplateCache(settings);
  return _templateCache.templates[templateName]?.body || null;
}

/** Return the complete approved-template definition, or null when unavailable. */
export async function getTemplateDefinition(settings, templateName) {
  const normalizedName = String(templateName || '').trim();
  if (!normalizedName) return null;
  await refreshTemplateCache(settings);
  return _templateCache.templates[normalizedName] || null;
}

/**
 * Return button info for a template (array of { index, type, varCount }).
 * Returns [] if the template has no dynamic-URL buttons.
 */
export async function getTemplateButtons(settings, templateName) {
  if (!templateName) return [];
  await refreshTemplateCache(settings);
  return _templateCache.templates[templateName]?.buttons || [];
}

/**
 * Convert Chatwoot template metadata plus our context mapping into the
 * enhanced processed_params.buttons format expected by current Chatwoot.
 *
 * Chatwoot accepts: [{ type: 'url', parameter: 'https://...' }]
 * (not Meta's lower-level component/index/parameters representation).
 */
export function buildTemplateButtonParams(templateButtons, context = {}, richMapping = null) {
  if (!Array.isArray(templateButtons) || templateButtons.length === 0) return undefined;

  return templateButtons.map(btn => {
    const btnKey = `button_${btn.index}`;
    const contextKey = richMapping?.[btnKey] || 'abandonedCheckoutUrl';
    const targetUrl = context[contextKey]
      || context.abandonedCheckoutUrl
      || context.orderStatusUrl
      || context.trackingUrl
      || 'https://stomatalfarms.com';

    // Meta URL templates store a fixed prefix/suffix around {{1}}. Chatwoot's
    // `parameter` must contain only the dynamic portion, not the complete URL.
    // Example: template `https://pay.example/{{1}}` + checkout URL
    // `https://pay.example/cart/abc` must send `cart/abc`.
    const pattern = String(btn.url || '');
    const marker = pattern.match(/\{\{\s*\d+\s*\}\}/);
    let parameter = String(targetUrl);
    if (marker) {
      const markerIndex = marker.index ?? 0;
      const prefix = pattern.slice(0, markerIndex);
      const suffix = pattern.slice(markerIndex + marker[0].length);
      if (parameter.startsWith(prefix) && (!suffix || parameter.endsWith(suffix))) {
        parameter = parameter.slice(prefix.length, suffix ? -suffix.length : undefined);
      }
    }

    return {
      type: String(btn.type || 'url').toLowerCase(),
      parameter
    };
  });
}

/**
 * Substitute {{1}}, {{2}}… in a template body with processed params
 * ({ "1": "...", "2": "..." }). Unfilled placeholders are left as-is.
 */
export function renderTemplateBody(body, processedParams) {
  if (!body) return null;
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const v = processedParams ? processedParams[String(n)] : undefined;
    return (v === undefined || v === null || v === '') ? `{{${n}}}` : String(v);
  });
}

/**
 * WhatsApp rejects a template send outright — error (#131008) "Required
 * parameter is missing" — if any {{n}} placeholder resolves to an empty
 * string. Rather than let that reach the API (and leave a broken "Hi !"
 * message, or Chatwoot's own preview substituting the bare placeholder
 * number, in the conversation), abort before sending. Combined with the
 * per-order dedupe claim being released on failure, this lets a later event
 * with more complete data (e.g. checkouts/update once the customer types
 * their name) retry the same send successfully instead of failing forever.
 */
export function assertParamsComplete(processedParamsBody, expectedCount = null) {
  const params = processedParamsBody || {};
  if (Number.isInteger(expectedCount) && expectedCount > 0) {
    const missingIndexes = [];
    for (let index = 1; index <= expectedCount; index++) {
      if (!params[String(index)]) missingIndexes.push(`{{${index}}}`);
    }
    if (missingIndexes.length > 0) {
      throw new Error(`Missing value for template parameter(s) ${missingIndexes.join(', ')} — not sending`);
    }
  }
  const missing = Object.entries(params).filter(([, v]) => !v).map(([k]) => `{{${k}}}`);
  if (missing.length > 0) {
    throw new Error(`Missing value for template parameter(s) ${missing.join(', ')} — not sending`);
  }
}

/** Fail closed before creating a Chatwoot conversation for a bad template. */
export async function requireApprovedTemplate(settings, templateName) {
  const normalizedName = String(templateName || '').trim();
  if (!normalizedName) throw new Error('No WhatsApp template name configured — not sending');
  const template = await getTemplateDefinition(settings, normalizedName);
  if (!template) throw new Error(`WhatsApp template "${normalizedName}" was not found in the configured Chatwoot inbox — not sending`);
  if (template.status !== 'APPROVED') {
    throw new Error(`WhatsApp template "${normalizedName}" is ${template.status || 'not approved'}, not APPROVED — not sending`);
  }
  return { name: normalizedName, ...template };
}

// ─── Contact resolution (reuse existing contacts, don't fail on 422) ─────────

async function searchContactBy(apiBaseUrl, accountId, token, q) {
  if (!q) return null;
  const r = await fetch(`${apiBaseUrl}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(q)}`, { headers: { api_access_token: token } });
  if (!r.ok) return null;
  const b = await r.json();
  const list = Array.isArray(b) ? b : (b.payload || []);
  return list.length > 0 ? list[0].id : null;
}

async function findExistingContactId(apiBaseUrl, accountId, token, { email, phone, sourceId }) {
  for (const q of [phone, sourceId, email].filter(Boolean)) {
    const id = await searchContactBy(apiBaseUrl, accountId, token, q);
    if (id) return id;
  }
  return null;
}

function isUsefulContactName(name) {
  const value = String(name || '').trim();
  if (!value || /^(customer|valued customer)$/i.test(value)) return false;
  if (/^[+#\d\s().-]+$/.test(value)) return false;
  return /[a-zA-Z]{2}/.test(value);
}

async function updateContactName(apiBaseUrl, accountId, token, contactId, name) {
  if (!contactId || !isUsefulContactName(name)) return;
  try {
    await fetch(`${apiBaseUrl}/api/v1/accounts/${accountId}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', api_access_token: token },
      body: JSON.stringify({ name: String(name).trim() })
    });
  } catch (_) { /* a cosmetic contact update must not block delivery */ }
}

/**
 * Find an existing contact (by phone first, then email) or create one.
 * Handles Chatwoot's 422 "phone/email already taken" by reusing the existing
 * contact, and falls back to creating without the email on email collisions —
 * so an already-existing contact is always messaged, never skipped.
 */
export async function resolveContactId({ apiBaseUrl, accountId, token, inboxId, name, phone, email, sourceId }) {
  let id = await findExistingContactId(apiBaseUrl, accountId, token, { phone, sourceId });
  if (id) {
    await updateContactName(apiBaseUrl, accountId, token, id, name);
    return id;
  }

  const create = async (withEmail) => {
    const body = { inbox_id: inboxId, name, phone_number: phone };
    if (withEmail && email) body.email = email;
    const r = await fetch(`${apiBaseUrl}/api/v1/accounts/${accountId}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', api_access_token: token },
      body: JSON.stringify(body)
    });
    const b = await r.json().catch(() => ({}));
    return { r, b };
  };

  let { r, b } = await create(true);
  if (r.ok) return b.payload?.contact?.id || b.id || b.contact?.id;

  if (r.status === 422) {
    // Already exists (phone or email) — find and reuse it
    id = await findExistingContactId(apiBaseUrl, accountId, token, { phone, sourceId, email });
    if (id) {
      await updateContactName(apiBaseUrl, accountId, token, id, name);
      return id;
    }
    // Email belongs to a different contact — create with phone only
    ({ r, b } = await create(false));
    if (r.ok) return b.payload?.contact?.id || b.id || b.contact?.id;
    id = await findExistingContactId(apiBaseUrl, accountId, token, { phone, sourceId });
    if (id) {
      await updateContactName(apiBaseUrl, accountId, token, id, name);
      return id;
    }
  }

  throw new Error(`Could not find or create contact (HTTP ${r.status}${b?.message ? ': ' + b.message : ''})`);
}

/**
 * Reuse the latest open/pending conversation for this contact and inbox.
 * A new conversation is created only when no reusable conversation exists.
 */
export async function resolveConversationId({ apiBaseUrl, accountId, token, inboxId, contactId, sourceId, settings }) {
  const listUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`;
  try {
    const listRes = await fetch(listUrl, { headers: { api_access_token: token } });
    if (listRes.ok) {
      const body = await listRes.json();
      const conversations = Array.isArray(body) ? body : (body.payload || []);
      const reusable = conversations
        .filter(conversation =>
          Number(conversation.inbox_id) === Number(inboxId)
          && ['open', 'pending'].includes(conversation.status)
        )
        .sort((a, b) => {
          const aMessage = a.last_non_activity_message;
          const bMessage = b.last_non_activity_message;
          const aHealthy = aMessage && aMessage.status !== 'failed' && String(aMessage.content || '').trim() !== 'Template:';
          const bHealthy = bMessage && bMessage.status !== 'failed' && String(bMessage.content || '').trim() !== 'Template:';
          if (aHealthy !== bHealthy) return bHealthy ? 1 : -1;
          const aTime = Number(aMessage?.created_at || a.last_activity_at || a.created_at || 0);
          const bTime = Number(bMessage?.created_at || b.last_activity_at || b.created_at || 0);
          return bTime - aTime;
        })[0];
      if (reusable?.id) return { id: reusable.id, reused: true };
    }
  } catch (_) { /* fall through to conversation creation */ }

  const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations`;
  const body = buildConversationBody({ contactId, inboxId, sourceId, settings });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_access_token: token },
    body: JSON.stringify(body)
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Create conversation failed: ${response.status} ${JSON.stringify(responseBody)}`);
  if (!responseBody.id) throw new Error('No conversation ID returned');
  return { id: responseBody.id, reused: false, response: responseBody };
}

// ─── Single Node Executor ─────────────────────────────────────────────────

export async function executeFlowNode(node, context, settings, steps, flow = null) {
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
        const dedupeKey = flow
          ? buildDedupeKey(`flow:${flow.id}:${node.id}`, flow.trigger_event, context)
          : null;
        const result = await sendWhatsAppTemplate(node.data, context, settings, step, dedupeKey);
        finish(result.ok ? 'success' : 'failed', result.response, result.ok ? null : { message: result.error });
        if (!result.ok) throw new Error(result.error);
        if (result.chatwootMessageId) context._lastChatwootMessageId = result.chatwootMessageId;
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
  if (flow?.trigger_event?.startsWith('checkouts/')) {
    return {
      status: 'success',
      steps: [{
        name: 'Recovery Flow Routing',
        status: 'success',
        response: { note: 'Checkout messaging is managed exclusively by Recovery Flows.' }
      }],
      context,
      skipped: true,
      skipReason: 'recovery_flow_managed'
    };
  }

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
      result = await executeFlowNode(node, context, settings, steps, flow);
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
        delayMs: result.delayMs,
        chatwootMessageId: context._lastChatwootMessageId || null
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

  return { status: 'success', steps, context, chatwootMessageId: context._lastChatwootMessageId || null };
}

// ─── WhatsApp Send Helper ─────────────────────────────────────────────────

export async function sendWhatsAppTemplate(nodeData, context, settings, step, dedupeKey) {
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const token = settings.CHATWOOT_API_TOKEN;
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = parseInt(settings.CHATWOOT_INBOX_ID || '1', 10);
  const templateName = nodeData?.templateName || settings.WHATSAPP_TEMPLATE_NAME || '';
  const mappingStr = nodeData?.templateMapping || settings.WHATSAPP_TEMPLATE_MAPPING || '';

  // ── Skip contacts with no phone — WhatsApp requires a phone number ──────
  if (!context.phone) {
    step.response = { note: 'Skipped — no phone number available for this contact' };
    console.log(`[WhatsApp] Skipping contact "${context.fullName}" — no phone number`);
    if (dedupeKey) await markNotificationFailed(dedupeKey).catch(() => {});
    return { ok: true, skipped: true, response: step.response };
  }

  // Ensure contact + conversation exist
  let contactId = context._contactId;
  let conversationId = context._conversationId;

  try {
    if (!apiBaseUrl || !token) throw new Error('Chatwoot API not configured in Settings');
    const template = await requireApprovedTemplate(settings, templateName);

    if (dedupeKey && !(await claimNotification(dedupeKey))) {
      step.response = { note: 'Skipped — already sent for this order' };
      return { ok: true, skipped: true, response: step.response };
    }

    if (!contactId) {
      step.request = { method: 'resolveContactId', name: context.fullName, phone: context.phone, email: context.email };
      contactId = await resolveContactId({
        apiBaseUrl, accountId, token, inboxId,
        name: context.fullName, phone: context.phone, email: context.email, sourceId: context.sourceId
      });
      if (!contactId) throw new Error('Could not find or create contact');
      context._contactId = contactId;
    }

    if (!conversationId) {
      const conversation = await resolveConversationId({
        apiBaseUrl, accountId, token, inboxId, contactId,
        sourceId: context.sourceId, settings
      });
      conversationId = conversation.id;
      context._conversationId = conversationId;
    }

    // ── Build body params ────────────────────────────────────────────────
    // Priority: rich variable_mapping from UI  >  legacy comma-separated templateMapping
    const richMapping = nodeData?.variableMapping || null; // { '{{1}}': 'firstName', '{{2}}': 'itemsSummary', 'button_0': 'abandonedCheckoutUrl' }
    const processedParamsBody = {};

    if (richMapping && Object.keys(richMapping).length > 0) {
      // Use the UI-configured mapping
      Object.entries(richMapping).forEach(([placeholder, contextKey]) => {
        if (!placeholder.startsWith('button_')) {
          const idx = placeholder.replace(/\D/g, ''); // '{{1}}' → '1'
          let val = context[contextKey] || '';
          if (!val) val = getContextFallback(contextKey);
          processedParamsBody[idx] = val;
        }
      });
    } else {
      // Legacy: comma-separated list of context keys → {{1}}, {{2}}…
      const mapping = mappingStr.split(',').map(s => s.trim()).filter(Boolean);
      mapping.forEach((key, i) => {
        let val = context[key] || '';
        if (!val) val = getContextFallback(key);
        processedParamsBody[String(i + 1)] = val;
      });
    }

    assertParamsComplete(processedParamsBody, template.bodyParamCount);

    // ── Build button params ──────────────────────────────────────────────
    const processedParamsButtons = buildTemplateButtonParams(template.buttons, context, richMapping);

    const content = renderTemplateBody(template.body, processedParamsBody);
    if (!content) throw new Error(`WhatsApp template "${template.name}" has no body content — not sending`);

    const processedParams = { body: processedParamsBody };
    if (processedParamsButtons) processedParams.buttons = processedParamsButtons;

    const msgUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    const msgBody = {
      message_type: 'outgoing',
      content,
      template_params: {
        name: template.name,
        category: template.category,
        language: template.language,
        processed_params: processedParams
      }
    };

    step.request = { url: msgUrl, method: 'POST', body: msgBody };
    const msgRes = await fetch(msgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(msgBody) });
    const msgResBody = await msgRes.json();
    step.response = { status: msgRes.status, body: msgResBody };

    if (!msgRes.ok) throw new Error(`Send WhatsApp failed: ${msgRes.status} — ${JSON.stringify(msgResBody)}`);
    if (dedupeKey) await markNotificationSent(dedupeKey, msgResBody.id);
    return { ok: true, response: { status: msgRes.status, body: msgResBody }, chatwootMessageId: msgResBody.id };
  } catch (err) {
    if (dedupeKey) await markNotificationFailed(dedupeKey);
    return { ok: false, error: err.message, response: step.response };
  }
}

/** Default fallback values for common context fields when empty. */
function getContextFallback(key) {
  const fallbacks = {
    trackingUrl: 'https://stomatalfarms.com',
    trackingCompany: 'Manual',
    trackingNumber: 'Shipped',
    abandonedCheckoutUrl: 'https://stomatalfarms.com/checkout',
    orderStatusUrl: 'https://stomatalfarms.com',
  };
  return fallbacks[key] || '';
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

  // Checkout messages must respect the delays, template, and variable mappings
  // configured in Recovery Flows. This also protects test runs and old retry
  // jobs from falling back to the abandoned-cart fields formerly in Settings.
  if (isCheckout) {
    return {
      status: 'success',
      orderDetails: context,
      steps: [{
        name: 'Recovery Flow Routing',
        status: 'success',
        response: { note: 'Checkout messaging is managed exclusively by Recovery Flows.' }
      }],
      skipped: true,
      skipReason: 'recovery_flow_managed'
    };
  }

  const settings = await getAllSettings();
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const token = settings.CHATWOOT_API_TOKEN;
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = parseInt(settings.CHATWOOT_INBOX_ID || '1', 10);
  const templateName = isFulfillment ? settings.WHATSAPP_SHIPPING_TEMPLATE_NAME : settings.WHATSAPP_TEMPLATE_NAME;
  const templateMapping = isFulfillment ? settings.WHATSAPP_SHIPPING_TEMPLATE_MAPPING : settings.WHATSAPP_TEMPLATE_MAPPING;

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

  // Dedupe by which TEMPLATE gets sent, not the raw Shopify topic: orders/create
  // and orders/paid both send the same order-confirmation template below, and
  // Shopify fires both within seconds for prepaid orders — without this, the
  // customer gets two copies of the identical message.
  const templateBucket = isFulfillment ? 'fulfillment' : 'order';
  const dedupeKey = buildDedupeKey('legacy', templateBucket, context);

  try {
    let orderDetails = null;
    let contactId = null;
    let conversationId = null;
    let template = null;

    orderDetails = await runStep('Extract Details', async (step) => {
      step.request = { body: rawBody, topic: detectedTopic };
      step.response = { body: context };
      return context;
    });

    // ── Skip contacts with no phone — WhatsApp requires a phone number ──────
    if (!context.phone) {
      console.log(`[Pipeline] Skipping "${context.fullName}" — no phone number available`);
      return { status: 'success', orderDetails: context, steps, skipped: true, skipReason: 'no_phone' };
    }

    template = await runStep('Validate WhatsApp Template', async (step) => {
      if (!apiBaseUrl || !token) throw new Error('Chatwoot API not configured in Settings');
      const definition = await requireApprovedTemplate(settings, templateName);
      step.response = {
        template: definition.name,
        status: definition.status,
        bodyParameters: definition.bodyParamCount,
        dynamicButtons: definition.buttons.length
      };
      return definition;
    });

    const claimed = await runStep('Idempotency Check', async (step) => {
      const ok = await claimNotification(dedupeKey);
      step.response = { dedupeKey, claimed: ok, note: ok ? 'Proceeding — first attempt for this order' : 'Skipped — a message was already sent for this order' };
      return ok;
    });

    if (!claimed) {
      return { status: 'success', orderDetails: context, steps, skipped: true };
    }

    contactId = await runStep('Resolve Contact', async (step) => {
      step.request = { method: 'resolveContactId', name: context.fullName, phone: context.phone, email: context.email };
      const resolvedId = await resolveContactId({
        apiBaseUrl, accountId, token, inboxId,
        name: context.fullName, phone: context.phone, email: context.email, sourceId: context.sourceId
      });
      if (!resolvedId) throw new Error('No contact ID returned');
      step.response = { note: `Resolved contact ID: ${resolvedId}` };
      return resolvedId;
    });

    conversationId = await runStep('Resolve Conversation', async (step) => {
      const conversation = await resolveConversationId({
        apiBaseUrl, accountId, token, inboxId, contactId,
        sourceId: context.sourceId, settings
      });
      step.response = {
        conversationId: conversation.id,
        note: conversation.reused ? 'Reused existing open conversation' : 'Created new conversation'
      };
      return conversation.id;
    });

    const sendResult = await runStep('Send WhatsApp Template', async (step) => {
      const mapping = (templateMapping || '').split(',').map(s => s.trim()).filter(Boolean);
      const processedParamsBody = {};
      mapping.forEach((key, i) => {
        let val = context[key] || '';
        if (!val && key === 'trackingUrl') val = 'https://stomatalfarms.com';
        if (!val && key === 'abandonedCheckoutUrl') val = 'https://stomatalfarms.com/checkout';
        processedParamsBody[String(i + 1)] = val;
      });

      assertParamsComplete(processedParamsBody, template.bodyParamCount);

      // Build button params — supply the checkout/order URL for dynamic-URL buttons
      const processedParamsButtons = buildTemplateButtonParams(template.buttons, context);

      const processedParams = { body: processedParamsBody };
      if (processedParamsButtons) processedParams.buttons = processedParamsButtons;

      const content = renderTemplateBody(template.body, processedParamsBody);
      if (!content) throw new Error(`WhatsApp template "${template.name}" has no body content — not sending`);
      const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
      const body = {
        message_type: 'outgoing',
        content,
        template_params: {
          name: template.name,
          category: template.category,
          language: template.language,
          processed_params: processedParams
        }
      };
      step.request = { url, method: 'POST', body };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: token }, body: JSON.stringify(body) });
      const resBody = await res.json();
      step.response = { status: res.status, body: resBody };
      if (!res.ok) throw new Error(`Send WhatsApp failed: ${res.status} — ${JSON.stringify(resBody)}`);
      return resBody;
    });

    await markNotificationSent(dedupeKey, sendResult.id);
    return { status: 'success', orderDetails: context, steps, chatwootMessageId: sendResult.id };
  } catch (error) {
    await markNotificationFailed(dedupeKey);
    return { status: 'failed', orderDetails: context, steps, errorMessage: error.message };
  }
}
