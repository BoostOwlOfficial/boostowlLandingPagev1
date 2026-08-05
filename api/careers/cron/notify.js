// ============================================================================
// Notification retry worker.
//
//   GET /api/careers/cron/notify     (Authorization: Bearer $CRON_SECRET)
//
// apply.js sends the alert inline and marks notify_status. When Resend is
// down the application is still saved with notify_status='pending'; this
// picks those up. An unread application is a lost candidate, so this exists
// even though it is not on the critical path.
// ============================================================================

'use strict';

const { getConfig } = require('../_lib/config');
const { select, update } = require('../_lib/supabase');
const { isAuthorizedCron } = require('../_lib/security');
const { sendEmail, buildApplicationAlert } = require('../_lib/email');
const { handlePreflight, ok, fail } = require('../_lib/respond');

const MAX_ATTEMPTS = 5;
const BATCH = 25;

async function runNotify(config) {
  const result = { pending: 0, sent: 0, failed: 0 };

  if (config.notify_email_enabled !== true) { result.skipped = 'notifications off'; return result; }
  if (!process.env.RESEND_API_KEY)          { result.skipped = 'RESEND_API_KEY not set'; return result; }

  const rows = await select('applications', {
    select: 'id,reference,job_id,job_slug,full_name,email,phone_e164,location_city,' +
            'experience_bucket,notice_period,expected_ctc_band,source,linkedin_url,' +
            'portfolio_url,github_url,why_boostowl,custom_answers,resume_status,notify_attempts',
    filters: { notify_status: 'eq.pending' },
    order: 'created_at.asc',
    limit: BATCH,
  });

  result.pending = (rows || []).length;
  if (!result.pending) return result;

  for (const app of rows) {
    const attempts = (app.notify_attempts || 0) + 1;

    if (attempts > MAX_ATTEMPTS) {
      await update('applications', { id: `eq.${app.id}` }, { notify_status: 'failed' });
      result.failed++;
      continue;
    }

    let job = { title: app.job_slug, ai_enabled: false };
    try {
      const j = await select('jobs', { select: 'title,ai_enabled', filters: { id: `eq.${app.job_id}` }, limit: 1 });
      if (j[0]) job = j[0];
    } catch (err) {
      console.warn('[notify] job lookup failed:', err.message);
    }

    try {
      const mail = buildApplicationAlert(app, job, config);
      const sent = await sendEmail({
        to: config.notify_email_to,
        from: config.notify_email_from,
        replyTo: app.email,
        subject: mail.subject,
        html: mail.html,
      });

      await update('applications', { id: `eq.${app.id}` }, {
        notify_status: sent.ok ? 'sent' : (attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'),
        notify_attempts: attempts,
      });

      if (sent.ok) result.sent++;
      else { result.failed++; console.error('[notify] send failed:', app.reference, sent.reason); }
    } catch (err) {
      console.error('[notify] threw for', app.reference, err.message);
      await update('applications', { id: `eq.${app.id}` }, { notify_attempts: attempts }).catch(() => {});
      result.failed++;
    }
  }

  return result;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (!isAuthorizedCron(req)) return fail(req, res, 401, 'UNAUTHORIZED', 'Not authorised.');

  try {
    const config = await getConfig(true);
    const result = await runNotify(config);
    console.log('[notify]', JSON.stringify(result));
    return ok(req, res, result);
  } catch (err) {
    console.error('[notify] run failed:', err.message);
    return fail(req, res, 500, 'ERROR', err.message);
  }
};

module.exports.runNotify = runNotify;
