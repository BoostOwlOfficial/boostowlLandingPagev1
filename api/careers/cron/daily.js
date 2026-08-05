// ============================================================================
// The one scheduled job.
//
//   GET /api/careers/cron/daily      (Authorization: Bearer $CRON_SECRET)
//
// WHY ONE COMBINED JOB
// Vercel's Hobby plan caps cron frequency at ONCE PER DAY. A more frequent
// expression such as "*/5 * * * *" does not merely get throttled — it FAILS
// THE DEPLOYMENT. So rather than three schedules, vercel.json registers this
// single daily job and it runs the three workers in order.
//
// Order matters: maintenance first (the Supabase keepalive is the one thing
// that must run even if everything after it throws), then notification
// retries, then AI scoring, which is the most likely to be slow or capped.
//
// Each worker is also exposed at its own URL for manual runs:
//   /api/careers/cron/maintenance   /api/careers/cron/notify   /api/careers/cron/score
//
// On Vercel Pro, or with an external pinger, schedule those individually
// instead — see CAREERS-ADMIN.md.
// ============================================================================

'use strict';

const { getConfig } = require('../_lib/config');
const { isAuthorizedCron } = require('../_lib/security');
const { handlePreflight, ok, fail } = require('../_lib/respond');

const { runMaintenance } = require('./maintenance');
const { runNotify } = require('./notify');
const { runScoring } = require('./score');

// Vercel functions have a wall-clock limit; leave room to return a response.
const BUDGET_MS = 50000;

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (!isAuthorizedCron(req)) return fail(req, res, 401, 'UNAUTHORIZED', 'Not authorised.');

  const started = Date.now();
  const out = { maintenance: null, notify: null, score: null, errors: [] };

  let config;
  try {
    config = await getConfig(true);
  } catch (err) {
    console.error('[daily] config load failed:', err.message);
    return fail(req, res, 503, 'UNAVAILABLE', err.message);
  }

  // Each stage is independent: one throwing must not stop the others.
  try {
    out.maintenance = await runMaintenance(config);
  } catch (err) {
    console.error('[daily] maintenance:', err.message);
    out.errors.push('maintenance: ' + err.message);
  }

  try {
    out.notify = await runNotify(config);
  } catch (err) {
    console.error('[daily] notify:', err.message);
    out.errors.push('notify: ' + err.message);
  }

  // Scoring last, and only with time left. Any rows it does not reach stay
  // 'pending' and are picked up on the next run.
  if (Date.now() - started < BUDGET_MS) {
    try {
      out.score = await runScoring(config);
    } catch (err) {
      console.error('[daily] score:', err.message);
      out.errors.push('score: ' + err.message);
    }
  } else {
    out.score = { skipped: 'out of time budget' };
  }

  out.elapsedMs = Date.now() - started;
  console.log('[daily]', JSON.stringify(out));
  return ok(req, res, out);
};
