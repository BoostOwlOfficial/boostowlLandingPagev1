// ============================================================================
// Resend over plain HTTP.
//
// Notification failures NEVER fail an application. Every caller wraps these in
// try/catch and records notify_status so the cron can retry.
// ============================================================================

'use strict';

const RESEND_URL = 'https://api.resend.com/emails';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail({ to, from, subject, html, replyTo }, timeoutMs = 8000) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'NOT_CONFIGURED' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
    if (replyTo) body.reply_to = replyTo;

    const resp = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, reason: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'TIMEOUT' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** New-application alert to the hiring inbox. */
function buildApplicationAlert(app, job, config) {
  const row = (label, value) =>
    value ? `<tr><td style="padding:4px 12px 4px 0;color:#557876;white-space:nowrap">${escapeHtml(label)}</td>
             <td style="padding:4px 0"><strong>${escapeHtml(value)}</strong></td></tr>` : '';

  const answers = Object.entries(app.custom_answers || {})
    .map(([k, v]) => `<p style="margin:12px 0 4px;color:#557876;font-size:13px">${escapeHtml(k)}</p>
                      <p style="margin:0;white-space:pre-wrap">${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}</p>`)
    .join('');

  return {
    subject: `New application: ${job.title} — ${app.full_name}`,
    html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:620px;color:#042925">
      <h2 style="margin:0 0 4px">${escapeHtml(job.title)}</h2>
      <p style="margin:0 0 20px;color:#557876">Reference ${escapeHtml(app.reference)}</p>
      <table style="border-collapse:collapse;font-size:14px">
        ${row('Name', app.full_name)}
        ${row('Email', app.email)}
        ${row('Phone', app.phone_e164)}
        ${row('City', app.location_city)}
        ${row('Experience', app.experience_bucket)}
        ${row('Notice', app.notice_period)}
        ${row('Expected', app.expected_ctc_band)}
        ${row('LinkedIn', app.linkedin_url)}
        ${row('Portfolio', app.portfolio_url)}
        ${row('GitHub', app.github_url)}
        ${row('Source', app.source)}
        ${row('Resume', app.resume_status === 'ok' ? 'Attached in Supabase Storage' : 'Not uploaded')}
      </table>
      <h3 style="margin:24px 0 4px;font-size:14px">Why BoostOwl</h3>
      <p style="margin:0;white-space:pre-wrap">${escapeHtml(app.why_boostowl)}</p>
      ${answers}
      <p style="margin:28px 0 0;color:#8FB3B0;font-size:12px">
        Review in the Supabase dashboard. ${escapeHtml(config.ai_scoring_enabled && job.ai_enabled ? 'AI scoring is queued for this role.' : '')}
      </p>
    </div>`,
  };
}

/** Optional acknowledgement to the candidate. */
function buildCandidateAck(app, job, config) {
  const steps = Array.isArray(config.hiring_process) ? config.hiring_process : [];
  const next = steps.find((s) => s && s.step === 2);

  return {
    subject: `We received your application — ${job.title} at BoostOwl`,
    html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#042925">
      <p>Hi ${escapeHtml(String(app.full_name).split(' ')[0])},</p>
      <p>Thanks for applying for <strong>${escapeHtml(job.title)}</strong>. Your application is in,
         and a human will read it — we do not auto-reject.</p>
      <p style="background:#DEF2E9;padding:12px 16px;border-radius:8px;margin:20px 0">
        Your reference is <strong>${escapeHtml(app.reference)}</strong>. Quote it if you need to reach us.
      </p>
      ${next ? `<p><strong>What happens next:</strong> ${escapeHtml(next.detail)} ${escapeHtml(next.timing ? `(${next.timing})` : '')}</p>` : ''}
      <p>If you need your data removed at any point, reply to this email and we will delete it.</p>
      <p style="margin-top:28px">— The BoostOwl team</p>
      <p style="color:#8FB3B0;font-size:12px;margin-top:24px">
        BoostOwl Pvt. Ltd. · Hapur, Uttar Pradesh, India<br/>
        You are receiving this because you applied at boostowl.io/careers
      </p>
    </div>`,
  };
}

module.exports = { sendEmail, buildApplicationAlert, buildCandidateAck, escapeHtml };
