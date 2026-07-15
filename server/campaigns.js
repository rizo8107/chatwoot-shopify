import {
  getAllSettings,
  getDueCampaignRecipients,
  markRecipientStatus,
  incrementCampaignCounter,
  finalizeCampaignIfDone,
  logTransaction
} from './db.js';
import {
  normalizePhone, getTemplateBody, getTemplateButtons, renderTemplateBody,
  resolveContactId, buildConversationBody, buildTemplateButtonParams
} from './chatwoot.js';

let processing = false;

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
  const variables = typeof recipient.variables === 'string'
    ? JSON.parse(recipient.variables || '{}')
    : (recipient.variables || {});
  const campaignId = recipient.campaign_id;
  const txId = `cmp_${recipient.id}`;

  try {
    if (!recipient.phone) throw new Error('No valid phone number');

    const result = await sendTemplateMessage({
      phone: recipient.phone,
      name: recipient.name || recipient.phone,
      email: recipient.email || '',
      templateName: recipient.template_name,
      language: recipient.language,
      category: recipient.category,
      processedParams: variables,
      settings
    });

    await markRecipientStatus(recipient.id, 'sent', null);
    await incrementCampaignCounter(campaignId, 'sent');
    await logTransaction({
      id: txId, flow_id: null,
      order_number: variables['1'] || null, customer_name: recipient.name, phone_number: recipient.phone,
      status: 'success', type: 'campaign', steps: [result.step], error_message: null
    });
    console.log(`[Campaign] Sent to ${recipient.phone} (campaign ${campaignId})`);
  } catch (err) {
    await markRecipientStatus(recipient.id, 'failed', err.message);
    await incrementCampaignCounter(campaignId, 'failed');
    await logTransaction({
      id: txId, flow_id: null,
      order_number: variables['1'] || null, customer_name: recipient.name, phone_number: recipient.phone,
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
    step: {
      name: 'Send WhatsApp Template',
      status: 'success',
      request: { url: msgUrl, body: msgBody },
      response: { status: msgRes.status, body: msgResBody }
    }
  };
}
