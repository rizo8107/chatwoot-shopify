import sqlite3 from 'sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbDir = process.env.DATA_DIR || join(__dirname, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = join(dbDir, 'logs.db');
const db = new sqlite3.Database(dbPath);

const run = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));

const all = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); }));

const get = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); }));

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
  try { await run(`ALTER TABLE transactions ADD COLUMN flow_id TEXT`); } catch (_) {}
  try { await run(`ALTER TABLE transactions ADD COLUMN type TEXT DEFAULT 'webhook'`); } catch (_) {}

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

  console.log(`[DB] Initialized at ${dbPath}`);
}

// ─── Transactions ─────────────────────────────────────────────────────────

export async function logTransaction({ id, flow_id, order_number, customer_name, phone_number, status, type, steps, error_message }) {
  await run(
    `INSERT OR REPLACE INTO transactions (id, flow_id, order_number, customer_name, phone_number, status, type, created_at, steps, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    total: stats.total || 0,
    success: stats.success || 0,
    failed: stats.failed || 0,
    processing: stats.processing || 0
  };
}

// ─── Settings ─────────────────────────────────────────────────────────────

const SETTING_KEYS = [
  'CHATWOOT_API_URL', 'CHATWOOT_API_TOKEN', 'CHATWOOT_ACCOUNT_ID', 'CHATWOOT_INBOX_ID',
  'WHATSAPP_TEMPLATE_NAME', 'WHATSAPP_TEMPLATE_MAPPING',
  'WHATSAPP_SHIPPING_TEMPLATE_NAME', 'WHATSAPP_SHIPPING_TEMPLATE_MAPPING',
  'WHATSAPP_ABANDONED_CART_TEMPLATE_NAME', 'WHATSAPP_ABANDONED_CART_TEMPLATE_MAPPING',
  'SHOPIFY_STORE_URL', 'SHOPIFY_ADMIN_TOKEN'
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
    await run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, String(value)]);
  }
}

// ─── Flows ────────────────────────────────────────────────────────────────

export async function saveFlow({ id, name, description, trigger_event, nodes, edges, is_active }) {
  const now = new Date().toISOString();
  await run(
    `INSERT OR REPLACE INTO flows (id, name, description, trigger_event, nodes, edges, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM flows WHERE id = ?), ?), ?)`,
    [id, name, description || '', trigger_event, JSON.stringify(nodes), JSON.stringify(edges), is_active ? 1 : 0, id, now, now]
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
