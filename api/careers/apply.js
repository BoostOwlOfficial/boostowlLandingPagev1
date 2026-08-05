// ============================================================================
// POST /api/careers/apply
//
// Checks run cheapest-first, so an attacker burns almost nothing before being
// turned away:
//
//    1  method / content-type / origin / content-length
//    2  config + global kill switch
//    3  strict JSON schema (unknown keys rejected)
//    4  honeypot            -> silent 200
//    5  form token verify   -> HMAC signature + dwell time (NOT burned yet)
//    6  Turnstile           -> incl. hostname check
//    7  job lookup          -> exists, live, accepting
//    8  field validation
//    9  resume validation   -> magic bytes, size, encryption
//   10  rate limits         -> Redis, Postgres fallback
//   11  burn form token     -> one-time nonce, spent only once we commit
//   12  global cap reserve  -> atomic
//   13  apply_to_job()      -> atomic cap + dedupe + insert
//   14  resume upload       -> failure never loses the application
//   15  notify              -> failure never fails the request
//
// Full rationale: CAREERS-ADMIN.md
// ============================================================================

'use strict';

const { getConfig, FORM_TOKEN_MAX_AGE_SECONDS } = require('./_lib/config');
const { rpc, select, uploadResume, update } = require('./_lib/supabase');
const { getClientIp, hashIp, sha256hex, verifyFormToken, verifyTurnstile } = require('./_lib/security');
const { burnNonce, checkRateLimits, reserveGlobalSlot } = require('./_lib/limits');
const { validateApplication } = require('./_lib/validate');
const { validateResume } = require('./_lib/resume');
const { sendEmail, buildApplicationAlert, buildCandidateAck } = require('./_lib/email');
const { handlePreflight, ok, fail, checkOrigin } = require('./_lib/respond');

const TURNSTILE_HOSTNAMES = ['boostowl.io', 'localhost', 'vercel.app'];

// Absolute request ceiling, independent of config. Vercel rejects >4.5 MB
// before we run; this is the second layer.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Vercel parses JSON bodies for us, but be defensive about the shape. */
function readBody(req) {
  const raw = req.body;
  if (raw == null) return null;
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  // ---- 1. Transport ------------------------------------------------------
  if (req.method !== 'POST') {
    return fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Use POST.');
  }

  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    return fail(req, res, 415, 'BAD_CONTENT_TYPE', 'Send application/json.');
  }

  // Filters lazy cross-site scripts for free. Turnstile and the form token are
  // the controls that actually matter.
  if (!checkOrigin(req)) {
    return fail(req, res, 403, 'BAD_ORIGIN', 'Request rejected.');
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return fail(req, res, 413, 'TOO_LARGE', 'That request is too large. Please upload a smaller PDF.');
  }

  // ---- 2. Config + kill switch ------------------------------------------
  let config;
  try {
    config = await getConfig();
  } catch (err) {
    console.error('[apply] config load failed:', err.message);
    return fail(req, res, 503, 'UNAVAILABLE', 'We could not accept your application right now. Please try again shortly.');
  }

  if (config.applications_open !== true) {
    return fail(req, res, 503, 'CLOSED', config.maintenance_message);
  }

  // ---- 3. Body -----------------------------------------------------------
  const payload = readBody(req);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(req, res, 400, 'BAD_JSON', 'We could not read that submission. Please reload and try again.');
  }

  // ---- 4. Honeypot -------------------------------------------------------
  // A bot that fills the hidden field gets a clean 200 and learns nothing.
  if (typeof payload.hp_company === 'string' && payload.hp_company.trim() !== '') {
    console.warn('[apply] honeypot triggered');
    return ok(req, res, { reference: 'BO-000000', message: 'Application received.' });
  }

  // ---- 5. Form token -----------------------------------------------------
  const token = verifyFormToken(
    payload.form_token,
    config.min_form_dwell_seconds,
    FORM_TOKEN_MAX_AGE_SECONDS
  );
  if (!token.ok) {
    if (token.reason === 'TOO_FAST') {
      return fail(req, res, 400, 'TOO_FAST', 'That was submitted a little too quickly. Please take a moment and try again.');
    }
    if (token.reason === 'EXPIRED') {
      return fail(req, res, 400, 'EXPIRED', 'This form expired. Please reload the page and re-submit.');
    }
    return fail(req, res, 400, 'BAD_TOKEN', 'Please reload the page and try again.');
  }

  // NOTE: the nonce is deliberately NOT burned here. It is burned at step 11,
  // immediately before the write. Burning it now would mean a simple typo in
  // the email field spends the token, and the corrected re-submit would come
  // back as ALREADY_SUBMITTED — a dead end on the most common error path.

  // ---- 6. Turnstile ------------------------------------------------------
  const clientIp = getClientIp(req);
  let ipHash;
  try {
    ipHash = hashIp(clientIp);
  } catch (err) {
    console.error('[apply] IP_HASH_SALT missing:', err.message);
    return fail(req, res, 503, 'UNAVAILABLE', 'We could not accept your application right now.');
  }

  if (config.turnstile_enabled === true) {
    const captcha = await verifyTurnstile(payload.turnstile_token, clientIp, TURNSTILE_HOSTNAMES);
    if (!captcha.ok) {
      // Fail CLOSED by default. turnstile_fail_open is the manual override for
      // a Cloudflare outage and should be switched back immediately after.
      if (captcha.unreachable && config.turnstile_fail_open === true) {
        console.warn('[apply] Turnstile unreachable; failing OPEN per config');
      } else {
        console.warn('[apply] Turnstile rejected:', captcha.reason);
        return fail(req, res, 403, 'CAPTCHA_FAILED', 'We could not verify that you are human. Please reload and try again.');
      }
    }
  }

  // ---- 7. Job ------------------------------------------------------------
  const jobSlug = typeof payload.job_slug === 'string' ? payload.job_slug.slice(0, 100) : '';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(jobSlug)) {
    return fail(req, res, 400, 'BAD_SLUG', 'Please choose a role to apply for.');
  }

  let job;
  try {
    const rows = await select('public_jobs', {
      select: 'id,slug,title,custom_questions,resume_mode,is_accepting,is_full,is_live',
      filters: { slug: `eq.${jobSlug}` },
      limit: 1,
    });
    job = rows && rows[0];
  } catch (err) {
    console.error('[apply] job lookup failed:', err.message);
    return fail(req, res, 503, 'UNAVAILABLE', 'We could not accept your application right now. Please try again shortly.');
  }

  if (!job) return fail(req, res, 404, 'JOB_NOT_FOUND', 'That role is no longer listed.');
  if (job.is_full === true) {
    return fail(req, res, 409, 'JOB_FULL', 'This role has reached its application limit and is no longer accepting applications.');
  }
  if (job.is_accepting !== true) {
    return fail(req, res, 409, 'JOB_CLOSED', 'This role is no longer accepting applications.');
  }

  // ---- 8. Fields ---------------------------------------------------------
  const validated = validateApplication(payload, job, config);
  if (!validated.ok) {
    return fail(req, res, 400, 'VALIDATION_FAILED', 'Please check the highlighted fields.', {
      errors: validated.errors,
    });
  }
  const clean = validated.clean;

  // ---- 9. Resume ---------------------------------------------------------
  const uploadsOn = config.resume_upload_enabled === true && job.resume_mode !== 'disabled';
  const resumeRequired = uploadsOn && job.resume_mode === 'required';

  let resume = null;
  if (payload.resume && uploadsOn) {
    const r = validateResume(payload.resume, config.resume_max_bytes);
    if (!r.ok) {
      return fail(req, res, 400, r.code, 'Please check the highlighted fields.', {
        errors: { resume: r.message },
      });
    }
    resume = r;
  } else if (payload.resume && !uploadsOn) {
    // Uploads were switched off (or storage filled) between page load and
    // submit. Accept the application, drop the file.
    console.warn('[apply] resume ignored: uploads disabled');
  }

  if (resumeRequired && !resume) {
    return fail(req, res, 400, 'VALIDATION_FAILED', 'Please check the highlighted fields.', {
      errors: { resume: 'A PDF resume is required for this role.' },
    });
  }

  // ---- 10. Rate limits ---------------------------------------------------
  const limits = await checkRateLimits(
    { ipHash, emailNormalized: clean.email_normalized, phoneE164: clean.phone_e164 },
    config
  );
  if (!limits.ok) {
    if (limits.reason === 'LIMITER_UNAVAILABLE') {
      return fail(req, res, 503, 'UNAVAILABLE', 'We could not accept your application right now. Please try again shortly.');
    }
    const perIdentity = limits.reason === 'EMAIL_30D' || limits.reason === 'PHONE_30D';
    return fail(
      req, res, 429, 'RATE_LIMITED',
      perIdentity
        ? 'You have applied to several roles recently. Please wait before applying again.'
        : 'Too many applications from this connection. Please try again later.',
      {},
    );
  }

  // ---- 11. Burn the form token ------------------------------------------
  // Everything above has passed, so this submission is going to be attempted.
  // Burning here (rather than at step 5) means a validation error leaves the
  // token usable and the applicant can simply fix the field and re-submit.
  //
  // Replay is still covered: Turnstile rejects a reused captcha token, the
  // rate limiter caps attempts, and the unique indexes in apply_to_job() are
  // the final authority on duplicates. Two simultaneous double-clicks race
  // here and exactly one wins, which is the behaviour we want.
  if (!(await burnNonce(token.nonce, FORM_TOKEN_MAX_AGE_SECONDS))) {
    return fail(req, res, 409, 'ALREADY_SUBMITTED', 'This form was already submitted. Please reload the page to apply again.');
  }

  // ---- 12. Global circuit breaker ---------------------------------------
  const slot = await reserveGlobalSlot(config);
  if (!slot.ok) {
    console.warn('[apply] global cap hit:', slot.reason, slot.count);
    return fail(req, res, 503, 'BUSY', 'We are receiving a very high volume of applications right now. Please try again in a little while.');
  }

  // ---- 13. Atomic insert -------------------------------------------------
  // apply_to_job() takes a row lock on the job, so the cap is exact and the
  // unique indexes decide duplicates in the same transaction.
  let result;
  try {
    result = await rpc('apply_to_job', {
      p_job_slug: jobSlug,
      p_data: {
        full_name: clean.full_name,
        email: clean.email,
        email_normalized: clean.email_normalized,
        phone_e164: clean.phone_e164,
        location_city: clean.location_city,
        experience_bucket: clean.experience_bucket,
        notice_period: clean.notice_period,
        expected_ctc_band: clean.expected_ctc_band,
        source: clean.source,
        linkedin_url: clean.linkedin_url,
        portfolio_url: clean.portfolio_url,
        github_url: clean.github_url,
        why_boostowl: clean.why_boostowl,
        custom_answers: clean.custom_answers || {},
        consent_version: clean.consent_version,
        ai_master: config.ai_scoring_enabled === true,
        ip_hash: ipHash,
        ua_hash: sha256hex(String(req.headers['user-agent'] || '')).slice(0, 32),
        utm_source: clean.utm_source,
      },
    });
  } catch (err) {
    console.error('[apply] apply_to_job failed:', err.message);
    return fail(req, res, 503, 'UNAVAILABLE', 'We could not save your application. Please try again shortly.');
  }

  if (!result || result.ok !== true) {
    const code = (result && result.error) || 'UNKNOWN';

    if (code === 'DUPLICATE') {
      const field = result.field === 'phone' ? 'phone number' : 'email address';
      return fail(
        req, res, 409, 'DUPLICATE',
        `You have already applied for this role with this ${field}. We only accept one application per person per role.`,
        { field: result.field }
      );
    }
    if (code === 'JOB_FULL') {
      return fail(req, res, 409, 'JOB_FULL', 'This role just reached its application limit.');
    }
    if (code === 'JOB_CLOSED' || code === 'JOB_NOT_FOUND') {
      return fail(req, res, 409, 'JOB_CLOSED', 'This role is no longer accepting applications.');
    }
    console.error('[apply] apply_to_job returned:', code);
    return fail(req, res, 503, 'UNAVAILABLE', 'We could not save your application. Please try again shortly.');
  }

  const applicationId = result.id;
  const reference = result.reference;

  // ---- 14. Resume upload -------------------------------------------------
  // The row already exists. If storage fails we keep the application and the
  // candidate's links; we never lose someone to a storage blip.
  let resumeStatus = 'none';
  if (resume) {
    const path = `${jobSlug}/${applicationId}.pdf`;   // never the user's filename
    try {
      await uploadResume(path, resume.buffer);
      await rpc('attach_resume', {
        p_id: applicationId,
        p_path: path,
        p_filename: resume.filename,
        p_bytes: resume.bytes,
        p_sha256: resume.sha256,
        p_flags: resume.flags,
      });
      resumeStatus = 'ok';
    } catch (err) {
      console.error('[apply] resume upload failed for', reference, err.message);
      try {
        await update('applications', { id: `eq.${applicationId}` }, { resume_status: 'failed' });
      } catch (e2) {
        console.error('[apply] could not mark resume failed:', e2.message);
      }
      resumeStatus = 'failed';
    }
  }

  // ---- 15. Notify --------------------------------------------------------
  // Never fails the request. notify_status drives the retry cron.
  if (config.notify_email_enabled === true) {
    const appForEmail = Object.assign({}, clean, { reference, resume_status: resumeStatus });
    try {
      const mail = buildApplicationAlert(appForEmail, job, config);
      const sent = await sendEmail({
        to: config.notify_email_to,
        from: config.notify_email_from,
        replyTo: clean.email,
        subject: mail.subject,
        html: mail.html,
      });
      await update(
        'applications',
        { id: `eq.${applicationId}` },
        { notify_status: sent.ok ? 'sent' : 'failed' }
      ).catch(() => {});
      if (!sent.ok) console.error('[apply] alert email failed:', sent.reason);
    } catch (err) {
      console.error('[apply] notify threw:', err.message);
    }

    if (config.notify_ack_candidate === true) {
      try {
        const ack = buildCandidateAck(appForEmail, job, config);
        await sendEmail({
          to: clean.email,
          from: config.notify_email_from,
          subject: ack.subject,
          html: ack.html,
        });
      } catch (err) {
        console.error('[apply] candidate ack failed:', err.message);
      }
    }
  }

  // ---- 16. Done ----------------------------------------------------------
  return ok(req, res, {
    reference,
    resume_status: resumeStatus,
    message:
      resumeStatus === 'failed'
        ? 'Application received, but we could not save your resume. We have your links and will be in touch.'
        : 'Application received. A human will read it and you will hear back either way.',
  });
};
