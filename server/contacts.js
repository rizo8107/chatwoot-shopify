import { normalizePhone, resolveContactId } from './chatwoot.js';

const PAGE_SIZE = 15; // Chatwoot contacts list page size

function cw(settings) {
  const apiBaseUrl = (settings.CHATWOOT_API_URL || '').replace(/\/$/, '');
  const token = settings.CHATWOOT_API_TOKEN;
  const accountId = settings.CHATWOOT_ACCOUNT_ID || '1';
  const inboxId = parseInt(settings.CHATWOOT_INBOX_ID || '1', 10);
  if (!apiBaseUrl || !token) throw new Error('Chatwoot API not configured in Settings');
  return { apiBaseUrl, token, accountId, inboxId };
}

function normalizeContact(c) {
  return {
    id: c.id,
    name: c.name || '',
    email: c.email || '',
    phone: c.phone_number || '',
    created_at: c.created_at || null,          // unix seconds in Chatwoot
    custom_attributes: c.custom_attributes || {},
    additional_attributes: c.additional_attributes || {}
  };
}

/** Fetch contacts from Chatwoot, paginated, up to maxPages. */
export async function fetchChatwootContacts({ settings, maxPages = 20 }) {
  const { apiBaseUrl, token, accountId } = cw(settings);
  const cap = Math.min(Math.max(parseInt(maxPages, 10) || 20, 1), 100);
  const out = [];

  for (let page = 1; page <= cap; page++) {
    const url = `${apiBaseUrl}/api/v1/accounts/${accountId}/contacts?page=${page}&sort=-last_activity_at`;
    const res = await fetch(url, { headers: { api_access_token: token } });
    if (!res.ok) throw new Error(`Chatwoot contacts fetch failed (HTTP ${res.status})`);
    const body = await res.json();
    const payload = Array.isArray(body) ? body : (body.payload || []);
    if (payload.length === 0) break;
    for (const c of payload) out.push(normalizeContact(c));
    if (payload.length < PAGE_SIZE) break;
  }
  return out;
}

/** Bulk-create contacts in Chatwoot from rows [{ name, phone, email }]. Reuses existing contacts. */
export async function importContacts({ settings, rows }) {
  const { apiBaseUrl, token, accountId, inboxId } = cw(settings);
  let imported = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { formattedPhone, sourceId } = normalizePhone(row.phone, '');
    if (!formattedPhone) { failed++; errors.push({ row: i + 1, error: 'No valid phone' }); continue; }
    try {
      await resolveContactId({
        apiBaseUrl, accountId, token, inboxId,
        name: row.name || formattedPhone, phone: formattedPhone, email: row.email || undefined, sourceId
      });
      imported++;
    } catch (err) {
      failed++;
      errors.push({ row: i + 1, phone: formattedPhone, error: err.message });
    }
  }
  return { imported, failed, total: rows.length, errors: errors.slice(0, 50) };
}
