import { getDueWebhookRetries, updateWebhookRetry, getFlowById, logTransaction } from './db.js';
import {
  executePipeline, executeFlow,
  extractOrderDetails, extractFulfillmentDetails, extractCheckoutDetails
} from './chatwoot.js';

// Backoff (minutes) by attempt number. Last value repeats if attempts exceed it.
const BACKOFF_MIN = [1, 5, 15, 30, 60];

let processing = false;

/** Poll tick: re-run any failed webhook/flow executions that are due. */
export async function processDueRetries() {
  if (processing) return;
  processing = true;
  try {
    const due = await getDueWebhookRetries(10);
    for (const r of due) await runRetry(r);
  } catch (err) {
    console.error('[Retry] tick error:', err.message);
  } finally {
    processing = false;
  }
}

function unwrap(payload) {
  if (Array.isArray(payload) && payload[0]) return payload[0].body || payload[0];
  if (payload && payload.body) return payload.body;
  return payload;
}

function extractDetails(payload, topic) {
  const rawBody = unwrap(payload);
  const t = topic || 'orders/create';
  if (t.startsWith('checkouts/')) return extractCheckoutDetails(rawBody);
  if (t.startsWith('fulfillments/')) return extractFulfillmentDetails(rawBody);
  return extractOrderDetails(rawBody);
}

async function runRetry(r) {
  const attempt = r.attempts + 1;
  try {
    const details = extractDetails(r.payload, r.topic);
    let result;

    if (r.flow_id) {
      const flow = await getFlowById(r.flow_id);
      if (!flow) {
        await updateWebhookRetry(r.transaction_id, { status: 'exhausted', attempts: attempt });
        return;
      }
      result = await executeFlow(flow, { ...details });
    } else {
      result = await executePipeline(r.payload, r.topic);
    }

    const status = result.status === 'delayed' ? 'processing' : result.status;
    await logTransaction({
      id: r.transaction_id, flow_id: r.flow_id || null,
      order_number: details.orderNumber, customer_name: details.fullName, phone_number: details.phone,
      status, type: r.flow_id ? 'flow' : 'webhook', steps: result.steps, error_message: result.errorMessage || null
    });

    if (status === 'success' || status === 'processing') {
      await updateWebhookRetry(r.transaction_id, { status: 'done', attempts: attempt });
      console.log(`[Retry] ${r.transaction_id} succeeded on attempt ${attempt}`);
    } else {
      await scheduleNext(r, attempt);
    }
  } catch (err) {
    await scheduleNext(r, attempt);
  }
}

async function scheduleNext(r, attempt) {
  if (attempt >= r.max_attempts) {
    await updateWebhookRetry(r.transaction_id, { status: 'exhausted', attempts: attempt });
    console.warn(`[Retry] ${r.transaction_id} exhausted after ${attempt} attempt(s)`);
    return;
  }
  const mins = BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)];
  const runAt = new Date(Date.now() + mins * 60_000).toISOString();
  await updateWebhookRetry(r.transaction_id, { status: 'pending', attempts: attempt, run_at: runAt });
  console.log(`[Retry] ${r.transaction_id} attempt ${attempt} failed — next in ${mins}m`);
}
