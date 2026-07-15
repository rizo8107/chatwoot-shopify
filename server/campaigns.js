import crypto from 'node:crypto';
import {
  getAllSettings,
  getDueCampaignRecipients,
  markRecipientStatus,
  advanceCampaignRecipient,
  incrementCampaignCounter,
  finalizeCampaignIfDone,
  logCampaignMessage,
  logTransaction,
  getWebhookDripCampaigns,
  enrollCampaignRecipient
} from './db.js';
import {
  normalizePhone, getTemplateBody, getTemplateButtons, renderTemplateBody,
  resolveContactId, buildConversationBody, buildTemplateButtonParams
} from './chatwoot.js';
import { checkShopifyOrder, normalizeShop } from './shopify.js';

let processing = false;

function contextValue(context, field) {
  return String(field || '').split('.').reduce((value, part) => value?.[part], context);
}

export function matchesDripConditions(conditions = [], context = {}) {
  return conditions.every(condition => {
    const actual = contextValue(context, condition.field);
    const expected = condition.value;
    switch (condition.operator) {
      case 'not_exists': return actual === undefined || actual === null || actual === '';
      case 'equals': return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
      case 'not_equals': return String(actual ?? '').toLowerCase() !== String(expected ?? '').toLowerCase();
      case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
      case 'greater_than': return Number(actual) > Number(expected);
      case 'less_than': return Number(actual) < Number(expected);
      case 'exists':
      default: return actual !== undefined && actual !== null && actual !== '';
    }
  });
}

function webhookEnrollmentId(campaignId, topic, context) {
  const identity = context.orderId || context.orderNumber || context.orderName || context.checkoutId || context.email || context.phone;
  return `cmpenr_${crypto.createHash('sha256').update(`${campaignId}|${topic}|${identity || JSON.stringify(context)}`).digest('hex').slice(0, 24)}`;
}

/** Enroll matching Shopify webhook events into all active drip campaigns. */
export async function enrollWebhookDripCampaigns(topic, context) {
  const campaigns = await getWebhookDripCampaigns(topic);
  const results = [];
  for (const campaign of campaigns) {
    const recipientId = webhookEnrollmentId(campaign.id, topic, context);
    const logBase = {
      campaign_id: campaign.id,
      recipient_id: recipientId,
      step_index: -1,
      template_name: null,
      shopify_status: `${context.financialStatus || 'UNKNOWN'}/${context.fulfillmentStatus || 'UNKNOWN'}`
    };

    if (!matchesDripConditions(campaign.trigger_conditions, context)) {
      await logCampaignMessage({ ...logBase, id: `${recipientId}_filtered`, status: 'filtered', details: { topic, conditions: campaign.trigger_conditions, context } });
      results.push({ campaignId: campaign.id, enrolled: false, reason: 'conditions_not_met' });
      continue;
    }

    if (!context.phone) {
      await logCampaignMessage({ ...logBase, id: `${recipientId}_missing_phone`, status: 'failed', error_message: 'Webhook matched, but the Shopify customer has no phone number', details: { topic, context } });
      results.push({ campaignId: campaign.id, enrolled: false, reason: 'missing_phone' });
      continue;
    }

    const stepVariables = campaign.steps.map(step => {
      const values = {};
      (step.param_mapping || []).forEach((field, index) => {
        values[String(index + 1)] = field ? String(contextValue(context, field) ?? '') : '';
      });
      return values;
    });
    const enrolled = await enrollCampaignRecipient({
      id: recipientId, campaign, phone: context.phone, name: context.fullName,
      email: context.email, order_reference: context.orderName || context.orderNumber,
      variables: stepVariables[0] || {}, step_variables: stepVariables
    });
    if (enrolled) {
      await logCampaignMessage({ ...logBase, id: `${recipientId}_enrolled`, status: 'enrolled', details: { topic, orderNumber: context.orderNumber, conditions: campaign.trigger_conditions } });
    }
    results.push({ campaignId: campaign.id, enrolled, reason: enrolled ? 'enrolled' : 'duplicate' });
  }
  return results;
}

/**
 * Poll tick: send any campaign recipients that are due (run_at <= now and
 * their campaign is 'running'). Guarded so overlapping ticks never double-send.
 */
export async function processDueCampaignMessages() {
  if (processing) return;
  processing = true;
  try {
    const due = await getDueCampaignRecipients(20);
    if (due.length === 0) return;
    const settings = await getAllSettings();
    for (const recipient of due) {
      await sendOne(recipient, settings);
    }
  } catch (err) {
    console.error('[Campaign] tick error:', err.message);
  } finally {
    processing = false;
  }
}

async function sendOne(recipient, settings) {
  const legacyVariables = typeof recipient.variables === 'string'
    ? JSON.parse(recipient.variables || '{}')
    : (recipient.variables || {});
  const stepVariables = typeof recipient.step_variables === 'string'
    ? JSON.parse(recipient.step_variables || '[]')
    : (recipient.step_variables || []);
  const configuredSteps = typeof recipient.steps === 'string'
    ? JSON.parse(recipient.steps || '[]')
    : (recipient.steps || []);
  const steps = configuredSteps.length > 0 ? configuredSteps : [{
    template_name: recipient.template_name,
    language: recipient.language,
    category: recipient.category,
    delay_value: 0,
    delay_unit: 'minutes'
  }];
  const stepIndex = Number(recipient.current_step || 0);
  const campaignStep = steps[stepIndex];
  const campaignId = recipient.campaign_id;
  const txId = `cmp_${recipient.id}_s${stepIndex}`;
  const logId = `${txId}_log`;
  const variables = stepVariables[stepIndex] || legacyVariables;
  let shopifyCheck = null;

  try {
    if (!recipient.phone) throw new Error('No valid phone number');
    if (!campaignStep) throw new Error(`Drip step ${stepIndex + 1} is not configured`);

    if (recipient.shopify_check_mode && recipient.shopify_check_mode !== 'off') {
      if (!recipient.order_reference && !recipient.email) {
        throw new Error('Shopify cross-check requires an order number or email for this recipient');
      }
      shopifyCheck = await checkShopifyOrder({
        shop: normalizeShop(settings.SHOPIFY_STORE_URL),
        token: settings.SHOPIFY_ADMIN_TOKEN,
        orderReference: recipient.order_reference,
        email: recipient.email
      });

      const stop = recipient.shopify_check_mode === 'stop_if_order_found'
        ? shopifyCheck.matched
        : shopifyCheck.shouldStop;
      if (stop) {
        const reason = `Drip stopped after Shopify cross-check: ${shopifyCheck.status}`;
        await markRecipientStatus(recipient.id, 'skipped', reason);
        await incrementCampaignCounter(campaignId, 'skipped');
        await logCampaignMessage({
          id: logId, campaign_id: campaignId, recipient_id: recipient.id,
          step_index: stepIndex, template_name: campaignStep.template_name,
          status: 'skipped', shopify_status: shopifyCheck.status,
          details: { reason, order: shopifyCheck.order }
        });
        await logTransaction({
          id: txId, flow_id: null,
          order_number: recipient.order_reference || shopifyCheck.order?.name || null,
          customer_name: recipient.name, phone_number: recipient.phone,
          status: 'success', type: 'campaign', steps: [{
            name: 'Shopify Order Cross-check', status: 'skipped',
            response: { reason, shopify: shopifyCheck }
          }], error_message: null
        });
        console.log(`[Campaign] Stopped drip for ${recipient.phone}: ${shopifyCheck.status}`);
        await finalizeCampaignIfDone(campaignId);
        return;
      }
    }

    const result = await sendTemplateMessage({
      phone: recipient.phone,
      name: recipient.name || recipient.phone,
      email: recipient.email || '',
      templateName: campaignStep.template_name || recipient.template_name,
      language: campaignStep.language || recipient.language,
      category: campaignStep.category || recipient.category,
      processedParams: variables,
      settings
    });

    const hasNextStep = stepIndex + 1 < steps.length;
    if (hasNextStep) {
      const next = steps[stepIndex + 1];
      const amount = Math.max(0, Number(next.delay_value || 0));
      const multiplier = next.delay_unit === 'days' ? 86400000 : next.delay_unit === 'hours' ? 3600000 : 60000;
      await advanceCampaignRecipient(recipient.id, stepIndex + 1, new Date(Date.now() + amount * multiplier).toISOString(), shopifyCheck?.status || null);
    } else {
      await markRecipientStatus(recipient.id, 'sent', null);
      await incrementCampaignCounter(campaignId, 'sent');
    }
    await logCampaignMessage({
      id: logId, campaign_id: campaignId, recipient_id: recipient.id,
      step_index: stepIndex, template_name: campaignStep.template_name || recipient.template_name,
      status: 'sent', shopify_status: shopifyCheck?.status,
      chatwoot_message_id: result.chatwootMessageId,
      details: { contactId: result.contactId, conversationId: result.conversationId, nextStep: hasNextStep ? stepIndex + 1 : null }
    });
    await logTransaction({
      id: txId, flow_id: null,
      order_number: recipient.order_reference || variables['1'] || null, customer_name: recipient.name, phone_number: recipient.phone,
      status: 'success', type: 'campaign', steps: [
        ...(shopifyCheck ? [{ name: 'Shopify Order Cross-check', status: 'success', response: shopifyCheck }] : []),
        result.step
      ], error_message: null
    });
    console.log(`[Campaign] Sent step ${stepIndex + 1}/${steps.length} to ${recipient.phone} (campaign ${campaignId})`);
  } catch (err) {
    await markRecipientStatus(recipient.id, 'failed', err.message);
    await incrementCampaignCounter(campaignId, 'failed');
    await logCampaignMessage({
      id: logId, campaign_id: campaignId, recipient_id: recipient.id,
      step_index: stepIndex, template_name: campaignStep?.template_name || recipient.template_name,
      status: 'failed', shopify_status: shopifyCheck?.status,
      error_message: err.message, details: { shopify: shopifyCheck }
    });
    await logTransaction({
      id: txId, flow_id: null,
      order_number: recipient.order_reference || variables['1'] || null, customer_name: recipient.name, phone_number: recipient.phone,
      status: 'failed', type: 'campaign', steps: [], error_message: err.message
    });
    console.error(`[Campaign] Failed for ${recipient.phone}: ${err.message}`);
  }

  await finalizeCampaignIfDone(campaignId);
}

/**
 * Send one WhatsApp template message through Chatwoot.
 * Reuses an existing contact if found (so existing contacts are messaged,
 * not skipped), otherwise creates one, then opens a conversation and sends.
 */
export async function sendTemplateMessage({ phone, name, email, templateName, language, category, processedParams, settings }) {
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const token = settings.CHATWOOT_API_TOKEN;
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = parseInt(settings.CHATWOOT_INBOX_ID || '1', 10);

  if (!apiBaseUrl || !token) throw new Error('Chatwoot API not configured in Settings');
  if (!templateName) throw new Error('No WhatsApp template name configured');

  const { sourceId } = normalizePhone(phone, '');

  // 1. Find or create contact — reuses an existing contact (by phone or email),
  //    so already-existing contacts are messaged, never skipped.
  const contactId = await resolveContactId({ apiBaseUrl, accountId, token, inboxId, name, phone, email, sourceId });
  if (!contactId) throw new Error('Could not find or create contact');

  // 2. Open a conversation
  const convUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations`;
  const convBody = buildConversationBody({ contactId, inboxId, sourceId, settings });
  const convRes = await fetch(convUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_access_token: token },
    body: JSON.stringify(convBody)
  });
  const convResBody = await convRes.json();
  if (!convRes.ok) throw new Error(`Create conversation failed: ${convRes.status}`);
  const conversationId = convResBody.id;
  if (!conversationId) throw new Error('No conversation ID returned');

  // 3. Send the template message — render the real template body so the
  //    message reads exactly like the approved template.
  const templateBody = await getTemplateBody(settings, templateName);
  const content = renderTemplateBody(templateBody, processedParams) || `Template: ${templateName}`;

  // Build button params — if the template has dynamic-URL buttons, supply the URL
  // from processedParams or a sensible fallback.
  const templateButtons = await getTemplateButtons(settings, templateName);
  const processedParamsButtons = buildTemplateButtonParams(templateButtons, {
    abandonedCheckoutUrl: processedParams?.checkoutUrl || processedParams?.url
  });

  const finalProcessedParams = { body: processedParams || {} };
  if (processedParamsButtons) finalProcessedParams.buttons = processedParamsButtons;

  const msgUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const msgBody = {
    message_type: 'outgoing',
    content,
    template_params: {
      name: templateName,
      category: category || 'MARKETING',
      language: language || 'en',
      processed_params: finalProcessedParams
    }
  };
  const msgRes = await fetch(msgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_access_token: token },
    body: JSON.stringify(msgBody)
  });
  const msgResBody = await msgRes.json();
  if (!msgRes.ok) throw new Error(`Send WhatsApp failed: ${msgRes.status} ${JSON.stringify(msgResBody)}`);

  return {
    contactId,
    conversationId,
    chatwootMessageId: msgResBody.id || msgResBody.message?.id || null,
    step: {
      name: 'Send WhatsApp Template',
      status: 'success',
      request: { url: msgUrl, body: msgBody },
      response: { status: msgRes.status, body: msgResBody }
    }
  };
}
