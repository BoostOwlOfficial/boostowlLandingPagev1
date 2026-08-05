// ============================================================================
// Supabase over plain HTTP — no npm dependency.
//
// Uses the service_role key, which bypasses RLS. That key exists only in
// Vercel environment variables and never reaches the browser.
// ============================================================================

'use strict';

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function baseUrl() {
  return env('SUPABASE_URL').replace(/\/+$/, '');
}

function headers(extra) {
  const key = env('SUPABASE_SERVICE_KEY');
  return Object.assign(
    {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    extra || {}
  );
}

async function withTimeout(fn, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.code = 'TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call a Postgres function.
 * @param {string} fn    function name
 * @param {object} args  named arguments
 */
async function rpc(fn, args, timeoutMs = 8000) {
  return withTimeout(async (signal) => {
    const resp = await fetch(`${baseUrl()}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(args || {}),
      signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`rpc ${fn} failed: ${resp.status} ${text.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }, timeoutMs, `rpc ${fn}`);
}

/**
 * Read rows from a table or view.
 * @param {string} table
 * @param {object} opts  { select, filters: {col: 'eq.value'}, order, limit }
 */
async function select(table, opts = {}, timeoutMs = 8000) {
  const params = new URLSearchParams();
  params.set('select', opts.select || '*');
  for (const [col, expr] of Object.entries(opts.filters || {})) params.set(col, expr);
  if (opts.order) params.set('order', opts.order);
  if (opts.limit) params.set('limit', String(opts.limit));

  return withTimeout(async (signal) => {
    const resp = await fetch(`${baseUrl()}/rest/v1/${table}?${params}`, {
      method: 'GET',
      headers: headers(),
      signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`select ${table} failed: ${resp.status} ${text.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }
    return text ? JSON.parse(text) : [];
  }, timeoutMs, `select ${table}`);
}

/** Patch rows matching `filters`. */
async function update(table, filters, patch, timeoutMs = 8000) {
  const params = new URLSearchParams();
  for (const [col, expr] of Object.entries(filters || {})) params.set(col, expr);

  return withTimeout(async (signal) => {
    const resp = await fetch(`${baseUrl()}/rest/v1/${table}?${params}`, {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`update ${table} failed: ${resp.status} ${text.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }
    return true;
  }, timeoutMs, `update ${table}`);
}

/** Insert rows. */
async function insert(table, rows, timeoutMs = 8000) {
  return withTimeout(async (signal) => {
    const resp = await fetch(`${baseUrl()}/rest/v1/${table}`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(rows),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`insert ${table} failed: ${resp.status} ${text.slice(0, 400)}`);
      err.status = resp.status;
      throw err;
    }
    return true;
  }, timeoutMs, `insert ${table}`);
}

// ---------------------------------------------------------------------------
// Storage — private `resumes` bucket
// ---------------------------------------------------------------------------

const RESUME_BUCKET = 'resumes';

/**
 * Upload a resume.
 *
 * `path` is always `<job_slug>/<application_id>.pdf` — derived server-side and
 * never from the user-supplied filename.
 *
 * Content-Disposition: attachment means the PDF can never render inline in a
 * browser, even for us.
 */
async function uploadResume(path, buffer, timeoutMs = 15000) {
  return withTimeout(async (signal) => {
    const key = env('SUPABASE_SERVICE_KEY');
    const resp = await fetch(
      `${baseUrl()}/storage/v1/object/${RESUME_BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment',
          'x-upsert': 'false',
          'Cache-Control': 'private, max-age=0, no-store',
        },
        body: buffer,
        signal,
      }
    );
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`upload failed: ${resp.status} ${text.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }
    return true;
  }, timeoutMs, 'storage upload');
}

/** Short-lived signed URL for reviewing a resume. Never make the bucket public. */
async function signResumeUrl(path, expiresInSeconds = 300, timeoutMs = 8000) {
  const body = await withTimeout(async (signal) => {
    const resp = await fetch(
      `${baseUrl()}/storage/v1/object/sign/${RESUME_BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
        signal,
      }
    );
    if (!resp.ok) throw new Error(`sign failed: ${resp.status}`);
    return resp.json();
  }, timeoutMs, 'storage sign');

  return `${baseUrl()}/storage/v1${body.signedURL}`;
}

async function deleteResume(path, timeoutMs = 8000) {
  return withTimeout(async (signal) => {
    const resp = await fetch(
      `${baseUrl()}/storage/v1/object/${RESUME_BUCKET}/${encodeURI(path)}`,
      { method: 'DELETE', headers: headers(), signal }
    );
    return resp.ok;
  }, timeoutMs, 'storage delete');
}

async function downloadResume(path, timeoutMs = 15000) {
  return withTimeout(async (signal) => {
    const key = env('SUPABASE_SERVICE_KEY');
    const resp = await fetch(
      `${baseUrl()}/storage/v1/object/${RESUME_BUCKET}/${encodeURI(path)}`,
      { method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}` }, signal }
    );
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }, timeoutMs, 'storage download');
}

module.exports = {
  rpc,
  select,
  update,
  insert,
  uploadResume,
  signResumeUrl,
  deleteResume,
  downloadResume,
  RESUME_BUCKET,
};
