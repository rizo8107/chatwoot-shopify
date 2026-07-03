import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const INSFORGE_URL = (process.env.INSFORGE_URL || '').replace(/\/$/, '');

// Stable signing secret for OUR OWN session cookie (independent of InsForge's
// own tokens). Prefer an explicit AUTH_SECRET; fall back to the private
// InsForge API key, which is already required and never exposed to the client.
const SECRET = process.env.AUTH_SECRET
  || (process.env.INSFORGE_API_KEY ? crypto.createHash('sha256').update(`session|${process.env.INSFORGE_API_KEY}`).digest('hex') : 'insecure-dev-secret');

export const COOKIE_NAME = 'app_session';
const TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

/** Auth is always required — InsForge is the identity provider and is already a hard dependency. */
export function authConfigured() {
  return true;
}

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

// ─── InsForge Auth (REST) ──────────────────────────────────────────────────
// Calls InsForge's Auth API directly (mobile client_type — returns tokens in
// the JSON body instead of relying on httpOnly cookies, which don't cross
// from InsForge's domain to ours). Used only to verify credentials; this
// app's own session cookie (below) is what actually gates /api routes.

async function insforgeRequest(path, body) {
  const res = await fetch(`${INSFORGE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function signInWithPassword(email, password) {
  if (!INSFORGE_URL) return { ok: false, status: 500, message: 'INSFORGE_URL is not configured' };
  const { ok, status, data } = await insforgeRequest('/api/auth/sessions?client_type=mobile', { email, password });
  if (!ok) {
    const message = status === 403
      ? 'Email not verified. Check your inbox for a verification code.'
      : (data?.message || 'Invalid email or password');
    return { ok: false, status, message };
  }
  return { ok: true, user: data.user };
}

export async function sendResetPasswordEmail(email, redirectTo) {
  const { ok, data } = await insforgeRequest('/api/auth/email/send-reset-password', { email, redirectTo });
  return { ok, message: data?.message };
}

export async function resetPasswordWithCode(email, code, newPassword) {
  const exchange = await insforgeRequest('/api/auth/email/exchange-reset-password-token', { email, code });
  if (!exchange.ok || !exchange.data?.token) {
    return { ok: false, message: exchange.data?.message || 'Invalid or expired code' };
  }
  const reset = await insforgeRequest('/api/auth/email/reset-password', { newPassword, otp: exchange.data.token });
  if (!reset.ok) return { ok: false, message: reset.data?.message || 'Failed to reset password' };
  return { ok: true };
}

// ─── App session cookie (unchanged mechanism, now backed by InsForge identity) ─

export function createToken(email) {
  const payload = Buffer.from(JSON.stringify({ e: email, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  if (!sig || sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return { email: p.e };
  } catch { return null; }
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export function sessionCookie(token, clear = false) {
  const secure = process.env.NODE_ENV === 'production';
  const base = `${COOKIE_NAME}=${clear ? '' : token}; HttpOnly; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${Math.floor(TTL_MS / 1000)}`;
}

export function currentUser(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}
