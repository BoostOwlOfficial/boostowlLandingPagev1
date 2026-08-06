// ============================================================================
// Config loader.
//
// Every threshold lives in the `config` table so it can be changed without a
// deploy — but each one is CLAMPED here. Config can make a limit stricter,
// never looser. A typo (2097152 -> 20971520) or a compromised dashboard login
// cannot disable a safety limit.
//
// Reference: CAREERS-ADMIN.md §3
// ============================================================================

'use strict';

const { rpc } = require('./supabase');

// ---------------------------------------------------------------------------
// Hard ceilings. These are the redline; config is the throttle.
// ---------------------------------------------------------------------------
const CEILINGS = {
  // 2.5 MB. MUST stay well under apply.js MAX_BODY_BYTES (4 MB), because the
  // PDF travels base64-encoded inside the JSON body and base64 inflates by 4/3:
  //   2,621,440 bytes -> 3,495,256 encoded + ~20 KB of form fields ~= 3.35 MB.
  // A 4 MB ceiling here would let an admin set a value that is physically
  // unsendable (5.59 MB body) and every upload at that size would 413.
  resume_max_bytes:     2621440,
  rate_limit_ip_hour:   20,
  rate_limit_ip_day:    50,
  rate_limit_ip_week:   100,
  rate_limit_email_30d: 20,
  rate_limit_phone_30d: 20,
  global_cap_hour:      500,
  global_cap_day:       2000,
  ai_daily_cap:         500,
  ai_monthly_budget_usd: 50,
  ai_batch_size:        25,
  ai_max_attempts:      5,
  retention_days:       3650,
  storage_soft_limit_bytes: 5 * 1024 * 1024 * 1024,
};

// Minimums that config cannot go below.
const FLOORS = {
  min_form_dwell_seconds: 2,
  retention_days:         30,
};

const DEFAULTS = {
  applications_open:        true,
  maintenance_message:      'We are not accepting applications right now. Please check back soon.',
  resume_upload_enabled:    true,
  // NB: there is no global `resume_required`. Whether a CV is mandatory is a
  // PER-ROLE decision — jobs.resume_mode ('required'|'optional'|'disabled') —
  // read in apply.js. A global key here was dead weight that an admin portal
  // would have rendered as a working toggle.
  resume_max_bytes:         2 * 1024 * 1024,
  turnstile_enabled:        true,
  turnstile_fail_open:      false,
  min_form_dwell_seconds:   5,
  rate_limit_ip_hour:       3,
  rate_limit_ip_day:        10,
  rate_limit_ip_week:       20,
  rate_limit_email_30d:     3,
  rate_limit_phone_30d:     3,
  global_cap_hour:          60,
  global_cap_day:           300,
  storage_soft_limit_bytes: 800000000,
  ai_scoring_enabled:       false,
  ai_default_for_new_jobs:  false,
  // Vendor-neutral. See _lib/ai.js — anthropic | openai | google | openai_compatible
  ai_provider:              'anthropic',
  ai_model:                 'claude-haiku-4-5',
  ai_base_url:              '',        // '' = provider default; required for openai_compatible
  ai_price_in_per_mtok:     1.0,       // USD/million input tokens  (Haiku 4.5 default)
  ai_price_out_per_mtok:    5.0,       // USD/million output tokens
  ai_daily_cap:             100,
  ai_monthly_budget_usd:    10,
  ai_include_resume_pdf:    true,
  ai_batch_size:            10,
  ai_max_attempts:          3,
  ai_queue_expiry_days:     30,
  notify_email_enabled:     true,
  notify_email_to:          'admin@boostowl.io',
  notify_email_from:        'careers@boostowl.io',
  notify_ack_candidate:     false,

  // Email templates. Blank = use the built-in HTML in _lib/email.js, so a
  // cleared template degrades to the default rather than sending an empty mail.
  // Placeholders are {{reference}}, {{job_title}}, {{full_name}}, ... see
  // email.js TEMPLATE_VARS and CAREERS-ADMIN.md §6.
  email_alert_subject:      '',
  email_alert_html:         '',
  email_ack_subject:        '',
  email_ack_html:           '',

  // Attach the CV to the internal alert. OFF by default on purpose: it copies
  // applicant PII into a mailbox that the retention purge cannot reach.
  email_attach_resume:      false,
  alert_email_to:           'admin@boostowl.io',
  retention_days:           365,
  consent_version:          'unversioned',
  consent_text:             '',
  blocked_email_domains:    [],
  blocked_emails:           [],
  blocked_ip_hashes:        [],
  form_options:             {},
  departments:              [],
  careers_page:             {},
  hero_stats:               [],
  hiring_process:           [],
  careers_faq:              [],
};

// The form-token maximum age is deliberately NOT configurable.
const FORM_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60;

// ---------------------------------------------------------------------------
// Environment overrides.
//
// PRECEDENCE:  env var  >  config table row  >  DEFAULTS
//
// Only WHICH MODEL to call is overridable — those genuinely differ between
// environments (point local dev at Ollama while production runs Claude).
//
// `ai_scoring_enabled` is deliberately NOT here. Whether scoring runs at all
// is a two-level database control by design — config.ai_scoring_enabled as the
// master and jobs.ai_enabled per role — so that it stays switchable from the
// Supabase dashboard (or a future admin portal) with no deploy and exactly one
// place to look. Adding an env override would create a second, invisible
// source of truth for the same decision.
//
// TRADE-OFF, and it matters: a Vercel env var change needs a REDEPLOY to take
// effect. A config row is live in 60s. So env is right for local/preview, and
// the config table is still the correct way to switch production.
//
// An empty string is treated as "not set", so a blank in .env.local does not
// silently blank out a real config value.
// ---------------------------------------------------------------------------
const ENV_OVERRIDES = {
  ai_provider:           'AI_PROVIDER',
  ai_model:              'AI_MODEL',
  ai_base_url:           'AI_BASE_URL',
  ai_price_in_per_mtok:  'AI_PRICE_IN_PER_MTOK',
  ai_price_out_per_mtok: 'AI_PRICE_OUT_PER_MTOK',
};

/** Returns {key: value} for every override actually present in the env. */
function readEnvOverrides() {
  const out = {};
  for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
    const raw = process.env[envName];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    out[key] = String(raw).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache. Module scope survives warm invocations, so a burst of applications
// costs one config read rather than one per request.
// ---------------------------------------------------------------------------
let cache = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

function clampNumber(key, raw) {
  let value = Number(raw);
  if (!Number.isFinite(value)) value = DEFAULTS[key];

  const ceiling = CEILINGS[key];
  if (ceiling !== undefined && value > ceiling) {
    console.warn(`[config] ${key}=${value} exceeds ceiling ${ceiling}; clamped`);
    value = ceiling;
  }
  const floor = FLOORS[key];
  if (floor !== undefined && value < floor) {
    console.warn(`[config] ${key}=${value} below floor ${floor}; clamped`);
    value = floor;
  }
  if (value < 0) value = 0;
  return value;
}

function normalize(raw) {
  const out = Object.assign({}, DEFAULTS);

  for (const [key, value] of Object.entries(raw || {})) {
    if (!(key in DEFAULTS)) {
      out[key] = value; // forward-compatible: an unknown key passes through
      continue;
    }
    const def = DEFAULTS[key];
    if (typeof def === 'number') out[key] = clampNumber(key, value);
    else if (typeof def === 'boolean') out[key] = value === true || value === 'true';
    else out[key] = value;
  }

  // Turnstile off is legitimate but never quiet.
  if (out.turnstile_enabled !== true) {
    console.warn('[config] SECURITY: turnstile_enabled is false — bot protection is OFF');
  }
  if (out.turnstile_fail_open === true) {
    console.warn('[config] SECURITY: turnstile_fail_open is true — set back to false after the outage');
  }

  return out;
}

/**
 * Load config, cached for 60s.
 *
 * If the database is unreachable we serve the last good copy however stale it
 * is; only a cold start with no cache falls back to DEFAULTS. Note that
 * DEFAULTS has applications_open=true, so a cold start during an outage will
 * accept applications — every other limit still applies.
 */
async function getConfig(force = false) {
  const now = Date.now();
  if (!force && cache && now - cachedAt < CACHE_TTL_MS) return cache;

  const overrides = readEnvOverrides();

  try {
    const raw = await rpc('get_config', {}, 5000);
    // Env last, so it wins. normalize() then applies the same type coercion
    // and ceilings it applies to database values — an env var cannot bypass
    // a limit any more than a config row can.
    cache = normalize(Object.assign({}, raw || {}, overrides));
    cachedAt = now;
    logOverridesOnce(overrides);
    return cache;
  } catch (err) {
    console.error('[config] load failed:', err.message);
    if (cache) return cache;
    return normalize(overrides);
  }
}

let loggedOverrides = false;
function logOverridesOnce(overrides) {
  if (loggedOverrides) return;
  loggedOverrides = true;
  const keys = Object.keys(overrides);
  if (keys.length) {
    console.log('[config] env overrides active (config table ignored for these):', keys.join(', '));
  }
}

function invalidateConfigCache() {
  cache = null;
  cachedAt = 0;
}

module.exports = {
  getConfig,
  invalidateConfigCache,
  readEnvOverrides,
  CEILINGS,
  FLOORS,
  DEFAULTS,
  ENV_OVERRIDES,
  FORM_TOKEN_MAX_AGE_SECONDS,
  CACHE_TTL_MS,
};
