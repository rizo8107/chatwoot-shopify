// ─── Abandoned Cart Recovery Engine ─────────────────────────────────────────
// Executes the flows built in the "Recovery Flows" UI (abandoned_cart_flows):
// when a live cart is captured, one job is scheduled per flow message at
// abandoned_at + delay_minutes; a scheduler tick sends due jobs and every job
// re-checks the cart at send time, so carts recovered in the meantime are
// never messaged.

import {
  getAllSettings,
  getAbandonedCartFlows,
  getAbandonedCartFlowById,
  getAbandonedCartByToken,
  scheduleAbandonedCartJob,
  getDueAbandonedCartJobs,
  updateAbandonedCartJob,
  cancelAbandonedCartJobsForToken,
  markCartRecoveredByToken,
  logTransaction,
  setTransactionChatwootMessageId
} from './db.js';
import { sendWhatsAppTemplate, normalizePhone } from './chatwoot.js';

let processing = false;

/** Schedule every active recovery flow's messages for a just-captured cart. */
export async function scheduleRecoveryForCart(checkoutToken) {
  if (!checkoutToken) return 0;
  const cart = await getAbandonedCartByToken(checkoutToken);
  if (!cart || cart.status !== 'abandoned') return 0;

  const flows = (await getAbandonedCartFlows()).filter(f => f.is_active);
  if (flows.length === 0) return 0;

  const anchor = new Date(cart.abandoned_at || cart.created_at).getTime();
  let scheduled = 0;

  for (const flow of flows) {
    for (const msg of flow.messages || []) {
      if (!msg.template_name) continue;
      const runAt = new Date(anchor + (parseInt(msg.delay_minutes, 10) || 0) * 60_000).toISOString();
      const created = await scheduleAbandonedCartJob({
        cart_id: cart.id,
        checkout_token: cart.checkout_token,
        flow_id: flow.id,
        sequence_order: msg.sequence_order,
        template_name: msg.template_name,
        variable_mapping: msg.variable_mapping || {},
        run_at: runAt
      });
      if (created) scheduled++;
    }
  }

  if (scheduled > 0) {
    console.log(`[Recovery] Scheduled ${scheduled} follow-up(s) for cart ${cart.checkout_token}`);
  }
  return scheduled;
}

/** Customer completed the order — stop all pending follow-ups for that checkout. */
export async function cancelRecoveryForOrder(checkoutToken) {
  if (!checkoutToken) return;
  const recovered = await markCartRecoveredByToken(checkoutToken);
  const cancelled = await cancelAbandonedCartJobsForToken(checkoutToken);
  if (recovered || cancelled > 0) {
    console.log(`[Recovery] Checkout ${checkoutToken} completed — marked recovered, cancelled ${cancelled} pending follow-up(s)`);
  }
}

/** Build the template context the Recovery Flow variable mappings draw from. */
export function buildCartContext(cart) {
  const rawName = (cart.customer_name || '').trim();
  const hasUsefulName = rawName && !rawName.includes('@') && !/^customer$/i.test(rawName);
  const fullName = hasUsefulName ? rawName : 'Customer';
  const firstName = hasUsefulName ? fullName.split(/\s+/)[0] : 'there';
  const { formattedPhone, sourceId } = normalizePhone(cart.customer_phone, `cart-${cart.checkout_token}`);
  const items = Array.isArray(cart.cart_items) ? cart.cart_items : [];
  const itemsSummary = items.map(i => `${i.title} x${i.quantity} @ INR ${i.price}`).join(', ') || 'your items';
  const total = Number(cart.cart_total_price);
  const checkoutDateValue = cart.abandoned_at || cart.created_at;
  const checkoutDate = Number.isNaN(new Date(checkoutDateValue).getTime())
    ? ''
    : new Date(checkoutDateValue).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });

  return {
    type: 'checkout',
    fullName: fullName || 'Customer',
    firstName,
    lastName: fullName.split(/\s+/).slice(1).join(' '),
    phone: formattedPhone,
    sourceId,
    email: cart.customer_email || '',
    itemsSummary,
    totalPrice: Number.isFinite(total) ? `INR ${total.toFixed(2)}` : String(cart.cart_total_price || ''),
    abandonedCheckoutUrl: cart.shopify_checkout_url || '',
    checkoutDate,
    checkoutId: cart.checkout_token,
    orderNumber: cart.checkout_token,
    orderName: `Cart ${String(cart.checkout_token).slice(0, 8)}`
  };
}

/** Scheduler tick: send every due recovery message. */
export async function processDueRecoveryJobs() {
  if (processing) return;
  processing = true;
  try {
    const jobs = await getDueAbandonedCartJobs(10);
    for (const job of jobs) await runJob(job);
  } catch (err) {
    console.error('[Recovery] tick error:', err.message);
  } finally {
    processing = false;
  }
}

async function runJob(job) {
  try {
    // Jobs keep a snapshot for auditability, but the active flow definition is
    // authoritative at send time. This makes pause/delete/edit take effect
    // even if a scheduler fetched the job just before the UI change.
    const flow = await getAbandonedCartFlowById(job.flow_id);
    if (!flow || !flow.is_active) {
      await updateAbandonedCartJob(job.id, {
        status: 'cancelled',
        error_message: flow ? 'Recovery flow is paused' : 'Recovery flow was deleted'
      });
      return;
    }
    const configuredMessage = (flow.messages || []).find(
      message => Number(message.sequence_order) === Number(job.sequence_order)
    );
    if (!configuredMessage?.template_name) {
      await updateAbandonedCartJob(job.id, {
        status: 'cancelled',
        error_message: 'Message was removed from the recovery flow'
      });
      return;
    }

    const cart = await getAbandonedCartByToken(job.checkout_token);
    if (!cart) {
      await updateAbandonedCartJob(job.id, { status: 'skipped', error_message: 'Cart no longer exists' });
      return;
    }
    if (cart.status !== 'abandoned') {
      await updateAbandonedCartJob(job.id, { status: 'cancelled', error_message: 'Cart already recovered' });
      return;
    }

    const context = buildCartContext(cart);
    if (!context.phone) {
      await updateAbandonedCartJob(job.id, { status: 'skipped', error_message: 'No phone number on cart' });
      console.log(`[Recovery] Skipping cart ${job.checkout_token} msg #${job.sequence_order} — no phone number`);
      return;
    }

    const settings = await getAllSettings();
    const step = { name: `Recovery Message #${job.sequence_order}`, status: 'running', startedAt: new Date().toISOString(), request: null, response: null, error: null };
    const dedupeKey = `acr:${job.flow_id}:${job.sequence_order}:${job.checkout_token}`;

    const result = await sendWhatsAppTemplate(
      {
        templateName: configuredMessage.template_name,
        variableMapping: configuredMessage.variable_mapping || {}
      },
      context,
      settings,
      step,
      dedupeKey
    );

    step.status = result.ok ? 'success' : 'failed';
    step.endedAt = new Date().toISOString();

    if (result.ok) {
      await updateAbandonedCartJob(job.id, { status: result.skipped ? 'skipped' : 'sent' });
      if (!result.skipped) {
        console.log(`[Recovery] Sent "${configuredMessage.template_name}" (msg #${job.sequence_order}) to ${context.phone} for cart ${job.checkout_token}`);
      }
    } else {
      await updateAbandonedCartJob(job.id, { status: 'failed', error_message: result.error });
      console.error(`[Recovery] Failed "${configuredMessage.template_name}" (msg #${job.sequence_order}) for cart ${job.checkout_token}: ${result.error}`);
    }

    // Surface in the Logs page alongside webhook/flow/campaign transactions.
    const transactionId = `tx_acr_${job.id}`;
    await logTransaction({
      id: transactionId,
      flow_id: job.flow_id,
      order_number: null,
      customer_name: context.fullName,
      phone_number: context.phone,
      status: result.ok ? (result.skipped ? 'success' : 'success') : 'failed',
      type: 'recovery',
      steps: [step],
      error_message: result.ok ? null : result.error
    });
    if (result.chatwootMessageId) {
      await setTransactionChatwootMessageId(transactionId, result.chatwootMessageId);
    }
  } catch (err) {
    await updateAbandonedCartJob(job.id, { status: 'failed', error_message: err.message }).catch(() => {});
    console.error(`[Recovery] Job ${job.id} unhandled error:`, err.message);
  }
}
