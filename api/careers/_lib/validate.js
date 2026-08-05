// ============================================================================
// Field validation.
//
// Rules:
//   1. Everything is validated server-side. Client validation is UX only.
//   2. Unknown keys are rejected, never ignored.
//   3. Every field has a length or range limit.
//   4. Question DEFINITIONS come from our database (trusted). ANSWERS come
//      from the internet (untrusted) and are validated against the spec.
//
// Reference: CAREERS-ADMIN.md §5, plan §3
// ============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Limits that config cannot raise.
// ---------------------------------------------------------------------------
const LIMITS = {
  full_name:        { min: 2,  max: 80 },
  email:            { min: 5,  max: 254 },
  phone_digits:     { min: 8,  max: 15 },
  location_city:    { min: 2,  max: 60 },
  why_boostowl:     { min: 50, max: 600 },
  url:              { max: 500 },
  utm_source:       { max: 100 },
  answer_short:     { max: 200 },
  answer_long:      { max: 1000 },
  answer_multi:     { max: 10 },
  max_questions:    { max: 10 },
  custom_answers_bytes: 4096,
};

// Keys accepted by POST /api/careers/apply. Anything else is a 400.
const ALLOWED_PAYLOAD_KEYS = new Set([
  'job_slug', 'full_name', 'email', 'phone', 'location_city',
  'experience_bucket', 'notice_period', 'expected_ctc_band', 'source',
  'linkedin_url', 'portfolio_url', 'github_url', 'why_boostowl',
  'custom_answers', 'resume', 'consent', 'form_token', 'turnstile_token',
  'hp_subject', 'utm_source',

  // LEGACY, accepted but never read. `hp_company` was the honeypot until
  // Chrome started autofilling it (it matches the "organization" category) and
  // silently binned real applications. Assets are browser-cached for hours, so
  // for a while after a deploy some visitors still post the old key. Accepting
  // and ignoring it lets those submissions through; rejecting it turned a
  // stale cache into a dead end. apply.js reads hp_subject only.
  'hp_company',
]);

// ---------------------------------------------------------------------------
// Text hygiene — applied to every free-text field.
// ---------------------------------------------------------------------------

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars (keeps \t \n \r)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')            // zero-width
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')     // bidi overrides
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Neutralise spreadsheet formula injection. A cell beginning = + - @ is
 * executed by Excel and Sheets on open. Applied at export, and stored safe.
 */
function csvSafe(value) {
  if (typeof value !== 'string' || !value) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function countLetters(s) {
  const m = s.match(/\p{L}/gu);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Normalise for dedupe: lowercase, strip +aliases, strip dots in gmail
 * local-parts. So R.Sharma+jobs@gmail.com and rsharma@gmail.com are correctly
 * recognised as the same person applying twice.
 */
function normalizeEmail(email) {
  const lower = String(email).trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;

  let local = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  const GMAIL = new Set(['gmail.com', 'googlemail.com']);
  if (GMAIL.has(domain)) local = local.replace(/\./g, '');

  return `${local}@${GMAIL.has(domain) ? 'gmail.com' : domain}`;
}

function validateEmail(raw, config) {
  const email = sanitizeText(raw).toLowerCase();

  if (!email) return { ok: false, message: 'Email is required.' };
  if (email.length < LIMITS.email.min || email.length > LIMITS.email.max) {
    return { ok: false, message: 'That email address does not look right.' };
  }
  if (!EMAIL_RE.test(email)) {
    return { ok: false, message: 'That email address does not look right.' };
  }

  const normalized = normalizeEmail(email);
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);

  const blockedDomains = Array.isArray(config.blocked_email_domains) ? config.blocked_email_domains : [];
  if (blockedDomains.includes(domain)) {
    return { ok: false, message: 'Please use a permanent email address rather than a temporary one.' };
  }

  const blockedEmails = Array.isArray(config.blocked_emails) ? config.blocked_emails : [];
  if (blockedEmails.includes(normalized)) {
    // Deliberately generic — do not confirm to a blocked sender that they are blocked.
    return { ok: false, message: 'We could not accept this application.' };
  }

  return { ok: true, value: email, normalized };
}

// ---------------------------------------------------------------------------
// Phone — normalised to E.164, India assumed when no country code is given.
// ---------------------------------------------------------------------------

function normalizePhone(raw) {
  let s = String(raw || '').trim();
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;

  // An explicit country code is taken at face value.
  if (hadPlus) return `+${s}`;

  // Without one, the number must be a recognisable Indian mobile. Anything
  // else is ambiguous, and blindly prefixing '+' would turn a typo like
  // 1234512345 into a plausible-looking international number that passes
  // every later check. Reject and ask for a country code instead.
  if (s.length === 10 && /^[6-9]/.test(s)) return `+91${s}`;
  if (s.length === 11 && s.startsWith('0') && /^[6-9]/.test(s.slice(1))) return `+91${s.slice(1)}`;
  if (s.length === 12 && s.startsWith('91') && /^[6-9]/.test(s.slice(2))) return `+${s}`;
  return null;
}

function validatePhone(raw) {
  const e164 = normalizePhone(raw);
  if (!e164) {
    const given = String(raw || '').trim();
    return {
      ok: false,
      message: given
        ? 'That phone number does not look right. Use a 10-digit Indian mobile, or include the country code (e.g. +1 415 555 2671).'
        : 'Phone number is required.',
    };
  }

  const digits = e164.slice(1);
  if (digits.length < LIMITS.phone_digits.min || digits.length > LIMITS.phone_digits.max) {
    return { ok: false, message: 'That phone number does not look right.' };
  }
  // Obvious junk: 0000000000, 1111111111, 1234567890
  if (/^(\d)\1+$/.test(digits)) {
    return { ok: false, message: 'That phone number does not look right.' };
  }
  if ('01234567890123456789'.includes(digits) || '98765432109876543210'.includes(digits)) {
    return { ok: false, message: 'That phone number does not look right.' };
  }
  if (e164.startsWith('+91')) {
    const local = digits.slice(2);
    if (local.length !== 10 || !/^[6-9]/.test(local)) {
      return { ok: false, message: 'That does not look like a valid Indian mobile number.' };
    }
  }
  return { ok: true, value: e164 };
}

// ---------------------------------------------------------------------------
// URLs — https only, no private or loopback hosts.
// We never fetch these, but storing an internal URL that a reviewer might
// later click is still worth preventing.
// ---------------------------------------------------------------------------

const PRIVATE_HOST_RE =
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

function validateUrl(raw, { required = false, hostSuffix = null, label = 'link' } = {}) {
  const value = sanitizeText(raw);
  if (!value) {
    return required ? { ok: false, message: `${label} is required.` } : { ok: true, value: null };
  }
  if (value.length > LIMITS.url.max) {
    return { ok: false, message: `That ${label} is too long.` };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: `That ${label} is not a valid URL. Include https://` };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, message: `Please use an https:// ${label}.` };
  }
  if (PRIVATE_HOST_RE.test(url.hostname)) {
    return { ok: false, message: `That ${label} is not reachable publicly.` };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    return { ok: false, message: `Please use a domain name rather than an IP address.` };
  }
  if (hostSuffix) {
    const host = url.hostname.toLowerCase();
    const allowed = Array.isArray(hostSuffix) ? hostSuffix : [hostSuffix];
    if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
      return { ok: false, message: `That does not look like a ${allowed[0]} URL.` };
    }
  }
  return { ok: true, value: url.toString() };
}

// ---------------------------------------------------------------------------
// Enums — validated against config.form_options, so adding an option is a
// config edit rather than a deploy.
// ---------------------------------------------------------------------------

function validateEnum(raw, optionList, { required = true, label = 'value' } = {}) {
  const value = sanitizeText(raw);
  if (!value) {
    return required ? { ok: false, message: `Please choose a ${label}.` } : { ok: true, value: null };
  }
  const options = Array.isArray(optionList) ? optionList : [];
  const valid = options.some((o) => (typeof o === 'string' ? o : o && o.value) === value);
  if (!valid) return { ok: false, message: `Please choose a valid ${label}.` };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Custom questions — the dynamic part of the form.
// ---------------------------------------------------------------------------

/**
 * Validate answers against a job's question spec.
 *
 * Answer keys not present in the spec are REJECTED. A bot cannot smuggle in
 * extra fields or a large blob.
 */
function validateCustomAnswers(rawAnswers, questions) {
  const errors = {};
  const clean = {};

  const spec = Array.isArray(questions) ? questions.slice(0, LIMITS.max_questions.max) : [];
  const answers = rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers) ? rawAnswers : {};

  const knownIds = new Set(spec.map((q) => q && q.id).filter(Boolean));
  for (const key of Object.keys(answers)) {
    if (!knownIds.has(key)) {
      return { ok: false, errors: { custom_answers: 'Unexpected field in the form. Please reload and try again.' } };
    }
  }

  for (const q of spec) {
    if (!q || typeof q.id !== 'string') continue;
    const id = q.id;
    const required = q.required === true;
    const raw = answers[id];
    const label = q.label || id;

    const missing = raw === undefined || raw === null || raw === '' ||
                    (Array.isArray(raw) && raw.length === 0);
    if (missing) {
      if (required) errors[id] = 'This question is required.';
      continue;
    }

    switch (q.type) {
      case 'short_text':
      case 'long_text': {
        const max = Math.min(
          Number(q.max_length) || (q.type === 'long_text' ? LIMITS.answer_long.max : LIMITS.answer_short.max),
          q.type === 'long_text' ? LIMITS.answer_long.max : LIMITS.answer_short.max
        );
        const min = Math.max(0, Number(q.min_length) || 0);
        const text = sanitizeText(raw);
        if (text.length > max) { errors[id] = `Please keep this under ${max} characters.`; break; }
        if (text.length < min) { errors[id] = `Please write at least ${min} characters.`; break; }
        clean[id] = csvSafe(text);
        break;
      }

      case 'select': {
        const opts = Array.isArray(q.options) ? q.options : [];
        const text = sanitizeText(raw);
        if (!opts.includes(text)) { errors[id] = 'Please choose one of the listed options.'; break; }
        clean[id] = text;
        break;
      }

      case 'multi_select': {
        if (!Array.isArray(raw)) { errors[id] = 'Please choose from the listed options.'; break; }
        const opts = Array.isArray(q.options) ? q.options : [];
        const maxSelect = Math.min(Number(q.max_select) || LIMITS.answer_multi.max, LIMITS.answer_multi.max);
        if (raw.length > maxSelect) { errors[id] = `Please choose at most ${maxSelect}.`; break; }
        const picked = raw.map((v) => sanitizeText(v));
        if (!picked.every((v) => opts.includes(v))) { errors[id] = 'Please choose from the listed options.'; break; }
        clean[id] = Array.from(new Set(picked));
        break;
      }

      case 'boolean': {
        if (typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
          errors[id] = 'Please answer yes or no.'; break;
        }
        clean[id] = raw === true || raw === 'true';
        break;
      }

      case 'url': {
        const r = validateUrl(raw, { required, label });
        if (!r.ok) { errors[id] = r.message; break; }
        if (r.value) clean[id] = r.value;
        break;
      }

      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) { errors[id] = 'Please enter a number.'; break; }
        if (Math.abs(n) > 1e9) { errors[id] = 'That number is out of range.'; break; }
        if (q.min !== undefined && n < Number(q.min)) { errors[id] = `Minimum is ${q.min}.`; break; }
        if (q.max !== undefined && n > Number(q.max)) { errors[id] = `Maximum is ${q.max}.`; break; }
        clean[id] = n;
        break;
      }

      default:
        // Unknown type in the spec — our config problem, not the candidate's.
        console.warn(`[validate] unknown question type "${q.type}" on question "${id}"`);
        break;
    }
  }

  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > LIMITS.custom_answers_bytes) {
    return { ok: false, errors: { custom_answers: 'Your answers are too long. Please shorten them.' } };
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: clean };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * @param {object} payload  parsed request body
 * @param {object} job      row from public_jobs
 * @param {object} config   normalised config
 * @returns {{ok:true, clean} | {ok:false, errors}}
 */
function validateApplication(payload, job, config) {
  const errors = {};
  const clean = {};

  // Strict schema — unknown keys are a hard reject.
  //
  // The key is named in the response AND the log. It used to be anonymous,
  // which made a real incident undiagnosable: a browser holding a cached
  // older careers.js posted a field this build had renamed, and the only
  // clue anyone got was "Unexpected field in the form".
  //
  // Naming it leaks nothing — the allowlist is derivable from the page source.
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
      console.warn(`[validate] unexpected payload key "${key}" — client/server version skew?`);
      return {
        ok: false,
        errors: {
          _form: `This form is out of date (unexpected field "${key}"). ` +
                 'Please reload the page — Ctrl+Shift+R, or Cmd+Shift+R on a Mac — and submit again.',
        },
      };
    }
  }

  // ---- Name -------------------------------------------------------------
  const name = sanitizeText(payload.full_name);
  if (name.length < LIMITS.full_name.min || name.length > LIMITS.full_name.max) {
    errors.full_name = `Please enter your name (${LIMITS.full_name.min}-${LIMITS.full_name.max} characters).`;
  } else if (countLetters(name) < 2) {
    errors.full_name = 'Please enter your real name.';
  } else if (countLetters(name) / name.length < 0.6) {
    errors.full_name = 'Please enter your real name.';
  } else {
    clean.full_name = csvSafe(name);
  }

  // ---- Email ------------------------------------------------------------
  const email = validateEmail(payload.email, config);
  if (!email.ok) errors.email = email.message;
  else { clean.email = email.value; clean.email_normalized = email.normalized; }

  // ---- Phone ------------------------------------------------------------
  const phone = validatePhone(payload.phone);
  if (!phone.ok) errors.phone = phone.message;
  else clean.phone_e164 = phone.value;

  // ---- City -------------------------------------------------------------
  const city = sanitizeText(payload.location_city);
  if (city.length < LIMITS.location_city.min || city.length > LIMITS.location_city.max) {
    errors.location_city = 'Please enter your current city.';
  } else if (!/^[\p{L}\p{M}\s.,'()-]+$/u.test(city)) {
    errors.location_city = 'Please enter a valid city name.';
  } else {
    clean.location_city = csvSafe(city);
  }

  // ---- Enums (options come from config, so they are editable live) ------
  const opts = config.form_options || {};

  const exp = validateEnum(payload.experience_bucket, opts.experience_bucket, { label: 'experience level' });
  if (!exp.ok) errors.experience_bucket = exp.message; else clean.experience_bucket = exp.value;

  const notice = validateEnum(payload.notice_period, opts.notice_period, { label: 'notice period' });
  if (!notice.ok) errors.notice_period = notice.message; else clean.notice_period = notice.value;

  const ctc = validateEnum(payload.expected_ctc_band, opts.expected_ctc_band, { required: false, label: 'salary range' });
  if (!ctc.ok) errors.expected_ctc_band = ctc.message; else clean.expected_ctc_band = ctc.value;

  const src = validateEnum(payload.source, opts.source, { required: false, label: 'source' });
  if (!src.ok) errors.source = src.message; else clean.source = src.value;

  // ---- Links ------------------------------------------------------------
  // Optional, matching the Careers Revamp design. The required "show us
  // something you built" artefact is a per-job custom question instead, so
  // each role decides what proof it actually wants.
  const linkedin = validateUrl(payload.linkedin_url, { hostSuffix: 'linkedin.com', label: 'LinkedIn URL' });
  if (!linkedin.ok) errors.linkedin_url = linkedin.message; else clean.linkedin_url = linkedin.value;

  const portfolio = validateUrl(payload.portfolio_url, { label: 'portfolio URL' });
  if (!portfolio.ok) errors.portfolio_url = portfolio.message; else clean.portfolio_url = portfolio.value;

  const github = validateUrl(payload.github_url, { hostSuffix: ['github.com', 'gitlab.com', 'bitbucket.org'], label: 'GitHub URL' });
  if (!github.ok) errors.github_url = github.message; else clean.github_url = github.value;

  // ---- Why BoostOwl -----------------------------------------------------
  // The 50-character minimum is deliberate. It filters mass-appliers more
  // effectively than any other single field on this form.
  const why = sanitizeText(payload.why_boostowl);
  if (why.length < LIMITS.why_boostowl.min) {
    errors.why_boostowl = `Please write at least ${LIMITS.why_boostowl.min} characters - this is the answer we read most closely.`;
  } else if (why.length > LIMITS.why_boostowl.max) {
    errors.why_boostowl = `Please keep this under ${LIMITS.why_boostowl.max} characters.`;
  } else {
    clean.why_boostowl = csvSafe(why);
  }

  // ---- Per-job questions ------------------------------------------------
  const custom = validateCustomAnswers(payload.custom_answers, job.custom_questions);
  if (!custom.ok) Object.assign(errors, custom.errors);
  else clean.custom_answers = custom.value;

  // ---- Consent (DPDP) ---------------------------------------------------
  if (payload.consent !== true) {
    errors.consent = 'Please agree to how we handle your data.';
  } else {
    clean.consent_version = String(config.consent_version || 'unversioned').slice(0, 40);
  }

  // ---- Attribution ------------------------------------------------------
  const utm = sanitizeText(payload.utm_source);
  clean.utm_source = utm ? utm.slice(0, LIMITS.utm_source.max) : null;

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, clean };
}

module.exports = {
  LIMITS,
  ALLOWED_PAYLOAD_KEYS,
  sanitizeText,
  csvSafe,
  normalizeEmail,
  normalizePhone,
  validateEmail,
  validatePhone,
  validateUrl,
  validateEnum,
  validateCustomAnswers,
  validateApplication,
};
