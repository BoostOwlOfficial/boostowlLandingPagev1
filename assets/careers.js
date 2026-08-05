/* =====================================================================
   BoostOwl — Careers page engine

   Talks to /api/careers/jobs (GET) and /api/careers/apply (POST).
   No build step, no dependencies. Markdown comes from careers-md.js.

   §1  Constants        §6  Validation (mirrors the server)
   §2  State            §7  Resume
   §3  Utilities        §8  Turnstile
   §4  API              §9  Submit
   §5  Render           §10 Token lifecycle & boot

   THE ONE THING TO KNOW: the server burns the form-token nonce at the
   moment of the write, so a validation error leaves the token usable and
   the applicant can just fix the field and re-submit. Any error that DOES
   spend the token triggers a silent refreshToken() before Submit is
   re-enabled. See the table in §9.
   ===================================================================== */
(function () {
  'use strict';

  /* =====================================================================
     §1  CONSTANTS
     ===================================================================== */
  const API_JOBS  = '/api/careers/jobs';
  const API_APPLY = '/api/careers/apply';

  const TOKEN_REFRESH_MS  = 45 * 60 * 1000;   // server expiry is 2h; stay well inside
  const TOKEN_HIDDEN_MS   = 30 * 60 * 1000;   // refresh on return if hidden this long
  const TS_TOKEN_STALE_MS = 4 * 60 * 1000;    // Turnstile tokens live ~300s
  const TS_LOAD_TIMEOUT   = 8000;
  const SUBMIT_TIMEOUT_MS = 60000;

  // Client cap. config.resume_max_bytes has a 2.5 MB server ceiling; this is
  // the belt-and-braces upper bound so base64 can never exceed the body limit.
  const B64_SAFE_MAX_BYTES = 2600000;

  // Only show "N spots left" when it is genuinely scarce. "147 spots left"
  // reads worse than saying nothing.
  const SPOTS_URGENCY_MAX = 10;

  const STANDARD_KEYS = [
    'full_name', 'email', 'phone', 'location_city', 'experience_bucket',
    'notice_period', 'expected_ctc_band', 'source', 'linkedin_url',
    'portfolio_url', 'github_url', 'why_boostowl', 'consent', 'resume',
  ];

  const WHY_MIN = 50;
  const WHY_MAX = 600;

  /* =====================================================================
     §2  STATE
     ===================================================================== */
  const state = {
    data: null,
    jobs: [],
    jobBySlug: new Map(),
    filter: null,
    view: 'list',
    step: 1,
    selected: null,
    form: {},          // standard fields — PERSIST across role switches
    answers: {},       // custom answers — CLEARED on role switch
    resume: null,      // {file,name,size,b64,status,error}
    errors: {},
    dirty: new Set(),
    tokenIssuedAt: 0,
    tokenRefreshing: false,
    lastRefreshAt: 0,
    turnstile: { widgetId: null, token: null, tokenAt: 0, status: 'off' },
    submitting: false,
    autoRetried: false,
    submitted: null,
    lastFocused: null,
    hpTouched: false,  // did a human ever focus the honeypot? see buildPayload()
  };

  /* =====================================================================
     §3  UTILITIES
     ===================================================================== */
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const MD = window.BoostOwlMD || { render: (s) => escapeHtml(String(s || '')) };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /**
   * MIRROR of api/careers/_lib/validate.js sanitizeText().
   * Must match exactly: the server measures why_boostowl length AFTER
   * sanitising, so a naive value.length counter would show 51 while the
   * server sees 48 and rejects.
   */
  function sanitizeText(value) {
    if (typeof value !== 'string') return '';
    return value
      .normalize('NFC')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function bytesLabel(n) {
    if (!n) return '0 KB';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function titleCase(v) {
    return String(v || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const qDomId = (id) => 'q_' + String(id).replace(/[^a-z0-9_]/gi, '');

  function icon(name, size) {
    const s = size || 16;
    return `<svg width="${s}" height="${s}" aria-hidden="true"><use href="#${name}"/></svg>`;
  }

  function announce(msg, el) {
    const node = el || $('#submit-status');
    if (node) node.textContent = msg || '';
  }

  function optionLabel(list, value) {
    const hit = (list || []).find((o) => (typeof o === 'string' ? o : o && o.value) === value);
    if (!hit) return value;
    return typeof hit === 'string' ? hit : (hit.label || hit.value);
  }

  /* =====================================================================
     §4  API
     ===================================================================== */
  async function fetchCareers() {
    const res = await fetch(API_JOBS, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (!body || body.ok !== true) throw new Error((body && body.message) || 'Bad response');
    return body;
  }

  /**
   * Re-issue a form token. GET /api/careers/jobs is the only issuer.
   * Updates the token and availability flags ONLY — it must never touch
   * #fields-mount or the user loses what they have typed.
   */
  async function refreshToken() {
    if (state.tokenRefreshing) return false;
    state.tokenRefreshing = true;
    try {
      const body = await fetchCareers();
      state.data.form_token = body.form_token;
      state.data.resume_upload_enabled = body.resume_upload_enabled;
      state.data.resume_max_bytes = body.resume_max_bytes;
      state.data.min_dwell_seconds = body.min_dwell_seconds;
      state.tokenIssuedAt = Date.now();
      state.lastRefreshAt = Date.now();

      // Free freshness check: did the open role fill up while the form sat open?
      if (state.selected) {
        const fresh = (body.jobs || []).find((j) => j.slug === state.selected.slug);
        if (fresh) {
          state.selected.is_accepting = fresh.is_accepting;
          state.selected.is_full = fresh.is_full;
          state.selected.spots_left = fresh.spots_left;
          if (!fresh.is_accepting) {
            showFormNotice('warn', fresh.is_full
              ? 'This role reached its application limit while you were filling this in.'
              : 'This role stopped accepting applications while you were filling this in.');
            setSubmitEnabled(false);
          }
        }
        state.jobs = body.jobs || state.jobs;
        state.jobBySlug = new Map(state.jobs.map((j) => [j.slug, j]));
      }
      return true;
    } catch (err) {
      console.error('[careers] token refresh failed:', err.message);
      return false;
    } finally {
      state.tokenRefreshing = false;
    }
  }

  async function postApplication(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const res = await fetch(API_APPLY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },  // 415 without this
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /* =====================================================================
     §5  RENDER  (list -> detail -> 3-step wizard, per the Careers Revamp design)
     ===================================================================== */

  // Which standard fields live on which wizard step. Custom questions are
  // appended to step 2 — "The role" — which is exactly what they are.
  const STEP_FIELDS = {
    1: ['full_name', 'email', 'phone', 'location_city'],
    2: ['experience_bucket', 'notice_period', 'why_boostowl'],
    3: ['linkedin_url', 'portfolio_url', 'source', 'consent', 'resume'],
  };

  const STEPS = [
    { n: 1, label: 'About you',    meta: '4 fields', title: 'About you',
      hint: 'Takes under a minute.', next: 'Continue' },
    { n: 2, label: 'The role',     meta: '4 fields', title: 'Why this role',
      hint: 'This is the part we actually read.', next: 'Continue' },
    { n: 3, label: 'CV & consent', meta: '',         title: 'CV and consent',
      hint: 'One PDF, one checkbox, and you are done.', next: 'Submit application' },
  ];

  function setView(view) {
    state.view = view;
    $('#roles-section').hidden  = view !== 'list';
    $('#detail-section').hidden = view !== 'detail';
    $('#apply-section').hidden  = view !== 'apply';
  }

  function renderAll() {
    const d = state.data;

    if (d.applications_open === false) {
      renderClosed(d.maintenance_message);
      renderPage(d);
      return;
    }

    renderPage(d);
    renderHeroStats();
    renderDeptFilters();
    renderJobList();

    if (d.page && d.page.open_application_note) {
      const note = $('#open-note');
      note.innerHTML = escapeHtml(d.page.open_application_note) +
        ' <a href="mailto:careers@boostowl.io">careers@boostowl.io</a>';
      note.hidden = false;
    }
  }

  function renderPage(d) {
    const page = d.page || {};
    let anyClosing = false;

    if (page.hero_title) {
      $('#hero-mount').innerHTML = `
        <span class="eyebrow">${escapeHtml(page.hero_eyebrow || 'Careers at BoostOwl')}</span>
        <h1>${escapeHtml(page.hero_title)}</h1>
        ${page.hero_subtitle ? `<p>${escapeHtml(page.hero_subtitle)}</p>` : ''}`;
    }

    // Value cards — the four-across row above the closing columns.
    const cards = Array.isArray(page.why_cards) ? page.why_cards : [];
    if (cards.length) {
      $('#why-mount').innerHTML = cards.map((c) => `
        <div class="value-card">
          <h3>${escapeHtml(c.title)}</h3>
          <p>${escapeHtml(c.body)}</p>
        </div>`).join('');
      anyClosing = true;
    }

    // "How we hire". The design gives the second-to-last stage a mint
    // highlight (it is the one that varies) and the last a dark finish.
    const steps = Array.isArray(d.hiring_process)
      ? d.hiring_process.slice().sort((a, b) => (a.step || 0) - (b.step || 0)) : [];
    if (steps.length) {
      const last = steps.length - 1;
      $('#process-mount').innerHTML = steps.map((st, i) => {
        const cls = i === last ? ' is-final' : (i === last - 1 ? ' is-highlight' : '');
        return `
        <div class="process-row${cls}">
          <span class="num">${escapeHtml(String(st.step || i + 1))}</span>
          <span class="title">${escapeHtml(st.title)}</span>
          <span class="detail">${escapeHtml(st.detail)}</span>
          ${st.timing ? `<span class="timing">${escapeHtml(st.timing)}</span>` : ''}
        </div>`;
      }).join('');
      anyClosing = true;
    }

    const principles = Array.isArray(page.principles) ? page.principles : [];
    $('#principles-mount').innerHTML = principles.map((x) => `
      <li>${icon('i-check', 14)}<span>${escapeHtml(x)}</span></li>`).join('');
    if (principles.length) anyClosing = true;

    const faq = Array.isArray(d.faq) ? d.faq : [];
    if (faq.length) {
      $('#faq-mount').innerHTML = faq.map((f, i) => `
        <details class="faq-item"${i === 0 ? ' open' : ''}>
          <summary>${escapeHtml(f.q)}${icon('i-chevron', 16)}</summary>
          <div class="faq-answer">${escapeHtml(f.a)}</div>
        </details>`).join('');
      anyClosing = true;
    }

    $('#closing-band').hidden = !anyClosing;
  }

  /** Hero tiles. Role count is live; the other two come from config. */
  function renderHeroStats() {
    const stats = state.data.hero_stats;
    const open = state.jobs.filter((j) => j.is_accepting).length;
    const tiles = [{ value: String(open), label: open === 1 ? 'open role' : 'open roles' }];

    if (Array.isArray(stats)) {
      stats.slice(0, 3).forEach((s) => {
        if (s && s.value && s.label) tiles.push({ value: String(s.value), label: String(s.label) });
      });
    }
    $('#hero-stats').innerHTML = tiles.slice(0, 3).map((t) => `
      <div class="hero-stat"><b>${escapeHtml(t.value)}</b><span>${escapeHtml(t.label)}</span></div>`).join('');
  }

  function renderClosed(message) {
    setView('none');
    $('#closed-mount').innerHTML = `
      <h3>Applications are paused</h3>
      <p>${escapeHtml(message || 'We are not accepting applications right now. Please check back soon.')}</p>`;
    $('#closed-state').hidden = false;
  }

  function renderErrorState(title, msg) {
    $('#job-list').innerHTML = `
      <div class="state-block" style="grid-column:1/-1">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(msg)}</p>
        <p style="margin-top:16px"><button type="button" class="btn btn-ghost" id="retry-load">Try again</button></p>
      </div>`;
    const b = $('#retry-load');
    if (b) b.addEventListener('click', boot);
  }

  function renderDeptFilters() {
    const bar = $('#dept-bar');
    const depts = Array.isArray(state.data.departments) ? state.data.departments : [];
    const counts = new Map();
    state.jobs.forEach((j) => counts.set(j.department, (counts.get(j.department) || 0) + 1));

    const withJobs = depts.filter((d) => counts.get(d.value))
                          .sort((a, b) => (a.order || 0) - (b.order || 0));

    // The design always draws this row, so the only reason to omit it is
    // having nothing to filter. Suppressing it below two teams made the
    // feature look unbuilt whenever hiring was concentrated on one team.
    if (!state.jobs.length) { bar.innerHTML = ''; return; }

    const chip = (v, label, count) => `
      <button type="button" class="dept-chip" data-dept="${escapeHtml(v)}"
              aria-pressed="${(state.filter || '') === v ? 'true' : 'false'}">
        ${escapeHtml(label)}<span class="count">${count}</span>
      </button>`;

    bar.innerHTML = chip('', 'All roles', state.jobs.length) +
      withJobs.map((d) => chip(d.value, d.label, counts.get(d.value))).join('');
  }

  function metaLine(job) {
    return [job.location, job.employment_type ? titleCase(job.employment_type) : null]
      .filter(Boolean).join(' · ');
  }

  function jobCardHtml(job) {
    const closed = !job.is_accepting;
    const showSpots = job.spots_left != null && job.spots_left > 0 && job.spots_left <= SPOTS_URGENCY_MAX;
    return `
      <button type="button" class="job-card${closed ? ' is-closed' : ''}"
              data-slug="${escapeHtml(job.slug)}"${closed ? ' aria-disabled="true"' : ''}>
        <div class="job-card-top">
          <span class="job-dept">${escapeHtml(titleCase(job.department))}</span>
          ${closed ? `<span class="closed-chip">${job.is_full ? 'Filled' : 'Closed'}</span>`
                   : (showSpots ? `<span class="spots-chip">${job.spots_left} left</span>` : '')}
        </div>
        <h3>${escapeHtml(job.title)}</h3>
        ${job.summary ? `<p class="job-summary">${escapeHtml(job.summary)}</p>` : ''}
        <div class="job-card-foot">
          <span class="job-meta-line">${escapeHtml(metaLine(job))}</span>
          ${closed ? '' : `<span class="go">${icon('i-arrow', 14)}</span>`}
        </div>
      </button>`;
  }

  function renderJobList() {
    const list = $('#job-list');
    const shown = state.filter ? state.jobs.filter((j) => j.department === state.filter) : state.jobs;

    $('#role-count').textContent = state.jobs.length
      ? `${shown.length} ${shown.length === 1 ? 'role' : 'roles'}` : '';

    if (!state.jobs.length) {
      list.innerHTML = `
        <div class="state-block" style="grid-column:1/-1">
          <h3>No open roles right now</h3>
          <p>We are not hiring for a specific role at the moment, but we always read speculative
             applications. Email <a href="mailto:careers@boostowl.io">careers@boostowl.io</a> and
             tell us what you would want to own.</p>
        </div>`;
      $('#dept-bar').innerHTML = '';
      return;
    }

    list.innerHTML = shown.length ? shown.map(jobCardHtml).join('')
      : `<div class="state-block" style="grid-column:1/-1">
           <h3>Nothing open on that team</h3><p>Try another team, or view all roles.</p>
         </div>`;

    const label = state.filter ? optionLabel(state.data.departments, state.filter) : 'all teams';
    announce(`Showing ${shown.length} ${shown.length === 1 ? 'role' : 'roles'} in ${label}.`, $('#list-status'));
  }

  function renderJobDetail(job) {
    const meta = [job.location, job.work_mode ? titleCase(job.work_mode) : null,
                  job.employment_type ? titleCase(job.employment_type) : null,
                  job.experience_level, job.salary_band].filter(Boolean);

    const block = (title, md) => md
      ? `<div class="detail-block"><h3>${escapeHtml(title)}</h3><div class="prose">${MD.render(md)}</div></div>`
      : '';

    $('#detail-mount').innerHTML = `
      <span class="job-dept">${escapeHtml(titleCase(job.department))}</span>
      <h2>${escapeHtml(job.title)}</h2>
      <div class="detail-meta">${meta.map((m) => `<span class="meta-chip">${escapeHtml(m)}</span>`).join('')}</div>
      ${job.summary ? `<p class="detail-intro">${escapeHtml(job.summary)}</p>` : ''}
      <div class="detail-lists">
        ${block('What you will own', job.description_md)}
        ${block('What we look for', job.requirements_md)}
      </div>
      ${job.nice_to_have_md ? block('Nice to have', job.nice_to_have_md) : ''}
      ${(job.skills || []).length ? `<div class="skill-chips">
        ${job.skills.map((s) => `<span class="skill-chip">${escapeHtml(s)}</span>`).join('')}</div>` : ''}`;

    const qCount = (job.custom_questions || []).length;
    $('#step-preview').innerHTML = STEPS.map((st) => {
      const meta = st.n === 2 ? `${3 + qCount} fields`
                 : st.n === 3 ? `PDF, ${bytesLabel(effectiveMaxBytes())}` : st.meta;
      return `<li><span class="n">${st.n}</span><span class="l">${escapeHtml(st.label)}</span>
                  <span class="m">${escapeHtml(meta)}</span></li>`;
    }).join('');

    $('#apply-intro').hidden = !job.is_accepting;
  }

  /* --- Wizard chrome --------------------------------------------------- */

  /** Dark card at the top of the wizard rail — the role you are applying to. */
  function renderApplyingCard() {
    const job = state.selected;
    if (!job) return;
    $('#applying-card').innerHTML = `
      <span class="eyebrow">Applying for</span>
      <h3>${escapeHtml(job.title)}</h3>
      <div class="meta">${escapeHtml(metaLine(job))}</div>`;
  }


  function renderTracker() {
    const job = state.selected;
    const qCount = ((job && job.custom_questions) || []).length;
    $('#tracker').innerHTML = STEPS.map((st) => {
      const active = st.n === state.step;
      const past = st.n < state.step;
      const meta = st.n === 2 ? `${3 + qCount} fields`
                 : st.n === 3 ? `PDF, ${bytesLabel(effectiveMaxBytes())}` : st.meta;
      return `<li class="${active ? 'is-active' : past ? 'is-past' : ''}">
                <span class="n">${past ? '✓' : st.n}</span>
                <span class="l">${escapeHtml(st.label)}</span>
                <span class="m">${escapeHtml(meta)}</span>
              </li>`;
    }).join('');
  }

  function showStep(n, focus) {
    state.step = n;
    const st = STEPS[n - 1];

    for (let i = 1; i <= 3; i++) $('#step-' + i).hidden = i !== n;

    $('#step-title').textContent   = st.title;
    $('#step-hint').textContent    = st.hint;
    $('#step-counter').textContent = `Step ${n} of 3`;
    $('#submit-btn').textContent   = st.next;
    $('#step-back').hidden         = n === 1;
    $('#progress-bar').style.width = (n / 3 * 100) + '%';

    renderTracker();
    if (focus !== false) $('#step-title').focus();
  }

  /* --- Field builders --------------------------------------------------- */

  function fieldHtml({ id, label, required, help, control }) {
    return `
      <div class="field" data-field="${escapeHtml(id)}">
        <label class="label" for="${escapeHtml(id)}">
          ${escapeHtml(label)}${required ? '<span class="req" aria-hidden="true">*</span><span class="sr-only">required</span>' : ''}
        </label>
        ${help ? `<p class="help" id="${escapeHtml(id)}-help">${escapeHtml(help)}</p>` : ''}
        ${control}
        <div class="error-slot" id="${escapeHtml(id)}-err"></div>
      </div>`;
  }

  function selectHtml(id, options, value, placeholder) {
    const opts = (options || []).map((o) => {
      const v = typeof o === 'string' ? o : o.value;
      const l = typeof o === 'string' ? o : (o.label || o.value);
      return `<option value="${escapeHtml(v)}"${v === value ? ' selected' : ''}>${escapeHtml(l)}</option>`;
    }).join('');
    return `<select class="control" id="${escapeHtml(id)}">
        <option value="">${escapeHtml(placeholder || 'Select one')}</option>${opts}</select>`;
  }

  function renderQuestion(q) {
    const id = qDomId(q.id);
    const val = state.answers[q.id];
    const describedBy = q.help ? ` aria-describedby="${id}-help"` : '';

    switch (q.type) {
      case 'short_text': {
        const max = Math.min(Number(q.max_length) || 200, 200);
        return fieldHtml({ id, label: q.label, required: q.required, help: q.help,
          control: `<input type="text" class="control" id="${id}" maxlength="${max}" value="${escapeHtml(val || '')}"${describedBy}>` });
      }
      case 'long_text': {
        const max = Math.min(Number(q.max_length) || 1000, 1000);
        const min = Math.max(0, Number(q.min_length) || 0);
        return fieldHtml({ id, label: q.label, required: q.required, help: q.help,
          control: `<textarea class="control" id="${id}" maxlength="${max}" data-min="${min}" data-max="${max}"${describedBy}>${escapeHtml(val || '')}</textarea>
                    ${min ? `<div class="counter" id="${id}-counter" aria-live="off"></div>` : ''}` });
      }
      case 'select':
        return fieldHtml({ id, label: q.label, required: q.required, help: q.help,
          control: selectHtml(id, q.options, val) });
      case 'multi_select': {
        const maxSel = Math.min(Number(q.max_select) || 10, 10);
        const picked = Array.isArray(val) ? val : [];
        return `
          <div class="field" data-field="${escapeHtml(id)}">
            <fieldset class="fieldset" data-maxselect="${maxSel}">
              <legend class="legend">${escapeHtml(q.label)}${q.required ? '<span class="req" aria-hidden="true">*</span><span class="sr-only">required</span>' : ''}</legend>
              ${q.help ? `<p class="help">${escapeHtml(q.help)}</p>` : ''}
              <div class="check-group">
                ${(q.options || []).map((o, i) => `
                  <label class="check-row">
                    <input type="checkbox" id="${id}_${i}" value="${escapeHtml(o)}" data-group="${id}"${picked.includes(o) ? ' checked' : ''}>
                    <span class="check-box">${icon('i-check', 13)}</span><span>${escapeHtml(o)}</span>
                  </label>`).join('')}
              </div>
            </fieldset>
            <div class="error-slot" id="${id}-err"></div>
          </div>`;
      }
      case 'boolean':
        return `
          <div class="field" data-field="${escapeHtml(id)}">
            <fieldset class="fieldset">
              <legend class="legend">${escapeHtml(q.label)}${q.required ? '<span class="req" aria-hidden="true">*</span><span class="sr-only">required</span>' : ''}</legend>
              ${q.help ? `<p class="help">${escapeHtml(q.help)}</p>` : ''}
              <div class="seg">
                <label class="seg-option"><input type="radio" name="${id}" value="true" data-bool="${id}"${val === true ? ' checked' : ''}><span>Yes</span></label>
                <label class="seg-option"><input type="radio" name="${id}" value="false" data-bool="${id}"${val === false ? ' checked' : ''}><span>No</span></label>
              </div>
            </fieldset>
            <div class="error-slot" id="${id}-err"></div>
          </div>`;
      case 'url':
        return fieldHtml({ id, label: q.label, required: q.required, help: q.help,
          control: `<input type="url" inputmode="url" class="control" id="${id}" maxlength="500" placeholder="https://" value="${escapeHtml(val || '')}"${describedBy}>` });
      case 'number': {
        const a = [];
        if (q.min !== undefined) a.push(`min="${Number(q.min)}"`);
        if (q.max !== undefined) a.push(`max="${Number(q.max)}"`);
        return fieldHtml({ id, label: q.label, required: q.required, help: q.help,
          control: `<input type="number" inputmode="numeric" class="control" id="${id}" ${a.join(' ')} value="${val === undefined ? '' : escapeHtml(String(val))}"${describedBy}>` });
      }
      default:
        console.warn('[careers] unknown question type:', q.type);
        return '';
    }
  }

  function resumeFieldHtml(job) {
    const d = state.data;
    const uploadsOn = d.resume_upload_enabled === true && job.resume_mode !== 'disabled';

    if (!uploadsOn) {
      if (job.resume_mode === 'disabled') return '';
      return `<div class="notice notice-info">${icon('i-alert', 16)}
        <span>CV uploads are paused right now. Please add a link to your CV or portfolio below.</span></div>`;
    }
    const required = job.resume_mode === 'required';
    const max = bytesLabel(effectiveMaxBytes());

    return `
      <div class="field" data-field="resume">
        <label class="label" for="resume-input">Your CV${required ? '<span class="req" aria-hidden="true">*</span><span class="sr-only">required</span>' : ''}</label>
        <div class="dropzone" id="dropzone">
          <input type="file" id="resume-input" accept="application/pdf,.pdf" aria-describedby="resume-help">
          <span class="dz-icon">${icon('i-upload', 22)}</span>
          <span class="dz-label">Drop a PDF here, or click to choose</span>
          <span class="dz-hint" id="resume-help">PDF only, up to ${escapeHtml(max)}.${required ? '' : ' Optional if you link a portfolio below.'}</span>
        </div>
        <div class="error-slot" id="resume-err"></div>
      </div>`;
  }

  /** Builds all three step bodies. Called once per role selection. */
  function renderForm(job) {
    const o = state.data.form_options || {};
    const f = state.form;
    const questions = Array.isArray(job.custom_questions) ? job.custom_questions : [];

    $('#step-1').innerHTML = `
      <div class="field-row">
        ${fieldHtml({ id: 'full_name', label: 'Full name', required: true,
          control: `<input type="text" class="control" id="full_name" autocomplete="name" maxlength="80" placeholder="Riya Sharma" value="${escapeHtml(f.full_name || '')}">` })}
        ${fieldHtml({ id: 'email', label: 'Email', required: true,
          control: `<input type="email" class="control" id="email" autocomplete="email" maxlength="254" placeholder="you@example.com" value="${escapeHtml(f.email || '')}">` })}
      </div>
      <div class="field-row">
        ${fieldHtml({ id: 'phone', label: 'Phone', required: true, help: 'We use WhatsApp for scheduling.',
          control: `<input type="tel" class="control" id="phone" autocomplete="tel" maxlength="20" placeholder="+91 98765 43210" value="${escapeHtml(f.phone || '')}">` })}
        ${fieldHtml({ id: 'location_city', label: 'Current city', required: true,
          control: `<input type="text" class="control" id="location_city" autocomplete="address-level2" maxlength="60" placeholder="Delhi NCR" value="${escapeHtml(f.location_city || '')}">` })}
      </div>`;

    $('#step-2').innerHTML = `
      <div class="field-row">
        ${fieldHtml({ id: 'experience_bucket', label: 'Years of relevant experience', required: true,
          control: selectHtml('experience_bucket', o.experience_bucket, f.experience_bucket) })}
        ${fieldHtml({ id: 'notice_period', label: 'Notice period', required: true,
          control: selectHtml('notice_period', o.notice_period, f.notice_period) })}
      </div>
      ${fieldHtml({ id: 'why_boostowl', label: 'Why this role, at this stage?', required: true,
        help: `A few honest sentences beat a cover letter. ${WHY_MIN} characters minimum.`,
        control: `<textarea class="control" id="why_boostowl" maxlength="${WHY_MAX}" data-min="${WHY_MIN}" data-max="${WHY_MAX}"
                    placeholder="What draws you to small-business software, and what you would want to own here.">${escapeHtml(f.why_boostowl || '')}</textarea>
                  <div class="counter" id="why_boostowl-counter" aria-live="off"></div>` })}
      ${questions.map(renderQuestion).join('')}`;

    $('#step-3').innerHTML = `
      ${resumeFieldHtml(job)}
      <div class="field-row">
        ${fieldHtml({ id: 'linkedin_url', label: 'LinkedIn',
          control: `<input type="url" class="control" id="linkedin_url" autocomplete="url" maxlength="500" placeholder="https://linkedin.com/in/…" value="${escapeHtml(f.linkedin_url || '')}">` })}
        ${fieldHtml({ id: 'portfolio_url', label: 'Portfolio or GitHub',
          control: `<input type="url" class="control" id="portfolio_url" maxlength="500" placeholder="https://" value="${escapeHtml(f.portfolio_url || '')}">` })}
      </div>
      ${fieldHtml({ id: 'source', label: 'How did you hear about us?',
        control: selectHtml('source', o.source, f.source) })}
      <div class="field" data-field="consent">
        <div class="consent-block">
          <label class="check-row">
            <input type="checkbox" id="consent"${f.consent ? ' checked' : ''}>
            <span class="check-box">${icon('i-check', 13)}</span>
            <span class="consent-text">${escapeHtml(state.data.consent_text || 'I agree that BoostOwl may store and process this application to assess me for this role, keep it for up to 12 months, and delete it on request.')}
              <a href="/privacy.html" target="_blank" rel="noopener">Privacy policy</a>.</span>
          </label>
        </div>
        <div class="error-slot" id="consent-err"></div>
      </div>`;

    updateCounters();
    renderResumeState();
  }

  function updateCounters() {
    $$('textarea[data-min]').forEach((ta) => {
      const counter = $('#' + ta.id + '-counter');
      if (!counter) return;
      const len = sanitizeText(ta.value).length;
      const min = Number(ta.dataset.min) || 0;
      const max = Number(ta.dataset.max) || 0;
      counter.textContent = len < min ? `${min - len} more characters needed` : `${len} / ${max}`;
      counter.className = 'counter' + (len > max ? ' is-over' : (len >= min ? ' is-ok' : ''));
    });
  }

  /* =====================================================================
     §6  VALIDATION — mirrors _lib/validate.js. Never trusted; the server
     re-validates everything.
     ===================================================================== */
  const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.]+(\.[^\s@.]+)+$/;
  const PRIVATE_HOST_RE =
    /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

  function normalizePhone(raw) {
    let s = String(raw || '').trim();
    const hadPlus = s.startsWith('+');
    s = s.replace(/[^\d]/g, '');
    if (!s) return null;
    if (hadPlus) return '+' + s;
    if (s.length === 10 && /^[6-9]/.test(s)) return '+91' + s;
    if (s.length === 11 && s.startsWith('0') && /^[6-9]/.test(s.slice(1))) return '+91' + s.slice(1);
    if (s.length === 12 && s.startsWith('91') && /^[6-9]/.test(s.slice(2))) return '+' + s;
    return null;
  }

  function checkUrl(value, { required, hosts, label }) {
    const v = sanitizeText(value);
    if (!v) return required ? `${label} is required.` : null;
    if (v.length > 500) return `That ${label} is too long.`;
    let u;
    try { u = new URL(v); } catch (e) { return `Enter a full URL including https://`; }
    if (u.protocol !== 'https:') return 'Please use an https:// link.';
    if (PRIVATE_HOST_RE.test(u.hostname)) return 'That link is not publicly reachable.';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return 'Please use a domain name, not an IP address.';
    if (hosts) {
      const h = u.hostname.toLowerCase();
      if (!hosts.some((x) => h === x || h.endsWith('.' + x))) {
        return `That does not look like a ${hosts[0]} URL.`;
      }
    }
    return null;
  }

  function validateStandard(key, value) {
    const o = state.data.form_options || {};
    const inList = (list, v) => (list || []).some((x) => (typeof x === 'string' ? x : x.value) === v);

    switch (key) {
      case 'full_name': {
        const n = sanitizeText(value);
        if (n.length < 2 || n.length > 80) return 'Please enter your name (2-80 characters).';
        const letters = (n.match(/\p{L}/gu) || []).length;
        if (letters < 2 || letters / n.length < 0.6) return 'Please enter your real name.';
        return null;
      }
      case 'email': {
        const e = sanitizeText(value).toLowerCase();
        if (!e) return 'Email is required.';
        if (e.length < 5 || e.length > 254 || !EMAIL_RE.test(e)) return 'That email address does not look right.';
        return null;
      }
      case 'phone': {
        if (!sanitizeText(value)) return 'Phone number is required.';
        const p = normalizePhone(value);
        if (!p) return 'Use a 10-digit Indian mobile, or include the country code (e.g. +1 415 555 2671).';
        const digits = p.slice(1);
        if (digits.length < 8 || digits.length > 15) return 'That phone number does not look right.';
        if (/^(\d)\1+$/.test(digits)) return 'That phone number does not look right.';
        if ('01234567890123456789'.includes(digits) || '98765432109876543210'.includes(digits)) {
          return 'That phone number does not look right.';
        }
        return null;
      }
      case 'location_city': {
        const c = sanitizeText(value);
        if (c.length < 2 || c.length > 60) return 'Please enter your current city.';
        if (!/^[\p{L}\p{M}\s.,'()-]+$/u.test(c)) return 'Please enter a valid city name.';
        return null;
      }
      case 'experience_bucket':
        return inList(o.experience_bucket, value) ? null : 'Please choose your experience level.';
      case 'notice_period':
        return inList(o.notice_period, value) ? null : 'Please choose your availability.';
      case 'expected_ctc_band':
        return !value || inList(o.expected_ctc_band, value) ? null : 'Please choose a valid option.';
      case 'source':
        return !value || inList(o.source, value) ? null : 'Please choose a valid option.';
      case 'linkedin_url':
        return checkUrl(value, { hosts: ['linkedin.com'], label: 'LinkedIn URL' });
      case 'portfolio_url':
        return checkUrl(value, { label: 'portfolio URL' });
      case 'github_url':
        return checkUrl(value, { hosts: ['github.com', 'gitlab.com', 'bitbucket.org'], label: 'GitHub URL' });
      case 'why_boostowl': {
        const w = sanitizeText(value);
        if (w.length < WHY_MIN) return `Please write at least ${WHY_MIN} characters - this is the answer we read most closely.`;
        if (w.length > WHY_MAX) return `Please keep this under ${WHY_MAX} characters.`;
        return null;
      }
      case 'consent':
        return value === true ? null : 'Please agree to how we handle your data.';
      default:
        return null;
    }
  }

  function validateQuestion(q, value) {
    const missing = value === undefined || value === null || value === '' ||
                    (Array.isArray(value) && value.length === 0);
    if (missing) return q.required ? 'This question is required.' : null;

    switch (q.type) {
      case 'short_text':
      case 'long_text': {
        const max = Math.min(Number(q.max_length) || (q.type === 'long_text' ? 1000 : 200),
                             q.type === 'long_text' ? 1000 : 200);
        const min = Math.max(0, Number(q.min_length) || 0);
        const t = sanitizeText(value);
        if (t.length > max) return `Please keep this under ${max} characters.`;
        if (t.length < min) return `Please write at least ${min} characters.`;
        return null;
      }
      case 'select':
        return (q.options || []).includes(sanitizeText(value)) ? null : 'Please choose one of the listed options.';
      case 'multi_select': {
        if (!Array.isArray(value)) return 'Please choose from the listed options.';
        const maxSel = Math.min(Number(q.max_select) || 10, 10);
        if (value.length > maxSel) return `Please choose at most ${maxSel}.`;
        return value.every((v) => (q.options || []).includes(v)) ? null : 'Please choose from the listed options.';
      }
      case 'boolean':
        return typeof value === 'boolean' ? null : 'Please answer yes or no.';
      case 'url':
        return checkUrl(value, { required: q.required, label: 'link' });
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'Please enter a number.';
        if (q.min !== undefined && n < Number(q.min)) return `Minimum is ${q.min}.`;
        if (q.max !== undefined && n > Number(q.max)) return `Maximum is ${q.max}.`;
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Validate everything, or just one wizard step.
   * Per-step validation is what makes "Continue" fail early instead of
   * letting someone reach step 3 with a broken email.
   */
  function validateAll(step) {
    const errors = {};
    const job = state.selected;
    const only = step ? STEP_FIELDS[step] : null;
    const wants = (k) => !only || only.indexOf(k) !== -1;

    STANDARD_KEYS.forEach((k) => {
      if (k === 'resume' || !wants(k)) return;
      const v = k === 'consent' ? state.form.consent === true : state.form[k];
      const msg = validateStandard(k, v);
      if (msg) errors[k] = msg;
    });

    // Custom questions live on step 2.
    if (!step || step === 2) {
      (job.custom_questions || []).forEach((q) => {
        const msg = validateQuestion(q, state.answers[q.id]);
        if (msg) errors[q.id] = msg;
      });
    }

    if (wants('resume')) {
      const uploadsOn = state.data.resume_upload_enabled === true && job.resume_mode !== 'disabled';
      if (uploadsOn && job.resume_mode === 'required' && (!state.resume || state.resume.status !== 'ready')) {
        errors.resume = 'A PDF CV is required for this role.';
      }
      if (state.resume && state.resume.status === 'error') errors.resume = state.resume.error;
    }

    return { ok: Object.keys(errors).length === 0, errors };
  }

  /** Which step a given error key belongs to, so we can jump back to it. */
  function stepForKey(key) {
    for (const n of [1, 2, 3]) if (STEP_FIELDS[n].indexOf(key) !== -1) return n;
    return 2;   // custom questions
  }

  /* --- Error display --------------------------------------------------- */

  function domIdFor(key) {
    if (STANDARD_KEYS.includes(key)) return key;
    return qDomId(key);
  }

  function setFieldError(key, msg) {
    const id = domIdFor(key);
    const slot = $('#' + id + '-err');
    if (slot) {
      slot.innerHTML = `<p class="error-text">${icon('i-alert', 14)}<span>${escapeHtml(msg)}</span></p>`;
    }
    const control = $('#' + id);
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      const help = $('#' + id + '-help');
      control.setAttribute('aria-describedby', [help ? id + '-help' : '', id + '-err'].filter(Boolean).join(' '));
    }
  }

  function clearFieldError(key) {
    const id = domIdFor(key);
    const slot = $('#' + id + '-err');
    if (slot) slot.innerHTML = '';
    const control = $('#' + id);
    if (control) {
      control.removeAttribute('aria-invalid');
      const help = $('#' + id + '-help');
      if (help) control.setAttribute('aria-describedby', id + '-help');
      else control.removeAttribute('aria-describedby');
    }
  }

  function clearAllErrors() {
    Object.keys(state.errors).forEach(clearFieldError);
    state.errors = {};
    const s = $('#error-summary');
    s.hidden = true;
    s.innerHTML = '';
  }

  function labelFor(key) {
    const job = state.selected;
    const q = (job.custom_questions || []).find((x) => x.id === key);
    if (q) return q.label;
    const el = $(`.field[data-field="${domIdFor(key)}"] .label, .field[data-field="${domIdFor(key)}"] .legend`);
    return el ? el.textContent.replace('*', '').replace('required', '').trim() : key;
  }

  function showErrors(errors, orphanMessages) {
    clearAllErrors();
    state.errors = errors;

    const items = [];
    Object.keys(errors).forEach((key) => {
      setFieldError(key, errors[key]);
      items.push(`<li><a href="#${escapeHtml(domIdFor(key))}">${escapeHtml(labelFor(key))}: ${escapeHtml(errors[key])}</a></li>`);
    });

    const orphans = (orphanMessages || []).map(
      (m) => `<li class="form-level">${escapeHtml(m)}</li>`
    );

    const summary = $('#error-summary');
    summary.innerHTML = `
      <h4>${icon('i-alert', 15)} Please fix ${items.length + orphans.length === 1 ? 'this' : 'these'} before submitting</h4>
      <ol>${items.join('')}${orphans.join('')}</ol>`;
    summary.hidden = false;
    summary.focus();
    summary.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * Map the server's errors:{field:msg} back onto inputs.
   *
   * Custom-question errors arrive keyed by BARE question id, which can
   * collide with a standard field name. Standard fields win; anything
   * unmapped goes to the orphan list so no message is silently swallowed.
   */
  function applyServerErrors(errors) {
    const job = state.selected;
    const map = new Map();
    (job.custom_questions || []).forEach((q) => map.set(q.id, q.id));
    STANDARD_KEYS.forEach((k) => map.set(k, k));

    const mapped = {};
    const orphans = [];
    Object.keys(errors || {}).forEach((key) => {
      if (key === '_form' || key === 'custom_answers' || !map.has(key)) {
        orphans.push(errors[key]);
      } else {
        mapped[key] = errors[key];
      }
    });
    // Jump to whichever step the first error belongs to before showing it.
    const first = Object.keys(mapped)[0];
    if (first) {
      const target = stepForKey(first);
      if (target !== state.step) showStep(target, false);
    }
    showErrors(mapped, orphans);
  }

  /* =====================================================================
     §7  RESUME
     ===================================================================== */
  function effectiveMaxBytes() {
    const cfg = Number(state.data && state.data.resume_max_bytes) || 2097152;
    return Math.min(cfg, B64_SAFE_MAX_BYTES);
  }

  function readSlice(file, bytes) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(new Uint8Array(r.result));
      r.onerror = () => reject(new Error('READ_FAILED'));
      r.readAsArrayBuffer(file.slice(0, bytes));
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result);
        const i = s.indexOf(';base64,');
        // Never split(',')[1] — a data URL can carry a comma in its params.
        if (i < 0) return reject(new Error('READ_FAILED'));
        resolve(s.slice(i + 8));
      };
      r.onerror = () => reject(new Error('READ_FAILED'));
      r.readAsDataURL(file);
    });
  }

  async function onFilePick(file) {
    if (!file) return;
    const max = effectiveMaxBytes();

    const fail = (msg) => {
      state.resume = { name: file.name, size: file.size, status: 'error', error: msg };
      renderResumeState();
      setFieldError('resume', msg);
    };

    if (file.size === 0) return fail('That file appears to be empty.');
    if (file.size > max) {
      return fail(`That file is ${bytesLabel(file.size)}. Please upload a PDF under ${bytesLabel(max)}.`);
    }
    if (!/\.pdf$/i.test(file.name)) return fail('Please upload a PDF file.');
    if (file.type && file.type !== 'application/pdf') return fail('Please upload a PDF file.');

    state.resume = { file, name: file.name, size: file.size, status: 'reading' };
    renderResumeState();
    setSubmitEnabled(false);

    try {
      // Magic bytes: catches a renamed .docx in under a millisecond, before
      // a 2 MB base64 round trip.
      const head = await readSlice(file, 5);
      const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d];  // %PDF-
      if (head.length < 5 || !pdf.every((b, i) => head[i] === b)) {
        return fail('That file is not a PDF. Please export your resume as a PDF and try again.');
      }
      const b64 = await fileToBase64(file);
      state.resume = { file, name: file.name, size: file.size, b64, status: 'ready' };
      clearFieldError('resume');
      renderResumeState();
    } catch (err) {
      fail('We could not read that file. Please try another PDF.');
    } finally {
      setSubmitEnabled(true);
    }
  }

  function clearResume() {
    state.resume = null;
    clearFieldError('resume');
    renderResumeState();
  }

  function renderResumeState() {
    const dz = $('#dropzone');
    if (!dz) return;
    const r = state.resume;

    dz.classList.toggle('is-ready', !!r && r.status === 'ready');
    dz.classList.toggle('is-error', !!r && r.status === 'error');

    const input = dz.querySelector('input[type="file"]');
    const rest = Array.from(dz.children).filter((c) => c !== input);
    rest.forEach((c) => c.remove());

    const add = (html) => dz.insertAdjacentHTML('beforeend', html);

    if (!r) {
      add(`<span class="dz-icon">${icon('i-upload', 24)}</span>
           <span class="dz-label">Choose a PDF or drop it here</span>
           <span class="dz-hint">Max ${escapeHtml(bytesLabel(effectiveMaxBytes()))}</span>`);
    } else if (r.status === 'reading') {
      add(`<div class="spinner spinner-sm"></div><span class="dz-hint">Reading ${escapeHtml(r.name)}…</span>`);
    } else if (r.status === 'ready') {
      add(`<div class="file-chip">
             ${icon('i-file', 18)}
             <span class="file-name">${escapeHtml(r.name)}</span>
             <span class="file-size">${escapeHtml(bytesLabel(r.size))}</span>
             <button type="button" class="file-remove" id="resume-remove" aria-label="Remove resume">&times;</button>
           </div>`);
    } else {
      add(`<span class="dz-icon">${icon('i-alert', 22)}</span>
           <span class="dz-label">Try another file</span>
           <span class="dz-hint">${escapeHtml(r.name || '')}</span>`);
    }
  }

  /* =====================================================================
     §8  TURNSTILE
     ===================================================================== */
  function loadTurnstile(siteKey) {
    if (!siteKey) return;
    state.turnstile.status = 'loading';

    window.__tsReady = () => {
      try {
        state.turnstile.widgetId = window.turnstile.render('#ts-mount', {
          sitekey: siteKey,
          appearance: 'always',
          callback: (token) => {
            state.turnstile.token = token;
            state.turnstile.tokenAt = Date.now();
            state.turnstile.status = 'ready';
          },
          'expired-callback': () => {
            state.turnstile.token = null;
            if (state.turnstile.widgetId !== null) window.turnstile.reset(state.turnstile.widgetId);
          },
          'error-callback': () => { state.turnstile.status = 'failed'; },
        });
      } catch (err) {
        console.error('[careers] turnstile render failed:', err.message);
        state.turnstile.status = 'failed';
      }
    };

    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsReady';
    s.async = true;
    s.defer = true;
    s.onerror = () => { state.turnstile.status = 'failed'; };
    document.head.appendChild(s);

    setTimeout(() => {
      if (state.turnstile.status === 'loading') {
        state.turnstile.status = 'failed';
        console.warn('[careers] turnstile did not load within 8s');
      }
    }, TS_LOAD_TIMEOUT);
  }

  /**
   * Turnstile tokens expire after ~300s. On a form someone sits on for ten
   * minutes the token is almost always stale by submit, so reset and wait
   * for a fresh one rather than sending a guaranteed CAPTCHA_FAILED.
   */
  async function getTurnstileToken() {
    const ts = state.turnstile;
    if (ts.status === 'off' || ts.status === 'failed') return null;
    if (ts.widgetId === null) return ts.token;

    const stale = !ts.token || (Date.now() - ts.tokenAt > TS_TOKEN_STALE_MS);
    if (!stale) return ts.token;

    ts.token = null;
    try { window.turnstile.reset(ts.widgetId); } catch (e) { return null; }

    for (let i = 0; i < 100; i++) {
      if (ts.token) return ts.token;
      await sleep(100);
    }
    return null;
  }

  /* =====================================================================
     §9  SUBMIT
     ===================================================================== */
  function setSubmitting(on) {
    state.submitting = on;
    const btn = $('#submit-btn');
    btn.disabled = on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    btn.textContent = on ? 'Submitting…' : STEPS[state.step - 1].next;
  }

  function setSubmitEnabled(on) {
    const btn = $('#submit-btn');
    if (btn && !state.submitting) btn.disabled = !on;
  }

  function showFormNotice(kind, msg) {
    const n = $('#form-notice');
    n.className = 'notice notice-' + kind;
    n.innerHTML = `${icon('i-alert', 16)}<span>${escapeHtml(msg)}</span>`;
    n.hidden = false;
  }

  function hideFormNotice() { $('#form-notice').hidden = true; }

  /** The dwell clock runs from the token's issue time, not page load. */
  async function awaitDwell() {
    const need = ((state.data.min_dwell_seconds || 5) * 1000) + 400;
    const waited = Date.now() - state.tokenIssuedAt;
    if (waited >= need) return;
    announce('Just a moment…');
    await sleep(need - waited);
  }

  function buildPayload(tsToken) {
    const f = state.form;
    const p = {
      job_slug: state.selected.slug,
      full_name: f.full_name || '',
      email: f.email || '',
      phone: f.phone || '',
      location_city: f.location_city || '',
      experience_bucket: f.experience_bucket || '',
      notice_period: f.notice_period || '',
      linkedin_url: f.linkedin_url || '',
      why_boostowl: f.why_boostowl || '',
      custom_answers: state.answers,
      consent: f.consent === true,
      form_token: state.data.form_token,
      // Only forward a honeypot value a human actually put there. Chrome
      // autofill fires a trusted `input` event but never FOCUSES the field it
      // fills, so focus is the reliable discriminator. A bot driving a real
      // browser must focus to type, and a bot POSTing directly never runs this
      // code at all - the server check still catches it. This exists because
      // autofill silently binned real applications.
      hp_subject: state.hpTouched && $('#hp_subject') ? $('#hp_subject').value : '',
    };

    // Optional keys are omitted rather than sent empty — the server rejects
    // unknown keys but is happy with absent optional ones.
    if (f.expected_ctc_band) p.expected_ctc_band = f.expected_ctc_band;
    if (f.source) p.source = f.source;
    if (f.portfolio_url) p.portfolio_url = f.portfolio_url;
    if (f.github_url) p.github_url = f.github_url;
    if (tsToken) p.turnstile_token = tsToken;

    const utm = new URLSearchParams(location.search).get('utm_source');
    if (utm) p.utm_source = sanitizeText(utm).slice(0, 100);

    if (state.resume && state.resume.status === 'ready') {
      p.resume = { data: state.resume.b64, filename: state.resume.name, mime: 'application/pdf' };
    }
    return p;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state.submitting) return;
    hideFormNotice();

    // Steps 1 and 2 just advance — nothing is sent until the last step.
    if (state.step < 3) {
      const v = validateAll(state.step);
      if (!v.ok) return showErrors(v.errors);
      clearAllErrors();
      showStep(state.step + 1);
      $('#wizard').scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }

    if (!navigator.onLine) {
      return showFormNotice('warn', 'You appear to be offline. Reconnect and try again — nothing has been sent.');
    }

    // Final step validates EVERYTHING, not just step 3: a field on an earlier
    // step could have been emptied after it was validated.
    const v = validateAll();
    if (!v.ok) {
      const first = Object.keys(v.errors)[0];
      const target = stepForKey(first);
      if (target !== state.step) showStep(target, false);
      return showErrors(v.errors);
    }
    clearAllErrors();

    if (!state.data.form_token) {
      return showFormNotice('error', 'Applications are temporarily unavailable. Please email careers@boostowl.io.');
    }

    setSubmitting(true);
    try {
      await awaitDwell();
      const tsToken = await getTurnstileToken();
      const res = await postApplication(buildPayload(tsToken));
      if (res.body && res.body.ok === true) return onSuccess(res.body);
      await handleApiError(res.status, res.body || {});
    } catch (err) {
      await handleNetworkError(err);
    } finally {
      setSubmitting(false);
      announce('');
    }
  }

  /**
   * Error handling. "spent" means the server burned the form token before
   * returning, so a silent refresh is required or the next Submit gets
   * ALREADY_SUBMITTED. Only errors at or past step 11 spend it.
   */
  async function handleApiError(status, body) {
    const code = body.code || 'UNKNOWN';
    const msg = body.message || 'Something went wrong. Please try again.';

    switch (code) {
      // ---- token NOT spent: retry silently, once --------------------
      case 'TOO_FAST':
      case 'EXPIRED':
      case 'BAD_TOKEN':
        if (!state.autoRetried) {
          state.autoRetried = true;
          if (code !== 'TOO_FAST') await refreshToken();
          await awaitDwell();
          const tsToken = await getTurnstileToken();
          const retry = await postApplication(buildPayload(tsToken));
          if (retry.body && retry.body.ok === true) return onSuccess(retry.body);
          return handleApiError(retry.status, retry.body || {});
        }
        await refreshToken();
        return showFormNotice('warn', 'Something got out of sync. Please press Submit once more.');

      case 'ALREADY_SUBMITTED':
        return showFormNotice('warn', 'This form was already submitted. Reload the page to apply again.');

      // ---- token spent: refresh before re-enabling ------------------
      case 'VALIDATION_FAILED':
        applyServerErrors(body.errors);
        if (!(await refreshToken())) {
          setSubmitEnabled(false);
          showFormNotice('error', 'Please reload the page and try again.');
        }
        return;

      case 'DUPLICATE':
        await refreshToken();
        if (body.field) setFieldError(body.field === 'phone' ? 'phone' : 'email', msg);
        return showFormNotice('info', 'You have already applied for this role — there is no need to apply twice. We have your application.');

      case 'RESUME_TOO_LARGE':
      case 'RESUME_NOT_PDF':
      case 'RESUME_EMPTY':
      case 'RESUME_TRUNCATED':
      case 'RESUME_ENCRYPTED':
      case 'RESUME_INVALID':
        await refreshToken();
        clearResume();
        return setFieldError('resume', (body.errors && body.errors.resume) || msg);

      case 'CAPTCHA_FAILED':
        await refreshToken();
        if (state.turnstile.widgetId !== null) {
          try { window.turnstile.reset(state.turnstile.widgetId); } catch (e) { /* ignore */ }
        }
        state.turnstile.token = null;
        return showFormNotice('error', 'We could not complete the human check. If you use an ad blocker or a VPN, try disabling it, then submit again.');

      case 'JOB_FULL':
      case 'JOB_CLOSED':
      case 'JOB_NOT_FOUND':
        setSubmitEnabled(false);
        showFormNotice('warn', msg);
        await refreshToken();
        renderJobList();
        return;

      case 'RATE_LIMITED':
        setSubmitEnabled(false);
        return showFormNotice('warn', msg);

      case 'CLOSED':
        return renderClosed(msg);

      case 'BUSY':
      case 'UNAVAILABLE':
        await refreshToken();
        return showFormNotice('warn', msg + ' Your answers are still here — press Submit to try again.');

      case 'TOO_LARGE':
        clearResume();
        return setFieldError('resume', 'That file was too large to send. Please compress the PDF and try again.');

      default:
        await refreshToken();
        return showFormNotice('error', msg);
    }
  }

  async function handleNetworkError(err) {
    console.error('[careers] submit failed:', err && err.message);
    await refreshToken();
    // We genuinely cannot know whether the request reached the server, so be
    // honest. This is why DUPLICATE is worded as a confirmation.
    showFormNotice('warn',
      'Your connection dropped and we could not confirm whether that went through. ' +
      'If you submit again and it was already received, you will see an "already applied" ' +
      'message — that means the first one worked.');
  }

  function onSuccess(body) {
    state.submitted = body;
    $('#wizard').hidden = true;

    const panel = $('#success-panel');
    panel.innerHTML = `
      <span class="success-icon">${icon('i-check', 26)}</span>
      <h2>Application received</h2>
      <p>Your application for <b>${escapeHtml(state.selected.title)}</b> is in.
         ${escapeHtml(body.message || 'A human reads every one, and you hear back either way within five working days.')}</p>
      <span class="success-ref">${escapeHtml(body.reference || '')}</span>
      ${body.resume_status === 'failed'
        ? `<p style="margin-top:14px;color:var(--amber);font-size:13px">We could not save your CV file, but we have your links and will be in touch.</p>`
        : ''}
      <div class="success-actions">
        <button type="button" class="btn btn-ghost" id="browse-more">Browse other roles</button>
        <a class="btn btn-dark" href="mailto:careers@boostowl.io">Email us a question</a>
      </div>`;
    panel.hidden = false;
    panel.focus();
    panel.scrollIntoView({ block: 'center', behavior: 'smooth' });

    const b = $('#browse-more');
    if (b) b.addEventListener('click', () => { resetApplication(); closeRole(); });
  }

  function resetApplication() {
    state.submitted = null;
    state.step = 1;
    state.answers = {};
    state.resume = null;
    state.autoRetried = false;
    $('#success-panel').hidden = true;
    $('#wizard').hidden = false;
  }

  /* =====================================================================
     §10  TOKEN LIFECYCLE, EVENTS & BOOT
     ===================================================================== */
  function openRole(slug, triggerEl) {
    const job = state.jobBySlug.get(slug);
    if (!job) return;

    state.selected = job;
    state.answers = {};        // old question ids would be rejected as unknown keys
    state.autoRetried = false;
    resetApplication();
    clearAllErrors();
    hideFormNotice();

    renderJobDetail(job);
    setView('detail');

    history.pushState({ role: slug }, '', '?role=' + encodeURIComponent(slug));
    state.lastFocused = triggerEl || null;
    $('#back-to-roles').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startApply() {
    const job = state.selected;
    if (!job || !job.is_accepting) return;
    renderForm(job);
    renderApplyingCard();
    setView('apply');
    showStep(1);
    setSubmitEnabled(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function backToDetail() {
    setView('detail');
    $('#back-to-roles').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeRole() {
    state.selected = null;
    setView('list');
    if (state.lastFocused && document.body.contains(state.lastFocused)) state.lastFocused.focus();
    $('#roles-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function wireEvents() {
    // Delegated: department filters
    $('#dept-bar').addEventListener('click', (e) => {
      const btn = e.target.closest('.dept-chip');
      if (!btn) return;
      state.filter = btn.dataset.dept || null;
      $$('.dept-chip').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      renderJobList();
    });

    // Delegated: job cards
    $('#job-list').addEventListener('click', (e) => {
      const card = e.target.closest('.job-card');
      if (!card || card.classList.contains('is-closed')) return;
      openRole(card.dataset.slug, card);
    });

    $('#back-to-roles').addEventListener('click', () => { history.back(); });
    $('#back-to-detail').addEventListener('click', backToDetail);
    $('#start-apply').addEventListener('click', startApply);
    $('#step-back').addEventListener('click', () => {
      if (state.step > 1) {
        clearAllErrors();
        showStep(state.step - 1);
        $('#wizard').scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });

    // Delegated form input. One listener for the whole regenerated subtree.
    const form = $('#apply-form');

    // Focus is what separates a human from autofill here: a person must focus
    // the field to type in it, whereas Chrome fills an address group without
    // ever focusing its members. Only a focused honeypot counts as a bot.
    const hp = $('#hp_subject');
    if (hp) {
      const touch = () => { state.hpTouched = true; };
      hp.addEventListener('focus', touch);
      hp.addEventListener('keydown', touch);
      hp.addEventListener('paste', touch);
    }

    form.addEventListener('input', (e) => {
      const el = e.target;
      if (el.id === 'hp_subject') return;
      captureValue(el);
      updateCounters();
      if (state.dirty.has(el.id)) revalidateField(el);
    });

    form.addEventListener('change', (e) => {
      const el = e.target;
      if (el.id === 'hp_subject') return;
      if (el.type === 'file') { onFilePick(el.files && el.files[0]); return; }
      captureValue(el);
      state.dirty.add(el.id);
      revalidateField(el);
    });

    form.addEventListener('blur', (e) => {
      const el = e.target;
      if (!el.id || el.id === 'hp_subject') return;
      state.dirty.add(el.id);
      revalidateField(el);
    }, true);

    form.addEventListener('click', (e) => {
      if (e.target.closest('#resume-remove')) { e.preventDefault(); clearResume(); }
    });

    form.addEventListener('submit', onSubmit);

    // Drag & drop onto the dropzone
    form.addEventListener('dragover', (e) => {
      const dz = e.target.closest('.dropzone');
      if (!dz) return;
      e.preventDefault();
      dz.classList.add('is-drag');
    });
    form.addEventListener('dragleave', (e) => {
      const dz = e.target.closest('.dropzone');
      if (dz) dz.classList.remove('is-drag');
    });
    form.addEventListener('drop', (e) => {
      const dz = e.target.closest('.dropzone');
      if (!dz) return;
      e.preventDefault();
      dz.classList.remove('is-drag');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFilePick(file);
    });

    window.addEventListener('popstate', () => {
      const slug = new URLSearchParams(location.search).get('role');
      if (slug && state.jobBySlug.has(slug)) openRole(slug);
      else closeRole();
    });

    window.addEventListener('online', hideFormNotice);
    window.addEventListener('offline', () => {
      showFormNotice('warn', 'You are offline. Your answers are safe — reconnect before submitting.');
    });

    // bfcache restore: the token may have aged out, or a submitted form may
    // have been restored with its fields intact.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      if (state.submitted) { onSuccess(state.submitted); return; }
      refreshToken();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (Date.now() - state.lastRefreshAt > TOKEN_HIDDEN_MS) refreshToken();
    });

    setInterval(() => {
      if (document.hidden || state.submitting) return;
      refreshToken();
    }, TOKEN_REFRESH_MS);
  }

  function captureValue(el) {
    if (!el.id && !el.dataset.group && !el.dataset.bool) return;
    const job = state.selected;
    const questions = (job && job.custom_questions) || [];

    if (el.dataset.group) {
      const q = questions.find((x) => qDomId(x.id) === el.dataset.group);
      if (!q) return;
      const checked = $$(`input[data-group="${el.dataset.group}"]`).filter((i) => i.checked);
      state.answers[q.id] = checked.map((i) => i.value);
      return;
    }
    if (el.dataset.bool) {
      const q = questions.find((x) => qDomId(x.id) === el.dataset.bool);
      if (q) state.answers[q.id] = el.value === 'true';
      return;
    }

    if (STANDARD_KEYS.includes(el.id)) {
      state.form[el.id] = el.type === 'checkbox' ? el.checked : el.value;
      return;
    }
    const q = questions.find((x) => qDomId(x.id) === el.id);
    if (q) {
      state.answers[q.id] = q.type === 'number'
        ? (el.value === '' ? undefined : Number(el.value))
        : el.value;
    }
  }

  function revalidateField(el) {
    const job = state.selected;
    if (!job) return;
    const groupId = el.dataset.group || el.dataset.bool;
    const domId = groupId || el.id;

    if (STANDARD_KEYS.includes(domId)) {
      const v = domId === 'consent' ? state.form.consent === true : state.form[domId];
      const msg = validateStandard(domId, v);
      if (msg) { state.errors[domId] = msg; setFieldError(domId, msg); }
      else { delete state.errors[domId]; clearFieldError(domId); }
      return;
    }
    const q = (job.custom_questions || []).find((x) => qDomId(x.id) === domId);
    if (!q) return;
    const msg = validateQuestion(q, state.answers[q.id]);
    if (msg) { state.errors[q.id] = msg; setFieldError(q.id, msg); }
    else { delete state.errors[q.id]; clearFieldError(q.id); }
  }

  async function boot() {
    try {
      const data = await fetchCareers();
      state.data = data;
      state.tokenIssuedAt = Date.now();
      state.lastRefreshAt = Date.now();
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      state.jobBySlug = new Map(state.jobs.map((j) => [j.slug, j]));

      renderAll();
      wireEvents();

      if (data.applications_open !== false) {
        if (data.turnstile_site_key) loadTurnstile(data.turnstile_site_key);
        else state.turnstile.status = 'off';

        if (!data.form_token) {
          console.error('[careers] no form token issued — FORM_TOKEN_SECRET may be unset');
        }

        const slug = new URLSearchParams(location.search).get('role');
        if (slug && state.jobBySlug.has(slug)) openRole(slug);
      }
    } catch (err) {
      console.error('[careers] boot failed:', err.message);
      renderErrorState('We could not load our open roles',
        'Something went wrong on our side. Please try again in a moment, or email careers@boostowl.io.');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
