import crypto from 'node:crypto';

const API_VERSION = '2024-01';

// Webhook topics auto-registered after a successful OAuth connect.
const WEBHOOK_TOPICS = ['orders/create', 'orders/paid', 'checkouts/create', 'checkouts/update', 'fulfillments/create'];

/** Validate a shop domain to prevent SSRF / open-redirect (must be *.myshopify.com). */
export function isValidShop(shop) {
  return typeof shop === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

/** Normalise user input (e.g. "https://foo.myshopify.com/") to "foo.myshopify.com". */
export function normalizeShop(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (s && !s.includes('.')) s = `${s}.myshopify.com`;
  return s;
}

export function buildInstallUrl({ shop, apiKey, scopes, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: scopes,
    redirect_uri: redirectUri,
    state
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

/** Verify the HMAC on an OAuth callback query (Shopify signs all params except hmac). */
export function verifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || typeof hmac !== 'string' || !secret) return false;
  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hmac, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Exchange an authorization code for a permanent Admin API access token. */
export async function exchangeToken({ shop, apiKey, apiSecret, code }) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Token exchange failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ''})`);
  }
  return { accessToken: body.access_token, scope: body.scope || '' };
}

/** Register the automation webhooks. Idempotent — duplicates (422) are ignored. */
export async function registerWebhooks({ shop, token, appUrl }) {
  const address = `${appUrl.replace(/\/$/, '')}/api/webhook/shopify`;
  const results = [];
  for (const topic of WEBHOOK_TOPICS) {
    try {
      const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/webhooks.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ webhook: { topic, address, format: 'json' } })
      });
      results.push({ topic, ok: res.ok || res.status === 422, status: res.status });
    } catch (err) {
      results.push({ topic, ok: false, error: err.message });
    }
  }
  return results;
}

/** Fetch abandoned checkouts (open checkouts that were never completed). */
export async function fetchAbandonedCheckouts({ shop, token, limit = 50 }) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/checkouts.json?limit=${limit}`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Fetch abandoned checkouts failed (HTTP ${res.status})`);
  return body.checkouts || [];
}

export { WEBHOOK_TOPICS, API_VERSION };
