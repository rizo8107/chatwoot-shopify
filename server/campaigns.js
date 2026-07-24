import crypto from 'node:crypto';
import {
  getAllSettings,
  getDueCampaignRecipients,
  getPendingCampaignDeliveries,
  markRecipientStatus,
  incrementCampaignCounter,
  finalizeCampaignIfDone,
  logCampaignMessage,
  logTransaction,
  setTransactionChatwootMessageId,
  getWebhookDripCampaigns,
  enrollCampaignRecipient,
  updateDeliveryStatusByMessageId
} from './db.js';
import {
  normalizePhone, renderTemplateBody, resolveContactId, resolveConversationId,
  resolveContactByUniqueExactName, buildTemplateButtonParams, buildTemplateHeaderParams,
  requireApprovedTemplate, assertParamsComplete
} from './chatwoot.js';
import { checkShopifyOrder, normalizeShop } from './shopify.js';

let processing = false;
let reconcilingDeliveries = false;

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
      if (step.header_media_url) values.__header_media_url = step.header_media_url;
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

/** Poll Chatwoot as a fallback when a message_updated webhook is delayed or missed. */
export async function reconcileCampaignDeliveryStatuses({
  getPending = getPendingCampaignDeliveries,
  getSettings = getAllSettings,
  updateStatus = updateDeliveryStatusByMessageId
} = {}) {
  if (reconcilingDeliveries) return;
  reconcilingDeliveries = true;
  try {
    const pending = await getPending(100);
    if (pending.length === 0) return;
    const settings = await getSettings();
    const apiBaseUrl = String(settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
    const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
    const token = settings.CHATWOOT_API_TOKEN;
    if (!apiBaseUrl || !token) return;

    const byConversation = new Map();
    for (const item of pending) {
      if (!item.conversation_id) continue;
      const key = String(item.conversation_id);
      if (!byConversation.has(key)) byConversation.set(key, []);
      byConversation.get(key).push(item);
    }

    for (const [conversationId, items] of byConversation) {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
          { headers: { api_access_token: token } }
        );
        if (!response.ok) continue;
        const body = await response.json();
        const messages = Array.isArray(body) ? body : (body.payload || []);
        const messagesById = new Map(messages.map(message => [String(message.id), message]));
        for (const item of items) {
          const message = messagesById.get(String(item.chatwoot_message_id));
          if (!message || !['sent', 'delivered', 'read', 'failed'].includes(message.status)) continue;
          const error = message.content_attributes?.external_error
            || message.content_attributes?.external_error_message
            || message.external_error
            || null;
          await updateStatus(message.id, message.status, error);
        }
      } catch (error) {
        console.warn(`[Campaign] Delivery reconciliation failed for conversation ${conversationId}: ${error.message}`);
      }
    }
  } finally {
    reconcilingDeliveries = false;
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
  const bodyVariables = Object.fromEntries(
    Object.entries(variables).filter(([key]) => /^\d+$/.test(key))
  );
  const headerMediaUrl = variables.__header_media_url || campaignStep?.header_media_url || '';
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
      processedParams: bodyVariables,
      headerMediaUrl,
      settings
    });

    const hasNextStep = stepIndex + 1 < steps.length;
    await markRecipientStatus(recipient.id, 'accepted', null);
    await logCampaignMessage({
      id: logId, campaign_id: campaignId, recipient_id: recipient.id,
      step_index: stepIndex, template_name: campaignStep.template_name || recipient.template_name,
      status: 'accepted', shopify_status: shopifyCheck?.status,
      chatwoot_message_id: result.chatwootMessageId,
      details: { contactId: result.contactId, conversationId: result.conversationId, nextStep: hasNextStep ? stepIndex + 1 : null }
    });
    await logTransaction({
      id: txId, flow_id: null,
      order_number: recipient.order_reference || bodyVariables['1'] || null, customer_name: recipient.name, phone_number: recipient.phone,
      status: 'processing', type: 'campaign', steps: [
        ...(shopifyCheck ? [{ name: 'Shopify Order Cross-check', status: 'success', response: shopifyCheck }] : []),
        result.step
      ], error_message: null
    });
    if (result.chatwootMessageId) {
      await setTransactionChatwootMessageId(txId, result.chatwootMessageId);
      if (['sent', 'delivered', 'read', 'failed'].includes(result.messageStatus)) {
        await updateDeliveryStatusByMessageId(
          result.chatwootMessageId,
          result.messageStatus,
          result.deliveryError
        );
      }
    }
    console.log(`[Campaign] Chatwoot accepted step ${stepIndex + 1}/${steps.length} for ${recipient.phone} (campaign ${campaignId})`);
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
      order_number: recipient.order_reference || bodyVariables['1'] || null, customer_name: recipient.name, phone_number: recipient.phone,
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
export async function sendTemplateMessage({ phone, name, email, templateName, language, category, processedParams, headerMediaUrl, settings }) {
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const token = settings.CHATWOOT_API_TOKEN;
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = parseInt(settings.CHATWOOT_INBOX_ID || '1', 10);

  if (!apiBaseUrl || !token) throw new Error('Chatwoot API not configured in Settings');
  const template = await requireApprovedTemplate(settings, templateName);
  assertParamsComplete(processedParams || {}, template.bodyParamCount);

  const normalizedPhone = normalizePhone(phone, '');
  let sourceId = normalizedPhone.sourceId;

  // 1. Find or create contact — reuses an existing contact (by phone or email),
  //    so already-existing contacts are messaged, never skipped.
  let contactId;
  if (!normalizedPhone.formattedPhone) {
    const recovered = await resolveContactByUniqueExactName(apiBaseUrl, accountId, token, inboxId, name);
    if (!recovered) {
      const reason = normalizedPhone.invalidReason === 'scientific_notation'
        ? 'Phone number was converted to scientific notation by Excel. Format the phone column as Text and upload the CSV again.'
        : 'Phone number is invalid. Use 10–15 digits including the country code.';
      throw new Error(reason);
    }
    contactId = recovered.id;
    sourceId = recovered.sourceId;
  } else {
    contactId = await resolveContactId({ apiBaseUrl, accountId, token, inboxId, name, phone, email, sourceId });
  }
  if (!contactId) throw new Error('Could not find or create contact');

  // 2. Reuse the latest open conversation instead of creating duplicates.
  const conversation = await resolveConversationId({
    apiBaseUrl, accountId, token, inboxId, contactId, sourceId, settings
  });
  const conversationId = conversation.id;

  // 3. Send the template message — render the real template body so the
  //    message reads exactly like the approved template.
  const content = renderTemplateBody(template.body, processedParams);
  if (!content) throw new Error(`WhatsApp template "${template.name}" has no body content — not sending`);

  // Build button params — if the template has dynamic-URL buttons, supply the URL
  // from processedParams or a sensible fallback.
  const processedParamsButtons = buildTemplateButtonParams(template.buttons, {
    abandonedCheckoutUrl: processedParams?.checkoutUrl || processedParams?.url
  });

  const finalProcessedParams = { body: processedParams || {} };
  const processedParamsHeader = buildTemplateHeaderParams(template.header, headerMediaUrl);
  if (processedParamsHeader) finalProcessedParams.header = processedParamsHeader;
  if (processedParamsButtons) finalProcessedParams.buttons = processedParamsButtons;

  const msgUrl = `${apiBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const msgBody = {
    message_type: 'outgoing',
    content,
    template_params: {
      name: template.name,
      category: template.category || category || 'MARKETING',
      language: template.language || language || 'en',
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
    messageStatus: msgResBody.status || msgResBody.message?.status || 'sent',
    deliveryError: msgResBody.content_attributes?.external_error
      || msgResBody.content_attributes?.external_error_message
      || msgResBody.external_error
      || null,
    step: {
      name: 'Send WhatsApp Template',
      status: 'success',
      request: { url: msgUrl, body: msgBody, conversationReused: conversation.reused },
      response: { status: msgRes.status, body: msgResBody }
    }
  };
}
