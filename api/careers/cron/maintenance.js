// ============================================================================
// Housekeeping.
//
//   GET /api/careers/cron/maintenance   (Authorization: Bearer $CRON_SECRET)
//
//   1. Supabase keepalive   <- WITHOUT THIS THE FREE-TIER PROJECT PAUSES
//                              after ~7 idle days and needs a MANUAL restore
//                              from the dashboard. Applications fail until
//                              someone notices. This is the single most
//                              important thing in this file.
//   2. DPDP retention purge (applications + their resume objects)
//   3. Expire a stale AI queue so it cannot grow unbounded while AI is off
//   4. Storage soft limit   -> auto-disables uploads, alerts you
//   5. Budget / cap alerts
// ============================================================================

'use strict';

const { getConfig } = require('../_lib/config');
const { rpc, select, update, deleteResume } = require('../_lib/supabase');
const { isAuthorizedCron } = require('../_lib/security');
const { sendEmail } = require('../_lib/email');
const { handlePreflight, ok, fail } = require('../_lib/respond');

async function alert(config, subject, lines) {
  if (!process.env.RESEND_API_KEY || !config.alert_email_to) return;
  try {
    await sendEmail({
      to: config.alert_email_to,
      from: config.notify_email_from,
      subject: `[BoostOwl careers] ${subject}`,
      html: `<div style="font-family:system-ui,sans-serif">
               <p>${lines.map((l) => String(l)).join('<br/>')}</p>
               <p style="color:#8FB3B0;font-size:12px">Automated message from the careers maintenance job.</p>
             </div>`,
    });
  } catch (err) {
    console.error('[maintenance] alert failed:', err.message);
  }
}

async function runMaintenance(config) {
  const result = { keepalive: false, purged: 0, resumesDeleted: 0, aiExpired: 0, storageBytes: 0, alerts: [] };

  // ---- 1. Keepalive ------------------------------------------------------
  try {
    await rpc('keepalive', {});
    result.keepalive = true;
  } catch (err) {
    console.error('[maintenance] KEEPALIVE FAILED:', err.message);
    result.alerts.push('keepalive failed: ' + err.message);
  }

  // ---- 2. Retention purge ------------------------------------------------
  try {
    const purged = await rpc('purge_expired_applications', { p_days: config.retention_days });
    result.purged = (purged || []).length;

    for (const row of purged || []) {
      if (!row.resume_path) continue;
      try {
        await deleteResume(row.resume_path);
        result.resumesDeleted++;
      } catch (err) {
        console.warn('[maintenance] could not delete', row.resume_path, err.message);
      }
    }
    if (result.purged) console.log(`[maintenance] purged ${result.purged} applications past ${config.retention_days} days`);
  } catch (err) {
    console.error('[maintenance] purge failed:', err.message);
    result.alerts.push('retention purge failed: ' + err.message);
  }

  // ---- 3. Stale AI queue -------------------------------------------------
  try {
    result.aiExpired = await rpc('expire_stale_ai_queue', { p_days: config.ai_queue_expiry_days });
  } catch (err) {
    console.error('[maintenance] ai queue expiry failed:', err.message);
  }

  // ---- 4. Storage soft limit --------------------------------------------
  try {
    result.storageBytes = Number(await rpc('storage_used_bytes', {})) || 0;
    const limit = config.storage_soft_limit_bytes;
    const pct = limit ? Math.round((result.storageBytes / limit) * 100) : 0;
    result.storagePct = pct;

    if (result.storageBytes >= limit && config.resume_upload_enabled === true) {
      // Applications keep flowing; only the upload field goes away.
      await update('config', { key: 'eq.resume_upload_enabled' }, { value: false });
      result.alerts.push(`storage soft limit reached (${pct}%) — resume uploads auto-disabled`);
      await alert(config, 'Resume uploads auto-disabled', [
        `Storage is at ${(result.storageBytes / 1e6).toFixed(0)} MB of a ${(limit / 1e6).toFixed(0)} MB soft limit.`,
        'Uploads are now off; applications are still being accepted with links only.',
        'Purge old resumes or lower retention_days, then set resume_upload_enabled back to true.',
      ]);
    } else if (pct >= 80) {
      result.alerts.push(`storage at ${pct}%`);
    }
  } catch (err) {
    console.error('[maintenance] storage check failed:', err.message);
  }

  // ---- 5. AI budget ------------------------------------------------------
  try {
    const month = new Date();
    const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const rows = await select('counters', {
      select: 'count',
      filters: { key: 'eq.ai:spend_usd:month', window_start: `eq.${start.toISOString()}` },
    });
    const spent = Number((rows[0] || {}).count || 0);
    result.aiSpendUsd = Number(spent.toFixed(4));

    if (config.ai_scoring_enabled === true && spent >= config.ai_monthly_budget_usd) {
      result.alerts.push(`AI monthly budget exhausted ($${spent.toFixed(2)})`);
      await alert(config, 'AI scoring budget exhausted', [
        `Spent $${spent.toFixed(2)} of a $${config.ai_monthly_budget_usd} monthly budget.`,
        'Scoring is paused until the budget resets or you raise ai_monthly_budget_usd.',
        'Applications are completely unaffected.',
      ]);
    }
  } catch (err) {
    console.error('[maintenance] budget check failed:', err.message);
  }

  return result;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (!isAuthorizedCron(req)) return fail(req, res, 401, 'UNAUTHORIZED', 'Not authorised.');

  try {
    const config = await getConfig(true);
    const result = await runMaintenance(config);
    console.log('[maintenance]', JSON.stringify(result));
    return ok(req, res, result);
  } catch (err) {
    console.error('[maintenance] run failed:', err.message);
    return fail(req, res, 500, 'ERROR', err.message);
  }
};

module.exports.runMaintenance = runMaintenance;
