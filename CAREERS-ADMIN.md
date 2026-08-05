# BoostOwl Careers Portal — Admin Guide

Reference for running the careers portal, and the spec for a future admin UI.

**Core principle:** nothing about a job, a limit, or the page copy lives in code.
It is all rows in Postgres, editable live. A deploy only ever changes layout and logic.

- [1. Architecture](#1-architecture)
- [2. First-time setup](#2-first-time-setup)
- [3. Config reference](#3-config-reference)
- [4. Table reference](#4-table-reference)
- [5. Custom questions spec](#5-custom-questions-spec)
- [6. Daily operations](#6-daily-operations)
- [7. Cron jobs](#7-cron-jobs)
- [8. Runbooks](#8-runbooks)
- [9. Security rules — do not break these](#9-security-rules--do-not-break-these)
- [10. Admin portal spec](#10-admin-portal-spec)

---

## 1. Architecture

```
Browser (careers.html)
   │  GET  /api/careers/jobs   → open roles + page copy + form options + form token
   │  POST /api/careers/apply  → the application
   ▼
Vercel Serverless Function ── holds every secret, zero npm dependencies
   ├─ Cloudflare Turnstile   verify the human
   ├─ Upstash Redis          rate limits (falls back to Postgres if down)
   ├─ Supabase RPC           apply_to_job() — atomic cap + dedupe + insert
   ├─ Supabase Storage       private bucket, randomised filename
   └─ Resend                 email you
   ▼
Cron  (ONE schedule — Hobby caps crons at once per day)
   /api/careers/cron/daily   03:00 → maintenance → notify → score
```

**Where things live**

| | Location | Changing it needs |
|---|---|---|
| Job content, caps, questions, rubrics | `jobs` table | A row edit |
| Every threshold and switch | `config` table | A row edit |
| Careers page copy, FAQ, hiring process | `config` table | A row edit |
| Form dropdown options | `config.form_options` | A row edit |
| Page layout, validation logic | `careers.html`, `assets/careers.*`, `api/careers/*` | A deploy |

**Files**

```
CAREERS-ADMIN.md          this guide
db/01-schema.sql          tables, enums, indexes, RLS
db/02-functions.sql       apply_to_job, queue claiming, counters
db/03-seed-config.sql     every config key with its default
db/job-template.sql       job creation + maintenance SQL snippets
careers.html              the page
assets/careers.css        page + form styles (self-contained)
assets/careers.js         page engine
assets/careers-md.js      safe markdown subset renderer
api/careers/jobs.js       GET roles + page content + form token
api/careers/apply.js      POST an application
api/careers/_lib/*.js     shared modules (config, security, limits, validate...)
api/careers/cron/*.js     daily + the three workers
scripts/*.js              tests + deploy verification (never deployed)
```

---

## 2. First-time setup

### 2.1 Supabase

1. Create a project (free tier, region `ap-south-1` / Mumbai).
2. SQL Editor → run in order: `db/01-schema.sql` → `db/02-functions.sql` → `db/03-seed-config.sql`.
3. **Storage** → new bucket `resumes`. **Public: OFF.** This is not optional — a public bucket makes every resume readable by anyone with the URL.
4. **Integrations → Data API.** ⚠️ **Leave the Data API ENABLED**, with `public` among the
   exposed schemas. Every server call goes through PostgREST (`/rest/v1/...`) — disabling it
   breaks the whole portal. The security boundary is not the Data API toggle; it is RLS with
   zero policies plus a service key that never leaves the server.

   In **Data API → Settings**:

   | Setting | Value | Why |
   |---|---|---|
   | Enable Data API | **ON** | `_lib/supabase.js` calls `/rest/v1/rpc/*` and `/rest/v1/<table>` |
   | Exposed schemas | must include **public** | our tables, view and functions live there |
   | Exposed tables | leave at **0 of N** | this governs the `anon`/`authenticated` roles. `service_role` bypasses it — verified against a live project |
   | Exposed functions | leave at **0 of N** | same |
   | **Automatically expose new tables** | **turn OFF** | Supabase recommends it, and it stops a future table being auto-granted to the Data API roles |
   | Max rows | 1000 (default) | our queries cap at 100 anyway |
5. Copy the **service_role** key. It goes in Vercel only, never anywhere else.

Verify the lockdown before going further:

```sql
-- Every table must show rowsecurity = true
select tablename, rowsecurity from pg_tables where schemaname = 'public';

-- This must return ZERO rows. If it returns any, delete them.
select * from pg_policies where schemaname = 'public';
```

### 2.2 Cloudflare Turnstile

Dashboard → Turnstile → add a site for `boostowl.io` (add `localhost` for dev).
Widget mode **Managed**. Keep the site key (public) and the secret key.

### 2.3 Upstash Redis

Create a free Redis database, region Mumbai. Copy the **REST** URL and token — we use the HTTP API, not a Redis client.

### 2.4 Resend

Add and verify the domain `boostowl.io`, then create an API key. Sender: `careers@boostowl.io`.

### 2.5 Environment variables — all 11

**Production:** Vercel → Project → Settings → Environment Variables. Tick all three
environments (Production, Preview, Development).

**Local:** `cp .env.example .env.local` and fill in. See §2.6.

[`.env.example`](.env.example) is the committed template with sourcing notes for each value.

| Variable | Required | Where to get it | Used by |
|---|:---:|---|---|
| `SUPABASE_URL` | ✅ | Supabase → Settings → API → Project URL | everything |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase → Settings → API → **service_role** | everything |
| `FORM_TOKEN_SECRET` | ✅ | `openssl rand -hex 32` | `_lib/security.js` |
| `IP_HASH_SALT` | ✅ | `openssl rand -hex 32` | `_lib/security.js` |
| `CRON_SECRET` | ✅ | `openssl rand -hex 32` | all `cron/*` |
| `TURNSTILE_SITE_KEY` | ✅¹ | Cloudflare → Turnstile → your site | `jobs.js` |
| `TURNSTILE_SECRET_KEY` | ✅¹ | Cloudflare → Turnstile → your site | `_lib/security.js` |
| `UPSTASH_REDIS_REST_URL` | ⚪² | Upstash → database → **REST API** | `_lib/limits.js` |
| `UPSTASH_REDIS_REST_TOKEN` | ⚪² | Upstash → database → **REST API** | `_lib/limits.js` |
| `RESEND_API_KEY` | ⚪³ | resend.com → API Keys | `_lib/email.js`, crons |
| `AI_API_KEY` | ⚪⁴ | whichever provider `config.ai_provider` names | `_lib/ai.js` |

¹ Required unless `config.turnstile_enabled` is `false`.
² Optional — without it the limiter falls back to counting rows in Postgres. Slower, same limits, **never silently off**.
³ Optional — applications still save; `notify_status` stays `pending` and the daily cron retries.
⁴ Optional — only read when `config.ai_scoring_enabled` is `true`. Provider-specific aliases
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) take precedence if set. Endpoints
needing no auth (Ollama, LM Studio) need none of them.

**What breaks if one is missing**

| Missing | Effect |
|---|---|
| `SUPABASE_*` | Total failure. `/api/careers/jobs` returns 503 |
| `FORM_TOKEN_SECRET` | No token issued → the form **disables itself** with a "please email us" message, rather than letting someone spend ten minutes filling it in and then fail |
| `IP_HASH_SALT` | Every submission 503s (the code refuses to store an unsalted IP) |
| `CRON_SECRET` | Crons return 401 — including the Supabase keepalive, so the project pauses after 7 days |
| `TURNSTILE_SECRET_KEY` | Every submission 403s while `turnstile_enabled` is true |
| `UPSTASH_*` | Postgres fallback, with a warning in the logs |
| `RESEND_API_KEY` | No alert emails; applications unaffected |
| `AI_API_KEY` | Scoring skipped with a log line; applications unaffected |

⚠️ **Never prefix any of these with `NEXT_PUBLIC_` or `VITE_`.** Those prefixes are the opt-in
to bundling a value into the browser. `TURNSTILE_SITE_KEY` is the only public one, and it is
exposed deliberately by [api/careers/jobs.js](api/careers/jobs.js) — never by a build prefix.

⚠️ **`SUPABASE_SERVICE_KEY` bypasses RLS** and can read every application. Vercel and
`.env.local` only. `.gitignore` blocks `.env` and `.env.*` while allowing `.env.example`
(verified: `git check-ignore` exits 1 for the template, 0 for the real files).

### 2.6 Local development — yes, you can test locally

You do **not** need to deploy to test. `vercel dev` runs the serverless functions on your
machine against the same real Supabase / Upstash / Resend / Anthropic services.

```bash
npm i -g vercel          # global only — adds no dependency to this repo
vercel link              # once, connects the folder to the project
vercel env pull .env.local   # pulls the real values you set in the dashboard
vercel dev               # http://localhost:3000/careers
```

Prefer not to link? `cp .env.example .env.local`, fill it in by hand, and run `vercel dev`.

**Already wired for localhost:**
- `_lib/respond.js` allows `http://localhost:*` and `*.vercel.app` origins, so CORS passes
- `apply.js` accepts `localhost` as a Turnstile hostname
- Cloudflare's dummy Turnstile keys (in `.env.example`) need no real domain
- Or set `config.turnstile_enabled = false` in Supabase to skip captcha entirely

**What works locally vs what does not**

| | Locally | Note |
|---|:---:|---|
| Careers page, roles, filters | ✅ | |
| Full application submit | ✅ | writes to your real Supabase |
| Rate limiting | ✅ | real Upstash, or Postgres fallback |
| Turnstile | ✅ | dummy keys, or switch it off |
| Resume upload | ✅ | real Supabase Storage |
| Email alerts | ✅ | real Resend — it will actually email you |
| AI scoring | ✅ | real Anthropic — it will actually cost money |
| **Cron schedules** | ❌ | Vercel does not fire crons locally. Invoke by hand: |

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/careers/cron/daily
```

⚠️ There is no separate dev database. Local testing writes to the same Supabase project as
production. Either accept the test rows and delete them afterwards
(`delete from applications where email like '%@example.com';`) or create a second free
Supabase project and point `.env.local` at it.

**Testing without any of this** — the pure-logic suites need no env vars at all:

```bash
node scripts/test-careers-md.js        # markdown renderer + XSS corpus
node scripts/test-validator.js         # server field validation
node scripts/test-resume-validator.js  # PDF checks
node scripts/test-parity.js            # client/server agreement
```

### 2.6 Smoke test

- [ ] `/api/jobs` returns roles and page content
- [ ] `/careers` renders roles, filters, and the form
- [ ] A valid application saves and you get the email
- [ ] The same email applying twice to the same role is rejected
- [ ] Four applications from one IP within an hour: the fourth gets `429`
- [ ] A `.txt` renamed to `.pdf` is rejected
- [ ] A 5 MB PDF is rejected before the body is read
- [ ] Setting `applications_open` to `false` closes the form within 60 seconds
- [ ] `GET /api/careers/cron/daily` without the cron header returns `401`

---

## 3. Config reference

Every row in `config`. Edit `value` in the Supabase table editor; live within 60 seconds
(the function caches for 60s at module scope).

**[CEILING]** means the value is additionally clamped in code. Config can make a limit
stricter, never looser — a typo or a compromised dashboard login cannot disable a safety limit.

### Master switches

| Key | Default | Effect |
|---|---|---|
| `applications_open` | `true` | Global kill switch. `false` → every role shows `maintenance_message`, `/api/apply` returns 503 |
| `maintenance_message` | *(text)* | Shown when closed |

### Resume

| Key | Default | Effect |
|---|---|---|
| `resume_upload_enabled` | `true` | `false` → upload field disappears, form goes link-only. Flipped automatically at the storage soft limit |
| `resume_max_bytes` | `2097152` (2 MB) | **[CEILING 4 MB]** Base64 inflates ~1.37×; Vercel caps bodies at 4.5 MB |

### Anti-bot

| Key | Default | Effect |
|---|---|---|
| `turnstile_enabled` | `true` | Turnstile verification. `false` logs a loud warning every request |
| `turnstile_fail_open` | `false` | Outage override — accept when Cloudflare is unreachable. **Set back to `false` immediately after** |
| `min_form_dwell_seconds` | `5` | **[FLOOR 2]** Reject submissions faster than this. Enforced by a server-signed token, so unforgeable |

### Rate limits

| Key | Default | Ceiling | Scope |
|---|---|---|---|
| `rate_limit_ip_hour` | `3` | 20 | Per IP |
| `rate_limit_ip_day` | `10` | 50 | Per IP |
| `rate_limit_ip_week` | `20` | 100 | Per IP |
| `rate_limit_email_30d` | `3` | — | Per email, all roles |
| `rate_limit_phone_30d` | `3` | — | Per phone, all roles |

One-application-per-role is **not** here — it is a unique index on `(job_id, email_normalized)`
and `(job_id, phone_e164)`. That is a database guarantee, not a tunable.

### Global circuit breaker

| Key | Default | Ceiling |
|---|---|---|
| `global_cap_hour` | `60` | 500 |
| `global_cap_day` | `300` | 2000 |

Tripping either returns 503 to everyone and alerts you. This is the defence against a
distributed flood that individually respects per-IP limits.

### Storage

| Key | Default | Effect |
|---|---|---|
| `storage_soft_limit_bytes` | `800000000` (800 MB) | Of Supabase's 1 GB. At this point uploads stop, applications continue link-only, you get alerted |

### AI scoring

| Key | Default | Effect |
|---|---|---|
| `ai_scoring_enabled` | `false` | **MASTER SWITCH.** `false` → nothing scores, ever, regardless of any job's `ai_enabled` |
| `ai_default_for_new_jobs` | `false` | Default `ai_enabled` for new roles |
| `ai_provider` | `anthropic` | `anthropic` · `openai` · `google` · `openai_compatible` |
| `ai_model` | `claude-haiku-4-5` | Model id for that provider. Required for every provider except `anthropic` |
| `ai_base_url` | `""` | Empty = provider default. **Required** for `openai_compatible` |
| `ai_price_in_per_mtok` | `1.0` | USD/M input tokens, for cost tracking. Update when you switch model |
| `ai_price_out_per_mtok` | `5.0` | USD/M output tokens |
| `ai_daily_cap` | `100` | **[CEILING 500]** Scores per day |
| `ai_monthly_budget_usd` | `10` | **[CEILING 50]** Hard stop. Scoring pauses, applications unaffected |
| `ai_include_resume_pdf` | `true` | `false` → score form answers only, ~70% cheaper (~$0.002 vs ~$0.008) |
| `ai_batch_size` | `10` | Rows per cron run |
| `ai_max_attempts` | `3` | Retries before `failed` |
| `ai_queue_expiry_days` | `30` | Pending rows older than this become `skipped` |

### Notifications

| Key | Default |
|---|---|
| `notify_email_enabled` | `true` |
| `notify_email_to` | `admin@boostowl.io` |
| `notify_email_from` | `careers@boostowl.io` |
| `notify_ack_candidate` | `false` |
| `alert_email_to` | `admin@boostowl.io` |

### Compliance

| Key | Default | Effect |
|---|---|---|
| `retention_days` | `365` | Nightly purge of older applications + their resumes. `hired` and `offer` are exempt |
| `consent_version` | `2026-08-v1` | **Bump whenever `consent_text` changes.** Stored per application |
| `consent_text` | *(text)* | Shown next to the checkbox |

### Blocklists

| Key | Default | Effect |
|---|---|---|
| `blocked_email_domains` | 15 disposable domains | Rejected at submission |
| `blocked_emails` | `[]` | Exact normalised addresses |
| `blocked_ip_hashes` | `[]` | `sha256(ip + IP_HASH_SALT)` values |

### Content

| Key | Contains |
|---|---|
| `form_options` | Dropdown options for experience / notice period / CTC band / source. **Submitted values are validated against this list** |
| `departments` | Filter chips. Must contain every value used in `jobs.department` |
| `careers_page` | Hero copy, why-us cards, culture principles |
| `hiring_process` | The step timeline |
| `careers_faq` | Q&A pairs |

---

## 4. Table reference

### `jobs`

| Column | Notes |
|---|---|
| `slug` | `lowercase-with-hyphens`. Becomes `/careers/<slug>`. **Changing it breaks shared links** |
| `title` `department` `location` | `department` must exist in `config.departments` |
| `work_mode` | `onsite` · `hybrid` · `remote` |
| `employment_type` | `full_time` · `part_time` · `intern` · `contract` |
| `experience_level` `salary_band` | Free text |
| `summary` | One line, shown on the role card |
| `description_md` `requirements_md` `nice_to_have_md` | Markdown |
| `skills` | `text[]` — chips on the card, and an AI matching signal |
| `custom_questions` | jsonb, max 10. See §5 |
| `resume_mode` | `required` · `optional` · `disabled` |
| `is_open` | Manual switch, independent of the cap |
| `opens_at` `closes_at` | `closes_at` null = no end date |
| `max_applications` | null = unlimited. **Hard ceiling 5000** |
| `application_count` | Maintained atomically. **Do not edit by hand** |
| `blocked_attempts` | People who hit a full or closed role. High number = raise the cap |
| `ai_enabled` | Per-role switch. Master switch still wins |
| `scoring_rubric` | Blank → auto-generated from title + description + skills |
| `ai_min_score_flag` | Highlight at/above this score |
| `sort_order` | Lower appears first |

**A role accepts applications only when all of these hold:**

```
is_open = true
AND now() BETWEEN opens_at AND coalesce(closes_at, 'infinity')
AND (max_applications IS NULL OR application_count < max_applications)
```

Evaluated live, per request. Raising a cap on a full role reopens it instantly.

### `applications`

| Group | Columns |
|---|---|
| Identity | `reference` (`BO-XXXXXXXX`, shown to the candidate) · `job_id` · `job_slug` |
| Candidate | `full_name` `email` `email_normalized` `phone_e164` `location_city` `experience_bucket` `notice_period` `expected_ctc_band` `source` `linkedin_url` `portfolio_url` `github_url` `why_boostowl` `custom_answers` |
| Resume | `resume_path` `resume_original_filename` `resume_bytes` `resume_sha256` `resume_flags` `resume_status` |
| Consent | `consent_given` `consent_version` |
| Pipeline | `status` · `internal_notes` |
| AI | `ai_status` `ai_score` `ai_verdict` `ai_model` `ai_cost_usd` `ai_attempts` `ai_leased_at` `ai_scored_at` `ai_error` |
| Notify | `notify_status` `notify_attempts` |
| Metadata | `ip_hash` `ua_hash` `utm_source` `created_at` |

`email_normalized` is lowercased with `+aliases` and gmail dots stripped — so
`R.Sharma+jobs@gmail.com` and `rsharma@gmail.com` are correctly caught as the same person.

`resume_original_filename` is display only and is **never** used as a storage path.
Files are stored at `<job_slug>/<application_id>.pdf`.

**`status`** — `new` → `screening` → `interview` → `offer` → `hired`, plus `rejected`, `withdrawn`.
`hired` and `offer` are exempt from the retention purge.

**`ai_status`**

| Value | Meaning |
|---|---|
| `skipped` | AI was off (master or per-job) when it arrived. `backfill_ai_queue()` can requeue it |
| `pending` | Waiting for the cron |
| `scoring` | Leased by a worker. A stale lease is reclaimed after 10 minutes |
| `scored` | Done — see `ai_score` and `ai_verdict` |
| `failed` | 3 attempts exhausted. Reason in `ai_error` |

**`ai_verdict` shape**

```json
{ "overall_score": 72,
  "skills_match": 8, "experience_relevance": 6, "communication": 9,
  "years_relevant": 3,
  "strengths": ["..."], "concerns": ["..."], "red_flags": [],
  "recommendation": "strong_yes | interview | maybe | no" }
```

⚠️ **The score ranks; it never rejects.** Auto-rejection on an AI score is a real
discrimination-liability surface, and under the DPDP Act you would owe the applicant an
explanation of the decision. Sort by it, then read the top of the list yourself.

### `config` · `counters` · `application_events`

- **`config`** — `key` / `value` (jsonb) / `description`. §3.
- **`counters`** — `key` / `window_start` / `count`. Keys: `apps:hour`, `apps:day`, `ai:day`, `ai:spend_usd:month`. Written atomically; do not edit.
- **`application_events`** — append-only audit: `created`, `status_changed`, `ai_scored`, `notified`, `resume_attached`.

### `public_jobs` view

What `/api/jobs` serves. Adds `is_live`, `is_full`, `is_accepting`.

⚠️ **Deliberately excludes `scoring_rubric`, `ai_enabled`, `blocked_attempts`.** A rubric
states exactly what you screen for and must never reach the browser. If you add columns to
`jobs`, decide explicitly whether they belong in this view.

---

## 5. Custom questions spec

`jobs.custom_questions` is a jsonb array, **max 10 items**. The form renders from it and the
API validates against it — so adding a question is a row edit, never a deploy.

```json
[
  { "id": "built_what", "type": "long_text",
    "label": "Link something you built and describe your specific role in it.",
    "help": "A repo, a live product, an internal tool.",
    "required": true, "min_length": 50, "max_length": 600 }
]
```

### Common fields

| Field | Required | Notes |
|---|---|---|
| `id` | ✅ | `snake_case`, unique within the job, ≤40 chars. Becomes the key in `custom_answers`. **Do not change after applications exist** — old answers would orphan |
| `type` | ✅ | One of the seven below |
| `label` | ✅ | The question, ≤200 chars |
| `help` | | Hint under the field, ≤200 chars |
| `required` | | Default `false` |

### Types

| `type` | Extra fields | Stored as | Server limit |
|---|---|---|---|
| `short_text` | `min_length`, `max_length` | string | 200 chars |
| `long_text` | `min_length`, `max_length` | string | 1000 chars |
| `select` | `options: []` **(required)** | string | Must be one of `options` |
| `multi_select` | `options: []` **(required)**, `max_select` | array | Every value must be in `options`; ≤10 selected |
| `boolean` | — | true/false | — |
| `url` | — | string | `https:` only, ≤500 chars, private/loopback hosts rejected |
| `number` | `min`, `max` | number | Integer, −1e9…1e9 |

### Rules the API enforces

- Answer keys not present in the spec are **rejected** — a bot cannot smuggle in extra fields
- `required` questions must be answered
- `custom_answers` total ≤ **4 KB** (DB constraint)
- All text is stripped of control characters, zero-width characters and bidi overrides
- Values starting with `= + - @` are prefixed with `'` on CSV export (Excel formula injection)

**File upload is deliberately not a question type.** A second upload path doubles the abuse
surface for little gain — use a `url` question for portfolios.

---

## 6. Daily operations

Runnable SQL for all of these is in [`db/job-template.sql`](db/job-template.sql).

### Post a new role
`db/job-template.sql` §1 → fill in → run. Set `is_open = true` and pick `max_applications`.

### Raise a cap on a full role
Table editor → `jobs` → edit `max_applications`. **Reopens instantly.** Check `blocked_attempts`
first — it tells you how many people were turned away.

### Close a role
Set `is_open = false`, or set `closes_at` to auto-close on a date. Independent of the cap.

### Turn AI on
1. `config.ai_scoring_enabled` → `true` (master)
2. `jobs.ai_enabled` → `true` on each role you want scored
3. Applications already received? `select backfill_ai_queue('the-slug');`

### Turn AI off
`config.ai_scoring_enabled` → `false`. Stops in-flight scoring within one cron cycle.
Applications continue completely unaffected.

### Switch AI provider
No code change, no deploy — nothing outside [api/careers/_lib/ai.js](api/careers/_lib/ai.js)
knows which vendor is in use. Edit `config`, then set the matching key in Vercel.

| Provider | `ai_provider` | `ai_base_url` | Example `ai_model` | Reads the PDF? |
|---|---|---|---|:---:|
| Anthropic | `anthropic` | *(blank)* | `claude-haiku-4-5` | ✅ |
| OpenAI | `openai` | *(blank)* | *(set explicitly)* | ❌ |
| Google Gemini | `google` | *(blank)* | *(set explicitly)* | ✅ |
| Groq | `openai_compatible` | `https://api.groq.com/openai` | *(set explicitly)* | ❌ |
| OpenRouter | `openai_compatible` | `https://openrouter.ai/api` | *(set explicitly)* | ❌ |
| Together | `openai_compatible` | `https://api.together.xyz` | *(set explicitly)* | ❌ |
| Ollama (local) | `openai_compatible` | `http://localhost:11434` | *(set explicitly)* | ❌ |

Then update `ai_price_in_per_mtok` / `ai_price_out_per_mtok` or your spend tracking and
`ai_monthly_budget_usd` will be wrong.

**Or set it from the environment.** Five keys accept an env override:
`AI_PROVIDER` `AI_MODEL` `AI_BASE_URL` `AI_PRICE_IN_PER_MTOK` `AI_PRICE_OUT_PER_MTOK`.

⚠️ **Turning scoring on/off is not one of them, on purpose.** Whether scoring runs is a
two-level database control — `config.ai_scoring_enabled` (master) plus `jobs.ai_enabled`
(per role). Keeping it out of the environment means one place to look and no deploy to flip
it. Setting `AI_API_KEY` does **not** enable scoring.

Precedence is **env var > config row > built-in default**, and a blank env value counts as
unset so it cannot silently wipe a real config value. Env values still go through the same
type coercion and ceilings as database values.

Only *which model to call* is overridable. Safety limits (`rate_limit_*`, `global_cap_*`,
`resume_max_bytes`, `turnstile_enabled`, `retention_days`) and the scoring on/off switch are
deliberately **not**, so no environment can loosen a limit or silently start spending.

⚠️ A Vercel env change needs a **redeploy** to take effect; a config row is picked up within
60s. Use env for local dev and preview deploys — point `.env.local` at a local Ollama while
production stays on Claude — and the config table for switching production.

⚠️ **Only Anthropic and Google read the resume PDF.** On the others the scorer automatically
falls back to the written answers and links, tells the model it has no resume, and records
`ai_verdict.scored_with.resume_read = false`. Nothing breaks — the scores are just less
informed. `config.ai_include_resume_pdf = false` forces text-only on any provider (~70% cheaper).

⚠️ `openai_compatible` gateways vary in structured-output support, so the scorer asks for
`json_object` and puts the schema in the prompt, then parses defensively (bare JSON, fenced
blocks, or JSON embedded in prose). Small local models may still return junk — those rows
retry up to `ai_max_attempts` and then land in `ai_status = 'failed'` with the reason.

### Review applications
Sort by `ai_score desc nulls last`, or just `created_at` if AI is off. Read
`why_boostowl` and `custom_answers` — that is where the real signal is.

### Download a resume
Storage → `resumes` → `<job_slug>/<application_id>.pdf`. Use a **signed URL** with a short
expiry if you need to share it. Never make the bucket public.

### Block a spammer
Add to `config.blocked_emails` or `config.blocked_ip_hashes` (the hash is in
`applications.ip_hash`). Live within 60 seconds.

### Change page copy, FAQ, or a dropdown option
Edit `config.careers_page`, `careers_faq`, `hiring_process`, or `form_options`. No deploy.

---

## 7. Cron jobs

⚠️ **Vercel's Hobby plan caps cron frequency at once per day.** A more frequent expression such
as `*/5 * * * *` does not get throttled — it **fails the deployment**. So `vercel.json`
registers exactly one schedule, and it runs the three workers in sequence.

| Endpoint | Scheduled | Does |
|---|---|---|
| [api/careers/cron/daily.js](api/careers/cron/daily.js) | `0 3 * * *` | Runs the three below in order, each isolated so one failure cannot stop the others |
| [api/careers/cron/maintenance.js](api/careers/cron/maintenance.js) | manual | **Supabase keepalive** · retention purge (+ resume objects) · expire stale AI queue · storage soft limit · budget alerts |
| [api/careers/cron/notify.js](api/careers/cron/notify.js) | manual | Retry `notify_status = 'pending'` alerts |
| [api/careers/cron/score.js](api/careers/cron/score.js) | manual | AI scoring batch |

Maintenance runs **first** — the keepalive must happen even if everything after it throws.
Scoring runs **last** and is skipped when the function is near its time budget; unreached rows
stay `pending` for the next run.

All four check `Authorization: Bearer ${CRON_SECRET}`, which Vercel Cron sends automatically.
Without it anyone can hit `/api/careers/cron/score` and drain your AI budget.

**The daily ping is what stops the Supabase free tier pausing after ~7 idle days.** A paused
project needs a *manual* restore from the dashboard, and applications fail until you notice.

**Want the workers to run more often?** Two free options:
- Upgrade to Vercel Pro, then give each worker its own schedule in `vercel.json`.
- Point an external scheduler (cron-job.org, GitHub Actions) at the individual endpoints with
  the `Authorization: Bearer $CRON_SECRET` header — useful if you want AI scores within
  minutes rather than overnight.

Trigger any of them by hand:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://www.boostowl.io/api/careers/cron/daily
```

---

## 8. Runbooks

### Supabase project paused
Free-tier projects pause after ~7 idle days and need a **manual** restore.
The daily maintenance cron calls `keepalive()` to prevent this.
If it happened: Dashboard → Restore, then check that the Vercel cron is actually firing
(Vercel → Deployments → Crons). No applications are lost — the form returns 503 while down.

### Storage full
Symptom: alert email, `resume_upload_enabled` auto-flipped to `false`. Applications are still
being accepted, link-only.
Fix: purge old resumes (`select purge_expired_applications(180);`), lower `retention_days`,
or upgrade to Supabase Pro. Then flip `resume_upload_enabled` back to `true`.

### AI budget exhausted
Symptom: alert email, rows stuck at `ai_status = 'pending'`. **Applications are unaffected.**
Fix: raise `ai_monthly_budget_usd` (ceiling 50), or set `ai_include_resume_pdf` to `false`
for ~70% cheaper scoring, or leave it off. Pending rows score when budget returns.

### Spam flood
1. `config.applications_open` → `false` — stops everything immediately
2. Find the pattern: `select ip_hash, count(*) from applications where created_at > now() - interval '1 hour' group by 1 order by 2 desc;`
3. Add offenders to `blocked_ip_hashes`
4. Tighten `rate_limit_ip_hour` and `global_cap_hour`
5. Confirm `turnstile_enabled` is `true` and `turnstile_fail_open` is `false`
6. Delete the junk rows, then reopen

### Turnstile / Cloudflare outage
Legitimate applications are being rejected. Set `turnstile_fail_open` → `true` to keep
accepting, monitor for junk, and **set it back to `false` the moment the outage ends**.

### Redis down
Nothing to do. Rate limiting automatically falls back to counting rows in Postgres.
Slower, same limits.

### An application came in but no email
`notify_status` will be `pending` or `failed`. The notify cron retries every 10 minutes.
Check the Resend dashboard for domain-verification problems. **The application itself is safe** —
notification failures never fail a submission.

### Duplicate error a candidate disputes
They already applied for that role. `select reference, created_at from applications where
job_slug = '<slug>' and email_normalized = '<email>';` Remember gmail dots and `+aliases`
are normalised away, so a "different" address may be the same person.

---

## 9. Security rules — do not break these

Whether you stay on the Supabase dashboard or build a portal, these are invariants.

1. **RLS on, zero policies, on every table.** The anon key must be able to do nothing.
   `select * from pg_policies where schemaname = 'public';` must return zero rows.
2. **The service_role key lives only in Vercel env vars.** Never in the browser, never in a
   repo, never in a client-side admin app. It bypasses RLS completely.
3. **The `resumes` bucket stays private.** Share via short-lived signed URLs only.
4. **Never trust `resume_original_filename` as a path.** Paths are `<job_slug>/<id>.pdf`.
5. **All validation is server-side.** Client-side validation is UX; the API re-validates
   everything and rejects unknown keys.
6. **Config can tighten, never loosen.** Code-level ceilings must stay in place.
7. **No raw IPs in the database.** Only `sha256(ip + IP_HASH_SALT)`.
8. **No PII in logs.** Log `hash(email)` and an outcome, never the payload.
9. **AI never auto-rejects.** Ranking only, always a human decision.
10. **Crons check `CRON_SECRET`.** Without it, anyone can drain your AI budget by hitting the endpoint.
11. **`scoring_rubric` never reaches the browser.** It states what you actually screen for.
12. **Bump `consent_version` when `consent_text` changes.** You must be able to prove what
    each candidate agreed to.
13. **Rotate a leaked secret immediately** — Supabase service key, `FORM_TOKEN_SECRET`,
    `CRON_SECRET`, Resend and Anthropic keys. Rotating `IP_HASH_SALT` invalidates existing
    `ip_hash` values, so blocklist entries must be re-derived.

---

## 10. Admin portal spec

Not built. Supabase's dashboard covers everything today. This is the brief for when it
stops being enough.

### When it is worth building

- You are editing `custom_questions` JSON by hand often enough to be annoyed
- Someone who should not have full database access needs to review candidates
- You want a kanban pipeline instead of editing `status` cells

### When it is not

A portal means **auth, sessions, and a login page exposed to the internet** — a new attack
surface protecting a table of applicant PII, for a tool you use a few times a month.
Supabase's dashboard is already authenticated, 2FA-capable, audit-logged, and maintained by
someone else. Not building one is a legitimate security decision.

### Non-negotiable constraints

1. **Server-side only.** The service key never reaches the browser. Every read and write goes
   through a Vercel function that holds the key. A client-side Supabase admin app is disqualified.
2. **Real authentication.** Supabase Auth with email allowlist + MFA, or Google Workspace SSO
   restricted to `@boostowl.io`. Never a shared password, never a URL secret.
3. **Server-side authorisation on every request.** Verify the session and role in the
   function, not in the UI. Hiding a button is not access control.
4. **Roles:** `viewer` (read applications, no PII export) · `recruiter` (read + change status +
   notes) · `admin` (jobs and config). Write actions land in `application_events`.
5. **Resumes via short-lived signed URLs** generated server-side. Never proxy the bucket.
6. **Re-validate everything.** A portal is just another untrusted client.
7. **`config` edits keep their code-level ceilings.** The portal must not be able to set
   `resume_max_bytes` to 100 MB.
8. **Rate-limit and audit the login endpoint.** Lockout after repeated failures.
9. **Never expose `scoring_rubric` to a `viewer`.**
10. **No bulk PII export without an audit log entry**, and ideally an admin-only action.

### Screens

| Screen | Contents |
|---|---|
| **Dashboard** | Applications today / this week · open roles with `application_count / max_applications` · roles at cap with `blocked_attempts` · AI queue depth and month-to-date spend · storage used · alerts |
| **Jobs list** | Table with inline `is_open`, `max_applications`, `ai_enabled`, `sort_order`. Live "Accepting / Full / Closed" badge |
| **Job editor** | All content fields with markdown preview · **visual `custom_questions` builder** (the main reason to build this) · capacity · AI toggle + rubric editor · "Save & backfill AI" |
| **Applications** | Filter by role / status / score band. Sort by score or date. Columns: reference, name, experience, notice period, score, status. Bulk status change |
| **Application detail** | Everything, resume viewer via signed URL, AI verdict rendered as strengths / concerns / red flags, status changer, notes, event timeline |
| **Config** | Grouped by section, typed inputs, **ceiling shown next to each limit**, confirmation on master switches |
| **Ops** | Trip the kill switch · manage blocklists · trigger backfill · view cron history · storage and budget usage |

### API surface it would need

```
GET    /api/admin/stats
GET    /api/admin/jobs               POST /api/admin/jobs
PATCH  /api/admin/jobs/:id           POST /api/admin/jobs/:id/backfill-ai
GET    /api/admin/applications       GET  /api/admin/applications/:id
PATCH  /api/admin/applications/:id       (status, notes)
GET    /api/admin/applications/:id/resume-url   → short-lived signed URL
GET    /api/admin/config             PATCH /api/admin/config/:key
POST   /api/admin/blocklist
```

Every one: verify session → check role → validate → act → write `application_events`.

### Build order

1. Read-only applications list + detail (highest value, lowest risk)
2. Status changes and notes
3. The `custom_questions` visual builder
4. Config editor with ceiling enforcement
5. Dashboard and ops screens

### Cheaper alternatives to consider first

- **Supabase saved SQL snippets** — the queries in `db/job-template.sql` §5, saved in the
  dashboard. Nearly all the review value, zero code, zero attack surface.
- **A read-only Postgres role + Metabase/Retool** — a reviewer dashboard without you writing
  auth. Still an external service holding PII, so weigh that.
- **A weekly digest email** — top-scored new applications pushed to you, so you rarely open a
  dashboard at all.
