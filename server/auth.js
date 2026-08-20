import crypto from 'node:crypto';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { getAppUserByEmail } from './db.js';

dotenv.config();

// Stable signing secret for the app's own session cookie.
const SECRET = process.env.AUTH_SECRET
  || (process.env.DATABASE_URL ? crypto.createHash('sha256').update(`session|${process.env.DATABASE_URL}`).digest('hex') : 'insecure-dev-secret');

export const COOKIE_NAME = 'app_session';
const TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

/** Authentication is backed by the local PostgreSQL app_users table. */
export function authConfigured() {
  return true;
}

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

// ─── InsForge Auth (REST) ──────────────────────────────────────────────────
// Password hashes and verification status are stored in app_users.

export async function signInWithPassword(email, password) {
  const user = await getAppUserByEmail(email);
  if (!user || !password || !await bcrypt.compare(String(password), user.password_hash)) {
    return { ok: false, status: 401, message: 'Invalid email or password' };
  }
  if (!user.email_verified) return { ok: false, status: 403, message: 'Email is not verified' };
  return { ok: true, user: { email: user.email } };
}

export async function sendResetPasswordEmail() {
  return { ok: false, message: 'Password reset email is not configured for standalone PostgreSQL' };
}

export async function resetPasswordWithCode() {
  return { ok: false, message: 'Password reset is not configured for standalone PostgreSQL' };
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
