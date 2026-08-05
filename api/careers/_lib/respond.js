// ============================================================================
// Response helpers — CORS, security headers, uniform JSON shape.
//
// Files under api/careers/_lib/ are shared modules, not routes. Even if the
// platform did route them, function source is never served as static text
// (verified: /api/terms.js returns HTML, not JavaScript).
// ============================================================================

'use strict';

const ALLOWED_ORIGINS = [
  'https://www.boostowl.io',
  'https://boostowl.io',
];

// Preview deploys and local dev. Never matched in production.
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (DEV_ORIGIN_RE.test(origin)) return true;
  if (PREVIEW_ORIGIN_RE.test(origin)) return true;
  return false;
}

/**
 * Origin/Referer check. Weak on its own — a non-browser client can send any
 * Origin — but it filters lazy scripts for free and costs nothing.
 * Turnstile and the signed form token are the real controls.
 */
function checkOrigin(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Same-origin form posts may omit Origin entirely; fall back to Referer.
  if (!origin && referer) {
    try {
      return isAllowedOrigin(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return isAllowedOrigin(origin);
}

function setCommonHeaders(req, res) {
  const origin = req.headers.origin;

  // Explicit origin echo, never '*'. No credentials are ever sent.
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function json(req, res, status, body, extraHeaders) {
  setCommonHeaders(req, res);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body));
}

/** Uniform error shape. `code` is machine-readable; `message` is shown to the user. */
function fail(req, res, status, code, message, extra) {
  return json(req, res, status, Object.assign({ ok: false, code, message }, extra || {}));
}

function ok(req, res, body) {
  return json(req, res, 200, Object.assign({ ok: true }, body || {}));
}

/** CORS preflight. Returns true if the request was handled. */
function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  setCommonHeaders(req, res);
  res.status(204).end();
  return true;
}

module.exports = {
  ALLOWED_ORIGINS,
  isAllowedOrigin,
  checkOrigin,
  setCommonHeaders,
  json,
  fail,
  ok,
  handlePreflight,
};
