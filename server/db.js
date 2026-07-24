import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ─── InsForge (cloud Postgres) connection ────────────────────────────────────
// Data lives in the InsForge backend, not a local file. The connection string
// comes from the InsForge project (CLI: `insforge db connection-string`).

const connectionString = process.env.INSFORGE_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('INSFORGE_DATABASE_URL is not set — configure the InsForge Postgres connection string in .env');
}

const pool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  // Recycle idle connections before InsForge's own proxy silently drops them —
  // an unexpected drop (ECONNRESET) can otherwise leave the pool holding a
  // dead connection slot indefinitely.
  idleTimeoutMillis: 30_000,
  // pg's default is 0 (wait forever) for acquiring a connection from the pool.
  // If the pool is ever exhausted or stuck, queries must fail fast with a
  // clear error instead of hanging — which is what caused the dashboard to
  // spin forever waiting on /api/metrics and /api/transactions.
  connectionTimeoutMillis: 10_000,
  // Guard against any single query hanging the connection indefinitely.
  statement_timeout: 15_000
});

pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));

// Translate SQLite-style "?" placeholders to Postgres "$1, $2, …"
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const run = async (sql, params = []) => {
  const res = await pool.query(toPg(sql), params);
  return { changes: res.rowCount, rows: res.rows };
};

const all = async (sql, params = []) => (await pool.query(toPg(sql), params)).rows;

const get = async (sql, params = []) => {
  const rows = (await pool.query(toPg(sql), params)).rows;
  return rows[0];
};

// ─── Schema ────────────────────────────────────────────────────────────────

export async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      flow_id TEXT,
      order_number TEXT,
      customer_name TEXT,
      phone_number TEXT,
      status TEXT,
      type TEXT DEFAULT 'webhook',
      created_at TEXT,
      steps TEXT,
      error_message TEXT
    )
  `);

  // Add flow_id and type columns if upgrading from old schema
  try { await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS flow_id TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'webhook'`); } catch (_) {}
  // Chatwoot delivery-report tracking (populated by the /api/webhook/chatwoot receiver)
  try { await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS chatwoot_message_id TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delivery_status TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delivered_at TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS read_at TEXT`); } catch (_) {}
  await run(`CREATE INDEX IF NOT EXISTS idx_transactions_chatwoot_message ON transactions (chatwoot_message_id)`);
  await run(`
    CREATE TABLE IF NOT EXISTS pending_delivery_updates (
      chatwoot_message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error_message TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  // Idempotency guard — one row per (sender scope + topic + order/checkout id).
  // A WhatsApp send only proceeds if it can claim this key, so retries, duplicate
  // Shopify webhook deliveries, and repeated manual "Retry" clicks can never
  // re-send a message that already went out successfully for the same order.
  await run(`
    CREATE TABLE IF NOT EXISTS sent_notifications (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      chatwoot_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      trigger_event TEXT NOT NULL,
      nodes TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      context TEXT NOT NULL,
      run_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      error_message TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template_name TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      category TEXT NOT NULL DEFAULT 'UTILITY',
      delay_seconds INTEGER NOT NULL DEFAULT 5,
      phone_column TEXT NOT NULL DEFAULT '',
      name_column TEXT NOT NULL DEFAULT '',
      param_mapping TEXT NOT NULL DEFAULT '[]',
      steps TEXT NOT NULL DEFAULT '[]',
      shopify_check_mode TEXT NOT NULL DEFAULT 'off',
      order_column TEXT NOT NULL DEFAULT '',
      email_column TEXT NOT NULL DEFAULT '',
      campaign_type TEXT NOT NULL DEFAULT 'bulk',
      enrollment_source TEXT NOT NULL DEFAULT 'csv',
      trigger_event TEXT,
      trigger_conditions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      total INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      phone TEXT,
      name TEXT,
      email TEXT,
      order_reference TEXT,
      variables TEXT NOT NULL DEFAULT '{}',
      step_variables TEXT NOT NULL DEFAULT '[]',
      current_step INTEGER NOT NULL DEFAULT 0,
      last_shopify_status TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      run_at TEXT,
      sent_at TEXT
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_recipients_due ON campaign_recipients (status, run_at)`);

  await run(`
    CREATE TABLE IF NOT EXISTS webhook_retries (
      transaction_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      topic TEXT,
      flow_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_retries_due ON webhook_retries (status, run_at)`);

  await run(`
    CREATE TABLE IF NOT EXISTS abandoned_carts (
      id TEXT PRIMARY KEY,
      checkout_token TEXT UNIQUE NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      cart_items TEXT NOT NULL DEFAULT '[]',
      cart_total_price TEXT,
      abandoned_at TEXT NOT NULL,
      recovered_at TEXT,
      status TEXT NOT NULL DEFAULT 'abandoned',
      shopify_checkout_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status ON abandoned_carts (status, abandoned_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_abandoned_carts_token ON abandoned_carts (checkout_token)`);

  await run(`
    CREATE TABLE IF NOT EXISTS abandoned_cart_flows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      messages TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS abandoned_cart_messages (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      sequence_order INTEGER NOT NULL,
      template_name TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // One row per (cart × recovery-flow message) — the schedule the recovery
  // engine executes. UNIQUE on (checkout_token, flow_id, sequence_order) so
  // Shopify's repeated checkouts/create + checkouts/update webhooks can never
  // double-schedule the same follow-up.
  await run(`
    CREATE TABLE IF NOT EXISTS abandoned_cart_jobs (
      id TEXT PRIMARY KEY,
      cart_id TEXT NOT NULL,
      checkout_token TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      sequence_order INTEGER NOT NULL,
      template_name TEXT NOT NULL,
      variable_mapping TEXT NOT NULL DEFAULT '{}',
      run_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (checkout_token, flow_id, sequence_order)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_ac_jobs_due ON abandoned_cart_jobs (status, run_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_ac_jobs_token ON abandoned_cart_jobs (checkout_token)`);

  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS steps TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shopify_check_mode TEXT NOT NULL DEFAULT 'off'`); } catch (_) {}
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS order_column TEXT NOT NULL DEFAULT ''`); } catch (_) {}
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS email_column TEXT NOT NULL DEFAULT ''`); } catch (_) {}
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'bulk'`); } catch (_) {}
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS enrollment_source TEXT NOT NULL DEFAULT 'csv'`); } catch (_) {}
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS trigger_event TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS trigger_conditions TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
  await run(`CREATE INDEX IF NOT EXISTS idx_campaigns_webhook_trigger ON campaigns (campaign_type, enrollment_source, trigger_event, status)`);
  try { await run(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS skipped INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try { await run(`ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS email TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS order_reference TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS step_variables TEXT NOT NULL DEFAULT '[]'`); } catch (_) {}
  try { await run(`ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS current_step INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try { await run(`ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS last_shopify_status TEXT`); } catch (_) {}

  await run(`
    CREATE TABLE IF NOT EXISTS campaign_message_logs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      template_name TEXT,
      status TEXT NOT NULL,
      shopify_status TEXT,
      chatwoot_message_id TEXT,
      error_message TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_campaign_logs_campaign ON campaign_message_logs (campaign_id, created_at)`);

  console.log('[DB] Initialized (InsForge Postgres)');
}

// ─── Transactions ─────────────────────────────────────────────────────────

export async function logTransaction({ id, flow_id, order_number, customer_name, phone_number, status, type, steps, error_message }) {
  await run(
    `INSERT INTO transactions (id, flow_id, order_number, customer_name, phone_number, status, type, created_at, steps, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       flow_id = EXCLUDED.flow_id, order_number = EXCLUDED.order_number, customer_name = EXCLUDED.customer_name,
       phone_number = EXCLUDED.phone_number, status = EXCLUDED.status, type = EXCLUDED.type,
       created_at = EXCLUDED.created_at, steps = EXCLUDED.steps, error_message = EXCLUDED.error_message`,
    [id, flow_id || null, order_number || null, customer_name || null, phone_number || null, status, type || 'webhook', new Date().toISOString(), JSON.stringify(steps), error_message || null]
  );
}

export async function getTransactions(limit = 100, offset = 0, status = null) {
  // Older versions created a fresh random transaction id for every Shopify
  // delivery, so orders/create + orders/paid and webhook retries appeared as
  // duplicate executions. Keep the newest representative of each logical
  // webhook/flow execution. Other types (campaign/recovery/test) remain
  // individually visible.
  const grouped = `
    WITH ranked AS (
      SELECT
        id, flow_id, order_number, customer_name, phone_number, status, type,
        created_at, error_message, delivery_status,
        ROW_NUMBER() OVER (
          PARTITION BY CASE
            WHEN type IN ('webhook', 'flow') AND NULLIF(order_number, '') IS NOT NULL
              THEN CONCAT(type, '|', COALESCE(flow_id, ''), '|order|', order_number)
            WHEN type IN ('webhook', 'flow') AND NULLIF(phone_number, '') IS NOT NULL
              THEN CONCAT(type, '|', COALESCE(flow_id, ''), '|contact|', phone_number, '|', SUBSTRING(created_at, 1, 13))
            ELSE id
          END
          ORDER BY created_at DESC
        ) AS duplicate_rank
      FROM transactions
    )`;
  if (status && status !== 'all') {
    return all(
      `${grouped}
       SELECT id, flow_id, order_number, customer_name, phone_number, status, type, created_at, error_message, delivery_status
       FROM ranked WHERE duplicate_rank = 1 AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [status, limit, offset]
    );
  }
  return all(
    `${grouped}
     SELECT id, flow_id, order_number, customer_name, phone_number, status, type, created_at, error_message, delivery_status
     FROM ranked WHERE duplicate_rank = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

export async function getTransactionById(id) {
  const row = await get(`SELECT * FROM transactions WHERE id = ?`, [id]);
  if (row && row.steps) row.steps = JSON.parse(row.steps);
  return row;
}

export async function setTransactionChatwootMessageId(id, chatwootMessageId) {
  if (!chatwootMessageId) return;
  const messageId = String(chatwootMessageId);
  await run(`UPDATE transactions SET chatwoot_message_id = ? WHERE id = ?`, [messageId, id]);
  const pending = await get(`SELECT status, error_message FROM pending_delivery_updates WHERE chatwoot_message_id = ?`, [messageId]);
  if (pending) {
    await applyDeliveryStatus(messageId, pending.status, pending.error_message);
    await applyCampaignDeliveryStatus(messageId, pending.status, pending.error_message);
    await run(`DELETE FROM pending_delivery_updates WHERE chatwoot_message_id = ?`, [messageId]);
  } else {
    await applyDeliveryStatus(messageId, 'sent');
  }
}

const DELIVERY_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyDeliveryStatus(chatwootMessageId, status, errorMessage = null) {
  const current = await get(`SELECT delivery_status FROM transactions WHERE chatwoot_message_id = ?`, [String(chatwootMessageId)]);
  if (!current) return false;
  if ((DELIVERY_RANK[current.delivery_status] || 0) > (DELIVERY_RANK[status] || 0)) return true;

  const sets = ['delivery_status = ?'];
  const params = [status];
  if (status === 'sent') sets.push(`status = 'processing'`);
  if (status === 'delivered') { sets.push('delivered_at = ?'); params.push(new Date().toISOString()); }
  if (status === 'read') { sets.push('read_at = ?'); params.push(new Date().toISOString()); }
  if (status === 'delivered' || status === 'read') {
    sets.push(`status = 'success'`);
    sets.push('error_message = NULL');
  }
  if (status === 'failed') {
    sets.push(`status = 'failed'`);
    sets.push('error_message = COALESCE(?, error_message)');
    params.push(errorMessage || 'WhatsApp delivery failed after Chatwoot accepted the message');
  }
  params.push(String(chatwootMessageId));
  const res = await run(`UPDATE transactions SET ${sets.join(', ')} WHERE chatwoot_message_id = ?`, params);
  return res.changes > 0;
}

const CAMPAIGN_DELIVERY_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyCampaignDeliveryStatus(chatwootMessageId, status, errorMessage = null) {
  const row = await get(
    `SELECT cml.id AS log_id, cml.status AS log_status, cml.step_index,
            cr.id AS recipient_id, cr.status AS recipient_status, cr.current_step,
            c.id AS campaign_id, c.steps, c.enrollment_source
     FROM campaign_message_logs cml
     JOIN campaign_recipients cr ON cr.id = cml.recipient_id
     JOIN campaigns c ON c.id = cml.campaign_id
     WHERE cml.chatwoot_message_id = ?`,
    [String(chatwootMessageId)]
  );
  if (!row) return false;
  if ((CAMPAIGN_DELIVERY_RANK[row.log_status] || 0) > (CAMPAIGN_DELIVERY_RANK[status] || 0)) return true;

  await run(
    `UPDATE campaign_message_logs SET status = ?, error_message = ? WHERE id = ?`,
    [status, status === 'failed' ? (errorMessage || 'WhatsApp delivery failed after Chatwoot accepted the message') : null, row.log_id]
  );

  const wasSuccessful = ['sent', 'delivered', 'read'].includes(row.recipient_status);
  if (status === 'sent') {
    // "sent" only means Chatwoot/provider accepted the message. It is not a
    // confirmed WhatsApp delivery and must not count as campaign success.
    if (row.recipient_status === 'sent') {
      await run(`UPDATE campaigns SET sent = GREATEST(0, sent - 1), status = 'running' WHERE id = ?`, [row.campaign_id]);
    }
    if (['sent', 'accepted'].includes(row.recipient_status)) {
      await run(
        `UPDATE campaign_recipients SET status = 'accepted', error_message = NULL, sent_at = NULL WHERE id = ?`,
        [row.recipient_id]
      );
    }
  } else if (status === 'failed') {
    if (wasSuccessful) {
      await run(`UPDATE campaigns SET sent = GREATEST(0, sent - 1) WHERE id = ?`, [row.campaign_id]);
    }
    if (row.recipient_status !== 'failed') {
      await run(`UPDATE campaigns SET failed = failed + 1 WHERE id = ?`, [row.campaign_id]);
    }
    await run(
      `UPDATE campaign_recipients SET status = 'failed', error_message = ?, sent_at = NULL WHERE id = ?`,
      [errorMessage || 'WhatsApp delivery failed after Chatwoot accepted the message', row.recipient_id]
    );
  } else if (status === 'delivered' || status === 'read') {
    if (!['delivered', 'read'].includes(row.recipient_status)) {
      if (row.recipient_status === 'sent') {
        await run(`UPDATE campaigns SET sent = GREATEST(0, sent - 1) WHERE id = ?`, [row.campaign_id]);
      }
      const steps = JSON.parse(row.steps || '[]');
      const hasNextStep = Number(row.step_index) + 1 < steps.length;
      if (hasNextStep) {
        const next = steps[Number(row.step_index) + 1] || {};
        const amount = Math.max(0, Number(next.delay_value || 0));
        const multiplier = next.delay_unit === 'days' ? 86400000 : next.delay_unit === 'hours' ? 3600000 : 60000;
        await run(
          `UPDATE campaign_recipients
           SET status = 'pending', current_step = ?, run_at = ?, error_message = NULL, sent_at = NULL
           WHERE id = ?`,
          [Number(row.step_index) + 1, new Date(Date.now() + amount * multiplier).toISOString(), row.recipient_id]
        );
      } else {
        await run(
          `UPDATE campaign_recipients SET status = ?, error_message = NULL, sent_at = ? WHERE id = ?`,
          [status, new Date().toISOString(), row.recipient_id]
        );
        await run(`UPDATE campaigns SET sent = sent + 1 WHERE id = ?`, [row.campaign_id]);
      }
    } else if (status === 'read' && row.recipient_status === 'delivered') {
      await run(`UPDATE campaign_recipients SET status = 'read' WHERE id = ?`, [row.recipient_id]);
    }
  }

  await finalizeCampaignIfDone(row.campaign_id);
  return true;
}

/**
 * Update delivery state even when Chatwoot's webhook beats the sender's DB
 * update. Early events are retained and applied when the message ID is linked.
 */
export async function updateDeliveryStatusByMessageId(chatwootMessageId, status, errorMessage = null) {
  const messageId = String(chatwootMessageId || '');
  if (!messageId || !DELIVERY_RANK[status]) return false;
  const campaignApplied = await applyCampaignDeliveryStatus(messageId, status, errorMessage);
  const transactionApplied = await applyDeliveryStatus(messageId, status, errorMessage);
  if (campaignApplied || transactionApplied) return true;

  const existing = await get(`SELECT status FROM pending_delivery_updates WHERE chatwoot_message_id = ?`, [messageId]);
  if (!existing || (DELIVERY_RANK[status] || 0) >= (DELIVERY_RANK[existing.status] || 0)) {
    await run(
      `INSERT INTO pending_delivery_updates (chatwoot_message_id, status, error_message, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (chatwoot_message_id) DO UPDATE SET
         status = EXCLUDED.status,
         error_message = EXCLUDED.error_message,
         updated_at = EXCLUDED.updated_at`,
      [messageId, status, errorMessage, new Date().toISOString()]
    );
  }
  return false;
}

export async function getPendingCampaignDeliveries(limit = 100) {
  const rows = await all(
    `SELECT cml.chatwoot_message_id, cml.details
     FROM campaign_message_logs cml
     JOIN campaign_recipients cr ON cr.id = cml.recipient_id
     WHERE cml.chatwoot_message_id IS NOT NULL
       AND cml.status IN ('accepted', 'sent')
       AND cr.status IN ('accepted', 'sent')
     ORDER BY cml.created_at ASC
     LIMIT ?`,
    [limit]
  );
  return rows.map(row => {
    let details = {};
    try { details = JSON.parse(row.details || '{}'); } catch (_) {}
    return {
      chatwoot_message_id: String(row.chatwoot_message_id),
      conversation_id: details.conversationId || null
    };
  });
}

// ─── Notification Idempotency ──────────────────────────────────────────────
// Prevents the same WhatsApp template from being sent twice for the same
// (sender scope + topic + order/checkout) — covers duplicate Shopify webhook
// deliveries, the app's own auto-retry queue, and repeated manual "Retry" clicks.

/** Try to claim the right to send. Returns true if the caller should proceed,
 *  false if this exact notification was already sent (or is currently in flight). */
export async function claimNotification(dedupeKey) {
  const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const res = await run(
    `INSERT INTO sent_notifications (id, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?)
     ON CONFLICT (dedupe_key) DO UPDATE SET status = 'pending', updated_at = EXCLUDED.updated_at
     WHERE sent_notifications.status = 'failed'
     RETURNING id`,
    [id, dedupeKey, now, now]
  );
  return res.rows.length > 0;
}

export async function markNotificationSent(dedupeKey, chatwootMessageId) {
  await run(
    `UPDATE sent_notifications SET status = 'sent', chatwoot_message_id = ?, updated_at = ? WHERE dedupe_key = ?`,
    [chatwootMessageId ? String(chatwootMessageId) : null, new Date().toISOString(), dedupeKey]
  );
}

export async function markNotificationFailed(dedupeKey) {
  await run(
    `UPDATE sent_notifications SET status = 'failed', updated_at = ? WHERE dedupe_key = ?`,
    [new Date().toISOString(), dedupeKey]
  );
}

export async function getMetrics() {
  const stats = await get(`
    WITH ranked AS (
      SELECT status,
        ROW_NUMBER() OVER (
          PARTITION BY CASE
            WHEN type IN ('webhook', 'flow') AND NULLIF(order_number, '') IS NOT NULL
              THEN CONCAT(type, '|', COALESCE(flow_id, ''), '|order|', order_number)
            WHEN type IN ('webhook', 'flow') AND NULLIF(phone_number, '') IS NOT NULL
              THEN CONCAT(type, '|', COALESCE(flow_id, ''), '|contact|', phone_number, '|', SUBSTRING(created_at, 1, 13))
            ELSE id
          END
          ORDER BY created_at DESC
        ) AS duplicate_rank
      FROM transactions
    )
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing
    FROM ranked
    WHERE duplicate_rank = 1
  `);

  return {
    total: Number(stats.total) || 0,
    success: Number(stats.success) || 0,
    failed: Number(stats.failed) || 0,
    processing: Number(stats.processing) || 0
  };
}

// ─── Settings ─────────────────────────────────────────────────────────────

const SETTING_KEYS = [
  'CHATWOOT_API_URL', 'CHATWOOT_API_TOKEN', 'CHATWOOT_ACCOUNT_ID', 'CHATWOOT_INBOX_ID',
  'WHATSAPP_TEMPLATE_NAME', 'WHATSAPP_TEMPLATE_MAPPING',
  'WHATSAPP_SHIPPING_TEMPLATE_NAME', 'WHATSAPP_SHIPPING_TEMPLATE_MAPPING',
  'SHOPIFY_STORE_URL', 'SHOPIFY_ADMIN_TOKEN',
  'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SHOPIFY_SCOPES', 'SHOPIFY_APP_URL',
  'WEBHOOK_MAX_RETRIES', 'CHATWOOT_AUTOMATION_ASSIGNEE_ID'
];

export async function getAllSettings() {
  const dbSettings = await all(`SELECT key, value FROM settings`);
  const obj = {};
  for (const k of SETTING_KEYS) obj[k] = process.env[k] || '';
  for (const s of dbSettings) obj[s.key] = s.value;
  return obj;
}

export async function saveSettings(settings) {
  for (const [key, value] of Object.entries(settings)) {
    await run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, String(value)]
    );
  }
}

// ─── Flows ────────────────────────────────────────────────────────────────

export async function saveFlow({ id, name, description, trigger_event, nodes, edges, is_active }) {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO flows (id, name, description, trigger_event, nodes, edges, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, trigger_event = EXCLUDED.trigger_event,
       nodes = EXCLUDED.nodes, edges = EXCLUDED.edges, is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at`,
    [id, name, description || '', trigger_event, JSON.stringify(nodes), JSON.stringify(edges), is_active ? 1 : 0, now, now]
  );
}

export async function getFlows() {
  const rows = await all(`SELECT * FROM flows ORDER BY updated_at DESC`);
  return rows.map(r => ({
    ...r,
    nodes: JSON.parse(r.nodes || '[]'),
    edges: JSON.parse(r.edges || '[]'),
    is_active: Boolean(r.is_active)
  }));
}

export async function getFlowById(id) {
  const row = await get(`SELECT * FROM flows WHERE id = ?`, [id]);
  if (!row) return null;
  return { ...row, nodes: JSON.parse(row.nodes || '[]'), edges: JSON.parse(row.edges || '[]'), is_active: Boolean(row.is_active) };
}

export async function getFlowsByTrigger(event) {
  const rows = await all(`SELECT * FROM flows WHERE trigger_event = ? AND is_active = 1`, [event]);
  return rows.map(r => ({
    ...r,
    nodes: JSON.parse(r.nodes || '[]'),
    edges: JSON.parse(r.edges || '[]'),
    is_active: Boolean(r.is_active)
  }));
}

export async function deleteFlow(id) {
  await run(`DELETE FROM flows WHERE id = ?`, [id]);
  await run(`DELETE FROM scheduled_jobs WHERE flow_id = ? AND status = 'pending'`, [id]);
}

export async function toggleFlow(id, is_active) {
  await run(`UPDATE flows SET is_active = ?, updated_at = ? WHERE id = ?`, [is_active ? 1 : 0, new Date().toISOString(), id]);
}

// ─── Scheduled Jobs ───────────────────────────────────────────────────────

export async function scheduleJob({ id, flow_id, transaction_id, node_id, context, run_at }) {
  await run(
    `INSERT INTO scheduled_jobs (id, flow_id, transaction_id, node_id, context, run_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [id, flow_id, transaction_id, node_id, JSON.stringify(context), run_at, new Date().toISOString()]
  );
}

export async function getPendingJobs() {
  const rows = await all(
    `SELECT * FROM scheduled_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC`,
    [new Date().toISOString()]
  );
  return rows.map(r => ({ ...r, context: JSON.parse(r.context || '{}') }));
}

export async function markJobStatus(id, status, error_message = null) {
  await run(
    `UPDATE scheduled_jobs SET status = ?, error_message = ? WHERE id = ?`,
    [status, error_message || null, id]
  );
}

// ─── Campaigns ──────────────────────────────────────────────────────────────

export async function createCampaign({ id, name, template_name, language, category, delay_seconds, phone_column, name_column, param_mapping, steps, shopify_check_mode, order_column, email_column, campaign_type, enrollment_source, trigger_event, trigger_conditions, recipients }) {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO campaigns (id, name, template_name, language, category, delay_seconds, phone_column, name_column, param_mapping, steps, shopify_check_mode, order_column, email_column, campaign_type, enrollment_source, trigger_event, trigger_conditions, status, total, sent, failed, skipped, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 0, 0, 0, ?, NULL)`,
    [id, name, template_name, language || 'en', category || 'UTILITY', delay_seconds || 5, phone_column || '', name_column || '', JSON.stringify(param_mapping || []), JSON.stringify(steps || []), shopify_check_mode || 'off', order_column || '', email_column || '', campaign_type || 'bulk', enrollment_source || 'csv', trigger_event || null, JSON.stringify(trigger_conditions || []), recipients.length, now]
  );
  for (const r of recipients) {
    await run(
      `INSERT INTO campaign_recipients (id, campaign_id, row_index, phone, name, email, order_reference, variables, step_variables, current_step, status, error_message, run_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, NULL, NULL)`,
      [`${id}_r${r.row_index}`, id, r.row_index, r.phone || '', r.name || '', r.email || '', r.order_reference || '', JSON.stringify(r.variables || {}), JSON.stringify(r.step_variables || [])]
    );
  }
}

export async function getCampaigns() {
  const campaigns = await all(
    `SELECT id, name, template_name, status, delay_seconds, total, sent, failed, skipped, steps, shopify_check_mode, campaign_type, enrollment_source, trigger_event, trigger_conditions, created_at, started_at
     FROM campaigns ORDER BY created_at DESC`
  );
  return campaigns.map(c => ({ ...c, steps: JSON.parse(c.steps || '[]'), trigger_conditions: JSON.parse(c.trigger_conditions || '[]') }));
}

export async function getCampaignById(id) {
  const c = await get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
  if (!c) return null;
  c.param_mapping = JSON.parse(c.param_mapping || '[]');
  c.steps = JSON.parse(c.steps || '[]');
  c.trigger_conditions = JSON.parse(c.trigger_conditions || '[]');
  const recipients = await all(
    `SELECT id, row_index, phone, name, email, order_reference, variables, step_variables, current_step, last_shopify_status, status, error_message, run_at, sent_at
     FROM campaign_recipients WHERE campaign_id = ? ORDER BY row_index ASC`,
    [id]
  );
  c.recipients = recipients.map(r => ({ ...r, variables: JSON.parse(r.variables || '{}'), step_variables: JSON.parse(r.step_variables || '[]') }));
  c.logs = await all(`SELECT * FROM campaign_message_logs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 500`, [id]);
  c.logs = c.logs.map(log => ({ ...log, details: JSON.parse(log.details || '{}') }));
  return c;
}

export async function deleteCampaign(id) {
  await run(`DELETE FROM campaign_recipients WHERE campaign_id = ?`, [id]);
  await run(`DELETE FROM campaign_message_logs WHERE campaign_id = ?`, [id]);
  await run(`DELETE FROM campaigns WHERE id = ?`, [id]);
}

/**
 * Start (or resume) a campaign: assign run_at to all pending recipients,
 * paced by delay_seconds from now, and mark the campaign 'running'.
 */
export async function startCampaign(id) {
  const campaign = await get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
  if (!campaign) throw new Error('Campaign not found');
  const delayMs = (campaign.delay_seconds || 5) * 1000;
  const dripSteps = JSON.parse(campaign.steps || '[]');
  const pending = await all(
    `SELECT id, current_step, run_at FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY row_index ASC`,
    [id]
  );
  const base = Date.now();
  for (let i = 0; i < pending.length; i++) {
    // Resume keeps an already scheduled drip deadline. Fresh/retried rows get
    // the delay belonging to their current step plus recipient pacing.
    if (pending[i].run_at) continue;
    const step = dripSteps[Number(pending[i].current_step || 0)] || {};
    const amount = Math.max(0, Number(step.delay_value || 0));
    const multiplier = step.delay_unit === 'days' ? 86400000 : step.delay_unit === 'hours' ? 3600000 : 60000;
    const runAt = new Date(base + amount * multiplier + i * delayMs).toISOString();
    await run(`UPDATE campaign_recipients SET run_at = ? WHERE id = ?`, [runAt, pending[i].id]);
  }
  await run(
    `UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function pauseCampaign(id) {
  await run(`UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'running'`, [id]);
}

export async function getDueCampaignRecipients(limit = 20) {
  return all(
    `SELECT cr.*, c.template_name, c.language, c.category, c.steps, c.shopify_check_mode
     FROM campaign_recipients cr
     JOIN campaigns c ON c.id = cr.campaign_id
     WHERE cr.status = 'pending' AND cr.run_at IS NOT NULL AND cr.run_at <= ? AND c.status = 'running'
     ORDER BY cr.run_at ASC LIMIT ?`,
    [new Date().toISOString(), limit]
  );
}

export async function markRecipientStatus(id, status, error_message = null) {
  await run(
    `UPDATE campaign_recipients SET status = ?, error_message = ?, sent_at = ? WHERE id = ?`,
    [status, error_message || null, ['sent', 'delivered', 'read', 'skipped'].includes(status) ? new Date().toISOString() : null, id]
  );
}

export async function getWebhookDripCampaigns(triggerEvent) {
  const campaigns = await all(
    `SELECT * FROM campaigns
     WHERE campaign_type = 'drip' AND enrollment_source = 'webhook' AND trigger_event = ? AND status = 'running'`,
    [triggerEvent]
  );
  return campaigns.map(c => ({
    ...c,
    steps: JSON.parse(c.steps || '[]'),
    trigger_conditions: JSON.parse(c.trigger_conditions || '[]')
  }));
}

/** Enroll one webhook event once. Returns true only when a new row was inserted. */
export async function enrollCampaignRecipient({ id, campaign, phone, name, email, order_reference, variables, step_variables }) {
  const step = campaign.steps?.[0] || {};
  const amount = Math.max(0, Number(step.delay_value || 0));
  const multiplier = step.delay_unit === 'days' ? 86400000 : step.delay_unit === 'hours' ? 3600000 : 60000;
  const runAt = new Date(Date.now() + amount * multiplier).toISOString();
  const row = await get(`SELECT COALESCE(MAX(row_index), -1) + 1 AS next_index FROM campaign_recipients WHERE campaign_id = ?`, [campaign.id]);
  const result = await run(
    `INSERT INTO campaign_recipients (id, campaign_id, row_index, phone, name, email, order_reference, variables, step_variables, current_step, status, error_message, run_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [id, campaign.id, Number(row?.next_index || 0), phone || '', name || '', email || '', order_reference || '', JSON.stringify(variables || {}), JSON.stringify(step_variables || []), runAt]
  );
  if (!result.changes) return false;
  await run(`UPDATE campaigns SET total = total + 1 WHERE id = ?`, [campaign.id]);
  return true;
}

export async function advanceCampaignRecipient(id, current_step, run_at, last_shopify_status = null) {
  await run(
    `UPDATE campaign_recipients SET current_step = ?, run_at = ?, last_shopify_status = ?, error_message = NULL WHERE id = ?`,
    [current_step, run_at, last_shopify_status, id]
  );
}

export async function logCampaignMessage({ id, campaign_id, recipient_id, step_index, template_name, status, shopify_status, chatwoot_message_id, error_message, details }) {
  await run(
    `INSERT INTO campaign_message_logs (id, campaign_id, recipient_id, step_index, template_name, status, shopify_status, chatwoot_message_id, error_message, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, shopify_status = EXCLUDED.shopify_status, chatwoot_message_id = EXCLUDED.chatwoot_message_id, error_message = EXCLUDED.error_message, details = EXCLUDED.details`,
    [id, campaign_id, recipient_id, step_index, template_name || null, status, shopify_status || null, chatwoot_message_id || null, error_message || null, JSON.stringify(details || {}), new Date().toISOString()]
  );
}

export async function incrementCampaignCounter(id, field) {
  if (field === 'sent') await run(`UPDATE campaigns SET sent = sent + 1 WHERE id = ?`, [id]);
  else if (field === 'failed') await run(`UPDATE campaigns SET failed = failed + 1 WHERE id = ?`, [id]);
  else if (field === 'skipped') await run(`UPDATE campaigns SET skipped = skipped + 1 WHERE id = ?`, [id]);
}

export async function finalizeCampaignIfDone(id) {
  const row = await get(
    `SELECT c.enrollment_source,
       (SELECT COUNT(*) FROM campaign_recipients cr
        WHERE cr.campaign_id = c.id AND cr.status IN ('pending', 'accepted', 'sent')) AS pending
     FROM campaigns c WHERE c.id = ?`,
    [id]
  );
  // Webhook drips are standing automations: finishing the currently enrolled
  // recipients must not disable future Shopify-event enrollments.
  if (row?.enrollment_source === 'webhook') return;
  if (row && Number(row.pending) === 0) {
    await run(`UPDATE campaigns SET status = 'completed' WHERE id = ? AND status = 'running'`, [id]);
  }
}

/** Requeue all failed recipients of a campaign and resume sending. Returns count. */
export async function retryFailedRecipients(id) {
  const campaign = await get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
  if (!campaign) throw new Error('Campaign not found');
  const failed = await all(`SELECT id FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'`, [id]);
  if (failed.length === 0) return 0;
  await run(`UPDATE campaign_recipients SET status = 'pending', error_message = NULL, run_at = NULL, sent_at = NULL WHERE campaign_id = ? AND status = 'failed'`, [id]);
  await run(`UPDATE campaigns SET failed = 0 WHERE id = ?`, [id]);
  await startCampaign(id); // reassigns run_at to all pending and marks running
  return failed.length;
}

// ─── Webhook auto-retry ───────────────────────────────────────────────────

export async function scheduleWebhookRetry({ transaction_id, payload, topic, flow_id, run_at, max_attempts }) {
  await run(
    `INSERT INTO webhook_retries (transaction_id, payload, topic, flow_id, attempts, max_attempts, run_at, status, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, 'pending', ?)
     ON CONFLICT (transaction_id) DO UPDATE SET
       payload = EXCLUDED.payload, topic = EXCLUDED.topic, flow_id = EXCLUDED.flow_id,
       max_attempts = EXCLUDED.max_attempts, run_at = EXCLUDED.run_at, status = 'pending'`,
    [transaction_id, JSON.stringify(payload), topic || null, flow_id || null, max_attempts || 3, run_at, new Date().toISOString()]
  );
}

export async function getDueWebhookRetries(limit = 10) {
  const rows = await all(
    `SELECT * FROM webhook_retries WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT ?`,
    [new Date().toISOString(), limit]
  );
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload || 'null') }));
}

export async function updateWebhookRetry(transaction_id, { attempts, run_at, status }) {
  const sets = [];
  const params = [];
  if (attempts != null) { sets.push('attempts = ?'); params.push(attempts); }
  if (run_at != null) { sets.push('run_at = ?'); params.push(run_at); }
  if (status != null) { sets.push('status = ?'); params.push(status); }
  if (sets.length === 0) return;
  params.push(transaction_id);
  await run(`UPDATE webhook_retries SET ${sets.join(', ')} WHERE transaction_id = ?`, params);
}

/** Requeue a single recipient (by recipient id) and resume the campaign. */
export async function retryRecipient(recipientId) {
  const rec = await get(`SELECT * FROM campaign_recipients WHERE id = ?`, [recipientId]);
  if (!rec) throw new Error('Recipient not found');
  if (rec.status === 'failed') {
    await run(`UPDATE campaigns SET failed = GREATEST(0, failed - 1) WHERE id = ?`, [rec.campaign_id]);
  }
  await run(
    `UPDATE campaign_recipients SET status = 'pending', error_message = NULL, run_at = ?, sent_at = NULL WHERE id = ?`,
    [new Date().toISOString(), recipientId]
  );
  await run(
    `UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
    [new Date().toISOString(), rec.campaign_id]
  );
  return rec.campaign_id;
}

// ─── Abandoned Carts ──────────────────────────────────────────────────────

export async function saveAbandonedCart({
  id, checkout_token, customer_name, customer_email, customer_phone,
  cart_items, cart_total_price, abandoned_at, shopify_checkout_url
}) {
  // Upsert on checkout_token (the natural Shopify key) so webhook-created
  // and sync-backfilled rows for the same checkout never collide.
  //
  // Shopify's checkouts/create fires the instant a checkout session starts —
  // often before the customer has typed in their name/email/phone. Fuller
  // details land later via checkouts/update. Use COALESCE(NULLIF(...)) so a
  // later, sparser event can never blank out data we already captured; it can
  // only fill gaps or replace with newer non-empty values.
  await run(
    `INSERT INTO abandoned_carts (id, checkout_token, customer_name, customer_email, customer_phone, cart_items, cart_total_price, abandoned_at, shopify_checkout_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (checkout_token) DO UPDATE SET
       customer_name = COALESCE(NULLIF(EXCLUDED.customer_name, ''), abandoned_carts.customer_name),
       customer_email = COALESCE(NULLIF(EXCLUDED.customer_email, ''), abandoned_carts.customer_email),
       customer_phone = COALESCE(NULLIF(EXCLUDED.customer_phone, ''), abandoned_carts.customer_phone),
       cart_items = CASE WHEN EXCLUDED.cart_items = '[]' THEN abandoned_carts.cart_items ELSE EXCLUDED.cart_items END,
       cart_total_price = COALESCE(NULLIF(EXCLUDED.cart_total_price, '0'), abandoned_carts.cart_total_price),
       shopify_checkout_url = COALESCE(NULLIF(EXCLUDED.shopify_checkout_url, ''), abandoned_carts.shopify_checkout_url),
       updated_at = EXCLUDED.updated_at`,
    [id, checkout_token, customer_name, customer_email, customer_phone, JSON.stringify(cart_items || []), cart_total_price, abandoned_at, shopify_checkout_url, new Date().toISOString(), new Date().toISOString()]
  );
}

export async function getAbandonedCarts(limit = 100, offset = 0, status = 'abandoned') {
  const rows = await all(
    `SELECT id, checkout_token, customer_name, customer_email, customer_phone, cart_items, cart_total_price, abandoned_at, recovered_at, status, shopify_checkout_url, created_at, updated_at
     FROM abandoned_carts
     WHERE status = ?
     ORDER BY abandoned_at DESC
     LIMIT ? OFFSET ?`,
    [status, limit, offset]
  );
  return rows.map(r => ({
    ...r,
    cart_items: r.cart_items ? JSON.parse(r.cart_items) : []
  }));
}

export async function getAbandonedCartById(id) {
  const row = await get(`SELECT * FROM abandoned_carts WHERE id = ?`, [id]);
  if (row && row.cart_items) {
    row.cart_items = JSON.parse(row.cart_items);
  }
  return row;
}

export async function updateAbandonedCartStatus(id, status, recovered_at = null) {
  await run(
    `UPDATE abandoned_carts SET status = ?, recovered_at = COALESCE(?, recovered_at), updated_at = ? WHERE id = ?`,
    [status, recovered_at, new Date().toISOString(), id]
  );
}

export async function getAbandonedCartByToken(checkout_token) {
  const row = await get(`SELECT * FROM abandoned_carts WHERE checkout_token = ?`, [String(checkout_token)]);
  if (row && row.cart_items) row.cart_items = JSON.parse(row.cart_items);
  return row;
}

/** Mark a cart recovered by its Shopify checkout token (used when an order completes). */
export async function markCartRecoveredByToken(checkout_token) {
  const res = await run(
    `UPDATE abandoned_carts SET status = 'recovered', recovered_at = ?, updated_at = ? WHERE checkout_token = ? AND status = 'abandoned'`,
    [new Date().toISOString(), new Date().toISOString(), String(checkout_token)]
  );
  return res.changes > 0;
}

// ─── Abandoned Cart Recovery Jobs ─────────────────────────────────────────

/** Insert one pending job per flow message. Repeated checkout updates keep
 *  pending/sent jobs untouched, but requeue failed/skipped jobs after fresher
 *  customer data or a corrected template mapping becomes available. */
export async function scheduleAbandonedCartJob({ cart_id, checkout_token, flow_id, sequence_order, template_name, variable_mapping, run_at }) {
  const id = `acj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const res = await run(
    `INSERT INTO abandoned_cart_jobs (id, cart_id, checkout_token, flow_id, sequence_order, template_name, variable_mapping, run_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (checkout_token, flow_id, sequence_order) DO UPDATE SET
       cart_id = EXCLUDED.cart_id,
       template_name = EXCLUDED.template_name,
       variable_mapping = EXCLUDED.variable_mapping,
       run_at = EXCLUDED.run_at,
       status = 'pending',
       error_message = NULL,
       updated_at = EXCLUDED.updated_at
     WHERE abandoned_cart_jobs.status IN ('failed', 'skipped')`,
    [id, cart_id, String(checkout_token), flow_id, sequence_order, template_name, JSON.stringify(variable_mapping || {}), run_at, now, now]
  );
  return res.changes > 0;
}

export async function getDueAbandonedCartJobs(limit = 10) {
  const rows = await all(
    `SELECT j.*
     FROM abandoned_cart_jobs j
     JOIN abandoned_cart_flows f ON f.id = j.flow_id AND f.is_active = 1
     JOIN abandoned_carts c ON c.checkout_token = j.checkout_token AND c.status = 'abandoned'
     WHERE j.status = 'pending' AND j.run_at <= ?
     ORDER BY j.run_at ASC
     LIMIT ?`,
    [new Date().toISOString(), limit]
  );
  return rows.map(r => ({ ...r, variable_mapping: JSON.parse(r.variable_mapping || '{}') }));
}

export async function updateAbandonedCartJob(id, { status, error_message }) {
  await run(
    `UPDATE abandoned_cart_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
    [status, error_message || null, new Date().toISOString(), id]
  );
}

/** Cancel all not-yet-sent follow-ups for a checkout (customer completed the order). */
export async function cancelAbandonedCartJobsForToken(checkout_token) {
  const res = await run(
    `UPDATE abandoned_cart_jobs SET status = 'cancelled', updated_at = ? WHERE checkout_token = ? AND status = 'pending'`,
    [new Date().toISOString(), String(checkout_token)]
  );
  return res.changes;
}

/** Stop queued messages when a recovery flow is paused, replaced, or deleted. */
export async function cancelAbandonedCartJobsForFlow(flow_id, reason = 'Recovery flow is inactive') {
  const res = await run(
    `UPDATE abandoned_cart_jobs
     SET status = 'cancelled', error_message = ?, updated_at = ?
     WHERE flow_id = ? AND status = 'pending'`,
    [reason, new Date().toISOString(), flow_id]
  );
  return res.changes;
}

/**
 * Keep queued jobs aligned with the current flow definition. Sent/cancelled
 * history is immutable; only not-yet-sent jobs are refreshed.
 */
export async function syncPendingAbandonedCartJobsForFlow(flow_id, messages = []) {
  const jobs = await all(
    `SELECT j.id, j.sequence_order, c.abandoned_at, c.created_at
     FROM abandoned_cart_jobs j
     LEFT JOIN abandoned_carts c ON c.checkout_token = j.checkout_token
     WHERE j.flow_id = ? AND j.status = 'pending'`,
    [flow_id]
  );
  const bySequence = new Map((messages || []).map(message => [Number(message.sequence_order), message]));
  let updated = 0;
  let cancelled = 0;

  for (const job of jobs) {
    const message = bySequence.get(Number(job.sequence_order));
    if (!message) {
      await run(
        `UPDATE abandoned_cart_jobs
         SET status = 'cancelled', error_message = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        ['Message was removed from the recovery flow', new Date().toISOString(), job.id]
      );
      cancelled++;
      continue;
    }

    const anchor = new Date(job.abandoned_at || job.created_at).getTime();
    if (!Number.isFinite(anchor)) {
      await run(
        `UPDATE abandoned_cart_jobs
         SET status = 'cancelled', error_message = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        ['Cart no longer has a valid abandonment date', new Date().toISOString(), job.id]
      );
      cancelled++;
      continue;
    }
    const delay = Number(message.delay_minutes) || 0;
    const runAt = new Date(anchor + delay * 60_000).toISOString();
    const res = await run(
      `UPDATE abandoned_cart_jobs
       SET template_name = ?, variable_mapping = ?, run_at = ?, error_message = NULL, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      [
        message.template_name,
        JSON.stringify(message.variable_mapping || {}),
        runAt,
        new Date().toISOString(),
        job.id
      ]
    );
    updated += res.changes;
  }

  return { updated, cancelled };
}

export async function getAbandonedCartStats() {
  const stats = await get(`
    SELECT
      COUNT(CASE WHEN status = 'abandoned' THEN 1 END) as active_abandoned,
      COUNT(CASE WHEN status = 'recovered' THEN 1 END) as recovered,
      COUNT(*) as total_tracked,
      SUM(CASE WHEN cart_total_price IS NOT NULL THEN CAST(cart_total_price AS DECIMAL) ELSE 0 END) as total_value
    FROM abandoned_carts
  `);
  return {
    active_abandoned: Number(stats.active_abandoned) || 0,
    recovered: Number(stats.recovered) || 0,
    total_tracked: Number(stats.total_tracked) || 0,
    total_value: stats.total_value ? String(stats.total_value) : '0'
  };
}

// ─── Abandoned Cart Flows ─────────────────────────────────────────────────

export async function saveAbandonedCartFlow({ id, name, description, is_active, messages }) {
  await run(
    `INSERT INTO abandoned_cart_flows (id, name, description, is_active, messages, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, is_active = EXCLUDED.is_active,
       messages = EXCLUDED.messages, updated_at = EXCLUDED.updated_at`,
    [id, name, description, is_active ? 1 : 0, JSON.stringify(messages || []), new Date().toISOString(), new Date().toISOString()]
  );
  if (is_active) {
    // Recovery flows do not have audience conditions, so activating more than
    // one would send duplicate sequences to every cart. Keep exactly one active.
    const otherActive = await all(
      `SELECT id FROM abandoned_cart_flows WHERE id <> ? AND is_active = 1`,
      [id]
    );
    await run(
      `UPDATE abandoned_cart_flows SET is_active = 0, updated_at = ? WHERE id <> ? AND is_active = 1`,
      [new Date().toISOString(), id]
    );
    for (const flow of otherActive) {
      await cancelAbandonedCartJobsForFlow(flow.id, 'Another recovery flow was activated');
    }
    await syncPendingAbandonedCartJobsForFlow(id, messages || []);
  } else {
    await cancelAbandonedCartJobsForFlow(id, 'Recovery flow was saved inactive');
  }
}

export async function getAbandonedCartFlows() {
  const rows = await all(
    `SELECT id, name, description, is_active, messages, created_at, updated_at FROM abandoned_cart_flows ORDER BY created_at DESC`
  );
  return rows.map(r => ({
    ...r,
    is_active: r.is_active === 1,
    messages: r.messages ? JSON.parse(r.messages) : []
  }));
}

export async function getAbandonedCartFlowById(id) {
  const row = await get(`SELECT * FROM abandoned_cart_flows WHERE id = ?`, [id]);
  if (row) {
    row.is_active = row.is_active === 1;
    row.messages = row.messages ? JSON.parse(row.messages) : [];
  }
  return row;
}

export async function deleteAbandonedCartFlow(id) {
  await cancelAbandonedCartJobsForFlow(id, 'Recovery flow was deleted');
  await run(`DELETE FROM abandoned_cart_flows WHERE id = ?`, [id]);
}

export async function toggleAbandonedCartFlow(id, is_active) {
  if (is_active) {
    const otherActive = await all(
      `SELECT id FROM abandoned_cart_flows WHERE id <> ? AND is_active = 1`,
      [id]
    );
    await run(
      `UPDATE abandoned_cart_flows SET is_active = 0, updated_at = ? WHERE id <> ? AND is_active = 1`,
      [new Date().toISOString(), id]
    );
    for (const flow of otherActive) {
      await cancelAbandonedCartJobsForFlow(flow.id, 'Another recovery flow was activated');
    }
  }
  await run(
    `UPDATE abandoned_cart_flows SET is_active = ?, updated_at = ? WHERE id = ?`,
    [is_active ? 1 : 0, new Date().toISOString(), id]
  );
  if (!is_active) {
    await cancelAbandonedCartJobsForFlow(id, 'Recovery flow was paused');
  }
}
