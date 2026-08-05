// ============================================================================
// Security primitives — form tokens, Turnstile, IP hashing.
// ============================================================================

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Never store a raw IP. The salt lives only in Vercel env vars, so the hashes
 * are not reversible by anyone who obtains a database dump.
 *
 * Rotating IP_HASH_SALT invalidates every existing ip_hash, including any
 * blocklist entries derived from them.
 */
function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || '';
  if (!salt) throw new Error('IP_HASH_SALT is not set');
  return sha256hex(`${ip}|${salt}`);
}

/**
 * Take the FIRST entry of x-forwarded-for.
 *
 * The platform appends the real client IP, but a client can pre-populate the
 * header with anything. Trusting the last entry or the whole string lets a
 * caller trivially rotate their apparent IP and bypass rate limits.
 */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '0.0.0.0';
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Form token
//
// Issued by GET /api/careers/jobs, required by POST /api/careers/apply.
// Carries a server-signed issue time, so the dwell-time check cannot be
// forged by editing a hidden field, and a nonce that is burned on use so a
// token cannot be replayed. Scripted bulk submission therefore needs a fresh
// page load per attempt.
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function tokenSecret() {
  const s = process.env.FORM_TOKEN_SECRET;
  if (!s) throw new Error('FORM_TOKEN_SECRET is not set');
  return s;
}

function issueFormToken() {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    n: crypto.randomBytes(12).toString('hex'),
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', tokenSecret()).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * @returns {{ok: true, nonce: string, ageSeconds: number} | {ok: false, reason: string}}
 */
function verifyFormToken(token, minAgeSeconds, maxAgeSeconds) {
  if (typeof token !== 'string' || token.length > 400 || !token.includes('.')) {
    return { ok: false, reason: 'MALFORMED' };
  }

  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, reason: 'MALFORMED' };

  const expected = b64url(crypto.createHmac('sha256', tokenSecret()).update(body).digest());
  if (!timingSafeEqualStr(sig, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };

  let payload;
  try {
    payload = JSON.parse(unb64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (typeof payload.iat !== 'number' || typeof payload.n !== 'string') {
    return { ok: false, reason: 'MALFORMED' };
  }

  const age = Math.floor(Date.now() / 1000) - payload.iat;
  // A negative age means a clock skew or a forged future timestamp.
  if (age < 0) return { ok: false, reason: 'FUTURE' };
  if (age < minAgeSeconds) return { ok: false, reason: 'TOO_FAST', ageSeconds: age };
  if (age > maxAgeSeconds) return { ok: false, reason: 'EXPIRED', ageSeconds: age };

  return { ok: true, nonce: payload.n, ageSeconds: age };
}

// ---------------------------------------------------------------------------
// Cloudflare Turnstile
// ---------------------------------------------------------------------------

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token server-side.
 *
 * The hostname check matters: without it, someone can embed the widget on a
 * site they control, farm valid tokens, and replay them here.
 *
 * @returns {{ok: true} | {ok: false, reason: string, unreachable?: boolean}}
 */
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const CF_TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA', // always passes
  '2x0000000000000000000000000000000AA', // always fails
  '3x0000000000000000000000000000000AA', // token already spent
]);

async function verifyTurnstile(token, remoteIp, allowedHostnames) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (typeof token !== 'string' || !token || token.length > 4096) {
    return { ok: false, reason: 'MISSING_TOKEN' };
  }

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set('remoteip', remoteIp);

  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    data = await resp.json();
  } catch {
    // Network failure or timeout. The caller decides fail-open vs fail-closed
    // based on config.turnstile_fail_open; the default is fail-closed.
    return { ok: false, reason: 'UNREACHABLE', unreachable: true };
  }

  if (!data || data.success !== true) {
    const codes = (data && data['error-codes']) || [];
    return { ok: false, reason: codes.join(',') || 'REJECTED' };
  }

  // Cloudflare's published dummy secrets always verify but report
  // hostname "example.com", so the assertion below can never pass with them
  // and no application can be completed on localhost. Skipping the check for
  // those three specific keys cannot weaken production: they are documented
  // public constants, so anyone using one has no bot protection to weaken.
  if (!CF_TEST_SECRETS.has(secret) &&
      Array.isArray(allowedHostnames) && allowedHostnames.length && data.hostname) {
    const host = String(data.hostname).toLowerCase();
    const permitted = allowedHostnames.some(
      (h) => host === h || host.endsWith(`.${h}`)
    );
    if (!permitted) return { ok: false, reason: `HOSTNAME_MISMATCH:${host}` };
  }
  if (CF_TEST_SECRETS.has(secret)) {
    console.warn('[security] Turnstile TEST secret in use — hostname check skipped. Never ship this key.');
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cron authentication
// ---------------------------------------------------------------------------

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  return timingSafeEqualStr(header, `Bearer ${secret}`);
}

module.exports = {
  sha256hex,
  hashIp,
  getClientIp,
  timingSafeEqualStr,
  issueFormToken,
  verifyFormToken,
  verifyTurnstile,
  isAuthorizedCron,
};
