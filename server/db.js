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
  max: 10
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
      status TEXT NOT NULL DEFAULT 'draft',
      total INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
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
      variables TEXT NOT NULL DEFAULT '{}',
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
  if (status && status !== 'all') {
    return all(
      `SELECT id, flow_id, order_number, customer_name, phone_number, status, type, created_at, error_message FROM transactions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [status, limit, offset]
    );
  }
  return all(
    `SELECT id, flow_id, order_number, customer_name, phone_number, status, type, created_at, error_message FROM transactions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

export async function getTransactionById(id) {
  const row = await get(`SELECT * FROM transactions WHERE id = ?`, [id]);
  if (row && row.steps) row.steps = JSON.parse(row.steps);
  return row;
}

export async function getMetrics() {
  const stats = await get(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing
    FROM transactions
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
  'WHATSAPP_ABANDONED_CART_TEMPLATE_NAME', 'WHATSAPP_ABANDONED_CART_TEMPLATE_MAPPING',
  'SHOPIFY_STORE_URL', 'SHOPIFY_ADMIN_TOKEN',
  'WEBHOOK_MAX_RETRIES'
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

export async function createCampaign({ id, name, template_name, language, category, delay_seconds, phone_column, name_column, param_mapping, recipients }) {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO campaigns (id, name, template_name, language, category, delay_seconds, phone_column, name_column, param_mapping, status, total, sent, failed, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 0, 0, ?, NULL)`,
    [id, name, template_name, language || 'en', category || 'UTILITY', delay_seconds || 5, phone_column || '', name_column || '', JSON.stringify(param_mapping || []), recipients.length, now]
  );
  for (const r of recipients) {
    await run(
      `INSERT INTO campaign_recipients (id, campaign_id, row_index, phone, name, variables, status, error_message, run_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
      [`${id}_r${r.row_index}`, id, r.row_index, r.phone || '', r.name || '', JSON.stringify(r.variables || {})]
    );
  }
}

export async function getCampaigns() {
  return all(
    `SELECT id, name, template_name, status, delay_seconds, total, sent, failed, created_at, started_at
     FROM campaigns ORDER BY created_at DESC`
  );
}

export async function getCampaignById(id) {
  const c = await get(`SELECT * FROM campaigns WHERE id = ?`, [id]);
  if (!c) return null;
  c.param_mapping = JSON.parse(c.param_mapping || '[]');
  const recipients = await all(
    `SELECT id, row_index, phone, name, variables, status, error_message, run_at, sent_at
     FROM campaign_recipients WHERE campaign_id = ? ORDER BY row_index ASC`,
    [id]
  );
  c.recipients = recipients.map(r => ({ ...r, variables: JSON.parse(r.variables || '{}') }));
  return c;
}

export async function deleteCampaign(id) {
  await run(`DELETE FROM campaign_recipients WHERE campaign_id = ?`, [id]);
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
  const pending = await all(
    `SELECT id FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY row_index ASC`,
    [id]
  );
  const base = Date.now();
  for (let i = 0; i < pending.length; i++) {
    const runAt = new Date(base + i * delayMs).toISOString();
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
    `SELECT cr.*, c.template_name, c.language, c.category
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
    [status, error_message || null, status === 'sent' ? new Date().toISOString() : null, id]
  );
}

export async function incrementCampaignCounter(id, field) {
  if (field === 'sent') await run(`UPDATE campaigns SET sent = sent + 1 WHERE id = ?`, [id]);
  else if (field === 'failed') await run(`UPDATE campaigns SET failed = failed + 1 WHERE id = ?`, [id]);
}

export async function finalizeCampaignIfDone(id) {
  const row = await get(
    `SELECT COUNT(*) as pending FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending'`,
    [id]
  );
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
