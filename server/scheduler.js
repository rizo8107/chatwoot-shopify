import { getPendingJobs, markJobStatus, getFlowById, logTransaction, getTransactionById } from './db.js';
import { executeFlowNode } from './chatwoot.js';

let schedulerTimer = null;

export function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(runPendingJobs, 30_000);
  console.log('[Scheduler] Started — polling every 30 seconds');
  // Run once immediately on start to pick up any missed jobs
  runPendingJobs().catch(err => console.error('[Scheduler] Initial run error:', err));
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[Scheduler] Stopped');
  }
}

async function runPendingJobs() {
  let jobs;
  try {
    jobs = await getPendingJobs();
  } catch (err) {
    console.error('[Scheduler] Failed to get pending jobs:', err.message);
    return;
  }

  if (jobs.length > 0) {
    console.log(`[Scheduler] Processing ${jobs.length} pending job(s)`);
  }

  for (const job of jobs) {
    await processJob(job);
  }
}

async function processJob(job) {
  const { id, flow_id, transaction_id, node_id, context } = job;

  try {
    await markJobStatus(id, 'running');

    // Load the flow
    const flow = await getFlowById(flow_id);
    if (!flow) {
      await markJobStatus(id, 'failed', `Flow ${flow_id} not found`);
      console.warn(`[Scheduler] Job ${id}: flow ${flow_id} not found`);
      return;
    }

    // Find the node to execute
    const node = flow.nodes.find(n => n.id === node_id);
    if (!node) {
      await markJobStatus(id, 'failed', `Node ${node_id} not found in flow`);
      console.warn(`[Scheduler] Job ${id}: node ${node_id} not found`);
      return;
    }

    // Load existing transaction steps
    const tx = await getTransactionById(transaction_id);
    const steps = tx?.steps || [];

    // Execute the node
    const { executeFlow } = await import('./chatwoot.js');
    const result = await executeFlow(
      flow,
      { ...context },
      node_id
    );

    // Append new steps to existing
    const allSteps = [...steps, ...result.steps];

    if (result.status === 'delayed') {
      // Schedule the next job
      const nextRunAt = new Date(Date.now() + result.delayMs).toISOString();
      const { scheduleJob } = await import('./db.js');
      const nextJobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await scheduleJob({
        id: nextJobId,
        flow_id,
        transaction_id,
        node_id: result.nextNodeId,
        context: result.context || context,
        run_at: nextRunAt
      });

      await logTransaction({
        id: transaction_id,
        flow_id,
        order_number: context.orderNumber,
        customer_name: context.fullName,
        phone_number: context.phone,
        status: 'processing',
        type: 'flow',
        steps: allSteps,
        error_message: null
      });

      console.log(`[Scheduler] Job ${id}: delayed step done, next job ${nextJobId} at ${nextRunAt}`);
    } else if (result.status === 'success') {
      await logTransaction({
        id: transaction_id,
        flow_id,
        order_number: context.orderNumber,
        customer_name: context.fullName,
        phone_number: context.phone,
        status: 'success',
        type: 'flow',
        steps: allSteps,
        error_message: null
      });
      console.log(`[Scheduler] Job ${id}: flow completed successfully`);
    } else {
      await logTransaction({
        id: transaction_id,
        flow_id,
        order_number: context.orderNumber,
        customer_name: context.fullName,
        phone_number: context.phone,
        status: 'failed',
        type: 'flow',
        steps: allSteps,
        error_message: result.errorMessage || 'Unknown error'
      });
      console.error(`[Scheduler] Job ${id}: flow failed — ${result.errorMessage}`);
    }

    await markJobStatus(id, 'done');
  } catch (err) {
    console.error(`[Scheduler] Job ${id} threw error:`, err.message);
    await markJobStatus(id, 'failed', err.message).catch(() => {});
    // Update transaction as failed
    try {
      const tx = await getTransactionById(transaction_id);
      await logTransaction({
        id: transaction_id,
        flow_id,
        order_number: context.orderNumber,
        customer_name: context.fullName,
        phone_number: context.phone,
        status: 'failed',
        type: 'flow',
        steps: tx?.steps || [],
        error_message: err.message
      });
    } catch (_) {}
  }
}
