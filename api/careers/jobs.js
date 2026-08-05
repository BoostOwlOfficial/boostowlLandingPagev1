// ============================================================================
// GET /api/careers/jobs
//
// Serves everything the careers page needs in one request: open roles, page
// copy, form dropdown options, and a signed single-use form token.
//
//   /api/careers/jobs            all roles + page content
//   /api/careers/jobs?slug=x     one role (for a per-role page)
//
// Never cached: each response carries a fresh form token.
// ============================================================================

'use strict';

const { getConfig } = require('./_lib/config');
const { select } = require('./_lib/supabase');
const { issueFormToken } = require('./_lib/security');
const { handlePreflight, ok, fail } = require('./_lib/respond');

// public_jobs deliberately excludes scoring_rubric and ai_enabled. Listing the
// columns explicitly means a future column is opt-in rather than leaked by
// default.
const PUBLIC_COLUMNS = [
  'id', 'slug', 'title', 'department', 'location', 'work_mode', 'employment_type',
  'experience_level', 'salary_band', 'summary', 'description_md', 'requirements_md',
  'nice_to_have_md', 'skills', 'custom_questions', 'resume_mode', 'sort_order',
  'max_applications', 'application_count', 'closes_at',
  'is_live', 'is_full', 'is_accepting',
].join(',');

/** Strip anything a browser has no business seeing, and normalise shape. */
function shapeJob(row) {
  return {
    slug: row.slug,
    title: row.title,
    department: row.department,
    location: row.location,
    work_mode: row.work_mode,
    employment_type: row.employment_type,
    experience_level: row.experience_level,
    salary_band: row.salary_band,
    summary: row.summary,
    description_md: row.description_md,
    requirements_md: row.requirements_md,
    nice_to_have_md: row.nice_to_have_md,
    skills: Array.isArray(row.skills) ? row.skills : [],
    custom_questions: Array.isArray(row.custom_questions) ? row.custom_questions : [],
    resume_mode: row.resume_mode,
    closes_at: row.closes_at,

    is_accepting: row.is_accepting === true,
    is_full: row.is_full === true,

    // Progress is shown only when a cap exists and the role is genuinely
    // filling up. Publishing an exact count on a quiet role reads badly.
    spots_left:
      row.max_applications && row.is_accepting
        ? Math.max(0, row.max_applications - row.application_count)
        : null,
  };
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;

  if (req.method !== 'GET') {
    return fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Use GET.');
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  let config;
  try {
    config = await getConfig();
  } catch (err) {
    console.error('[jobs] config load failed:', err.message);
    return fail(req, res, 503, 'UNAVAILABLE', 'Careers are temporarily unavailable. Please try again shortly.');
  }

  // Global kill switch — still return page content so the page can render a
  // message rather than an error.
  if (config.applications_open !== true) {
    return ok(req, res, {
      applications_open: false,
      maintenance_message: config.maintenance_message,
      jobs: [],
      page: config.careers_page || {},
      hiring_process: config.hiring_process || [],
      faq: config.careers_faq || [],
      departments: config.departments || [],
    });
  }

  const slugParam = typeof req.query?.slug === 'string' ? req.query.slug.slice(0, 100) : null;

  let rows;
  try {
    const filters = { is_live: 'eq.true' };
    if (slugParam) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugParam)) {
        return fail(req, res, 400, 'BAD_SLUG', 'Unknown role.');
      }
      filters.slug = `eq.${slugParam}`;
      delete filters.is_live; // a direct link should still resolve a closed role
    }

    rows = await select('public_jobs', {
      select: PUBLIC_COLUMNS,
      filters,
      order: 'sort_order.asc',
      limit: 100,
    });
  } catch (err) {
    console.error('[jobs] query failed:', err.message);
    return fail(req, res, 503, 'UNAVAILABLE', 'Careers are temporarily unavailable. Please try again shortly.');
  }

  const jobs = (rows || []).map(shapeJob);

  if (slugParam && jobs.length === 0) {
    return fail(req, res, 404, 'NOT_FOUND', 'That role no longer exists.');
  }

  let formToken = null;
  try {
    formToken = issueFormToken();
  } catch (err) {
    // Missing FORM_TOKEN_SECRET is a deployment error, not a user error.
    console.error('[jobs] token issue failed:', err.message);
  }

  return ok(req, res, {
    applications_open: true,
    jobs,

    // Page content — all editable from the config table, no deploy needed.
    page: config.careers_page || {},
    hero_stats: config.hero_stats || [],
    hiring_process: config.hiring_process || [],
    faq: config.careers_faq || [],
    departments: config.departments || [],
    form_options: config.form_options || {},

    // Form wiring
    form_token: formToken,
    turnstile_site_key: config.turnstile_enabled ? (process.env.TURNSTILE_SITE_KEY || null) : null,
    min_dwell_seconds: config.min_form_dwell_seconds,
    resume_upload_enabled: config.resume_upload_enabled,
    resume_max_bytes: config.resume_max_bytes,
    consent_text: config.consent_text,
  });
};
