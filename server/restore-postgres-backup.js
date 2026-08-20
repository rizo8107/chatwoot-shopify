import fs from 'node:fs';
import zlib from 'node:zlib';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const backupPath = process.argv[2];
if (!backupPath) throw new Error('Usage: node server/restore-postgres-backup.js <backup.sql.gz>');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');

const APP_TABLES = new Set([
  'abandoned_cart_flows', 'abandoned_cart_jobs', 'abandoned_cart_messages',
  'abandoned_carts', 'campaign_message_logs', 'campaign_recipients', 'campaigns',
  'flows', 'google_reviews', 'google_reviews_meta', 'pending_delivery_updates',
  'scheduled_jobs', 'sent_notifications', 'settings', 'transactions', 'webhook_retries'
]);

function decodeCopyValue(value) {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|.)/g, (_match, escaped) => {
    if (/^[0-7]+$/.test(escaped)) return String.fromCharCode(Number.parseInt(escaped, 8));
    return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' })[escaped] ?? escaped;
  });
}

function readCopies(sql) {
  const copies = [];
  const expression = /^COPY public\.([^\s(]+) \(([^\n]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\r?$/gm;
  for (const match of sql.matchAll(expression)) {
    if (!APP_TABLES.has(match[1])) continue;
    const columns = match[2].split(',').map(column => column.trim());
    const rows = match[3].split(/\r?\n/).filter(Boolean).map(line => line.split('\t').map(decodeCopyValue));
    copies.push({ table: match[1], columns, rows });
  }
  return copies;
}

async function insertRows(client, table, columns, rows) {
  const quotedColumns = columns.map(column => `"${column}"`).join(', ');
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const values = [];
    const tuples = batch.map(row => {
      const placeholders = row.map(value => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO public."${table}" (${quotedColumns}) VALUES ${tuples.join(', ')}` , values);
  }
}

const sql = zlib.gunzipSync(fs.readFileSync(backupPath)).toString('utf8');
const copies = readCopies(sql);
if (copies.length !== APP_TABLES.size) {
  throw new Error(`Backup contains ${copies.length}/${APP_TABLES.size} expected application tables`);
}

const authMatch = sql.match(/^COPY auth\.users \(([^\n]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\r?$/m);
if (!authMatch) throw new Error('Backup does not contain auth.users');
const authColumns = authMatch[1].split(',').map(column => column.trim());
const authRows = authMatch[2].split(/\r?\n/).filter(Boolean).map(line => line.split('\t').map(decodeCopyValue));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.DATABASE_SSL ?? 'true').toLowerCase() === 'false' ? false : { rejectUnauthorized: false }
});
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const tables = [...APP_TABLES, 'app_users'].map(table => `public."${table}"`).join(', ');
  await client.query(`TRUNCATE ${tables}`);
  for (const copy of copies) await insertRows(client, copy.table, copy.columns, copy.rows);

  const emailIndex = authColumns.indexOf('email');
  const passwordIndex = authColumns.indexOf('password');
  const verifiedIndex = authColumns.indexOf('email_verified');
  const createdIndex = authColumns.indexOf('created_at');
  for (const row of authRows) {
    await client.query(
      `INSERT INTO app_users (email, password_hash, email_verified, created_at) VALUES ($1, $2, $3, $4)`,
      [row[emailIndex], row[passwordIndex], row[verifiedIndex] === 't', row[createdIndex]]
    );
  }

  // A week-old backup can contain due automation jobs that may already have
  // executed before the source database was paused. Quarantine them to prevent
  // duplicate customer messages immediately after migration.
  const quarantined = await client.query(
    `UPDATE abandoned_cart_jobs
       SET status = 'cancelled', error_message = 'Quarantined during database migration'
     WHERE status = 'pending'`
  );
  await client.query('COMMIT');

  const restored = Object.fromEntries(copies.map(copy => [copy.table, copy.rows.length]));
  console.log(JSON.stringify({ restored, users: authRows.length, quarantinedJobs: quarantined.rowCount }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
