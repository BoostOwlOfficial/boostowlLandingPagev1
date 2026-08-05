-- ============================================================================
-- BoostOwl Careers Portal — Schema
-- Run this FIRST in the Supabase SQL editor.
-- Docs: CAREERS-ADMIN.md
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- Rendered as dropdowns in the Supabase table editor.
-- To add a value later:  alter type <name> add value 'new_value';
-- ---------------------------------------------------------------------------
create type work_mode          as enum ('onsite', 'hybrid', 'remote');
create type employment_type    as enum ('full_time', 'part_time', 'intern', 'contract');
create type resume_mode        as enum ('required', 'optional', 'disabled');
create type resume_status      as enum ('none', 'ok', 'failed', 'skipped');
create type application_status as enum ('new', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn');
create type ai_status          as enum ('pending', 'scoring', 'scored', 'failed', 'skipped');
create type notify_status      as enum ('pending', 'sent', 'failed');


-- ---------------------------------------------------------------------------
-- config — the live control panel. Edit rows here, never redeploy.
-- Seeded by 03-seed-config.sql. Every key documented in CAREERS-ADMIN.md.
-- ---------------------------------------------------------------------------
create table config (
  key         text primary key,
  value       jsonb       not null,
  description text,
  updated_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- jobs — everything about a role. Nothing job-related lives in code.
-- ---------------------------------------------------------------------------
create table jobs (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  sort_order       int  not null default 0,

  -- Content -----------------------------------------------------------------
  title            text not null,
  department       text not null,                    -- must match a key in config.departments
  location         text not null,
  work_mode        work_mode       not null default 'onsite',
  employment_type  employment_type not null default 'full_time',
  experience_level text,                             -- free text, e.g. '1-3 years'
  salary_band      text,                             -- free text, e.g. '₹6-10 LPA'
  summary          text,                             -- one-liner on the role card
  description_md   text,                             -- "What you'll do"      (markdown)
  requirements_md  text,                             -- "What we're looking for" (markdown)
  nice_to_have_md  text,                             -- optional              (markdown)
  skills           text[] not null default '{}',     -- chips on card + AI matching signal

  -- Application form --------------------------------------------------------
  custom_questions jsonb       not null default '[]'::jsonb,  -- spec: CAREERS-ADMIN.md §5
  resume_mode      resume_mode not null default 'optional',

  -- Capacity ----------------------------------------------------------------
  is_open           boolean     not null default false,
  opens_at          timestamptz not null default now(),
  closes_at         timestamptz,                     -- null = no end date
  max_applications  int,                             -- null = unlimited
  application_count int not null default 0,          -- maintained atomically, do not edit
  blocked_attempts  int not null default 0,          -- hit a full/closed job; signal to raise cap

  -- AI (per-job switch; the master switch in config wins absolutely) --------
  ai_enabled        boolean not null default false,
  scoring_rubric    text,                            -- blank => auto-generated from title/desc/skills
  ai_min_score_flag int default 70,                  -- highlight at/above this score

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint jobs_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- Hard ceiling: a bad edit (or a compromised dashboard login) cannot exceed this.
  constraint jobs_max_apps_sane   check (max_applications is null
                                         or (max_applications > 0 and max_applications <= 5000)),
  constraint jobs_questions_limit check (jsonb_typeof(custom_questions) = 'array'
                                         and jsonb_array_length(custom_questions) <= 10),
  constraint jobs_dates           check (closes_at is null or closes_at > opens_at),
  constraint jobs_count_nonneg    check (application_count >= 0)
);

create index jobs_open_sort on jobs (is_open, sort_order);


-- ---------------------------------------------------------------------------
-- public_jobs — what api/jobs.js serves. Deliberately EXCLUDES scoring_rubric,
-- ai_enabled and blocked_attempts: a rubric states exactly what you screen for
-- and must never reach the browser.
-- ---------------------------------------------------------------------------
create or replace view public_jobs as
select
  j.id, j.slug, j.title, j.department, j.location, j.work_mode, j.employment_type,
  j.experience_level, j.salary_band, j.summary, j.description_md, j.requirements_md,
  j.nice_to_have_md, j.skills, j.custom_questions, j.resume_mode, j.sort_order,
  j.max_applications, j.application_count, j.closes_at,

  (j.is_open
   and now() >= j.opens_at
   and (j.closes_at is null or now() < j.closes_at))                    as is_live,

  (j.max_applications is not null
   and j.application_count >= j.max_applications)                       as is_full,

  (j.is_open
   and now() >= j.opens_at
   and (j.closes_at is null or now() < j.closes_at)
   and (j.max_applications is null
        or j.application_count < j.max_applications))                   as is_accepting
from jobs j;


-- ---------------------------------------------------------------------------
-- applications
-- ---------------------------------------------------------------------------
create table applications (
  id        uuid primary key default gen_random_uuid(),
  reference text not null unique,                     -- BO-XXXXXXXX shown to the candidate
  job_id    uuid not null references jobs(id) on delete restrict,
  job_slug  text not null,                            -- denormalized for reporting

  -- Candidate ---------------------------------------------------------------
  full_name         text not null,
  email             text not null,
  email_normalized  text not null,                    -- lowercased, +alias & gmail dots stripped
  phone_e164        text not null,
  location_city     text not null,
  experience_bucket text not null,                    -- value from config.form_options
  notice_period     text not null,                    -- value from config.form_options
  expected_ctc_band text,
  source            text,                             -- "how did you hear about us"
  linkedin_url      text,
  portfolio_url     text,
  github_url        text,
  why_boostowl      text not null,
  custom_answers    jsonb not null default '{}'::jsonb,

  -- Resume ------------------------------------------------------------------
  resume_path              text,                      -- '<job_slug>/<id>.pdf' in the private bucket
  resume_original_filename text,                      -- display only; NEVER used as a path
  resume_bytes             int,
  resume_sha256            text,                      -- repeated hash => resume farming
  resume_flags             jsonb not null default '[]'::jsonb,
  resume_status            resume_status not null default 'none',

  -- Consent (DPDP Act 2023) -------------------------------------------------
  consent_given   boolean not null,
  consent_version text    not null,

  -- Pipeline ----------------------------------------------------------------
  status         application_status not null default 'new',
  internal_notes text,

  -- AI ----------------------------------------------------------------------
  ai_status    ai_status not null default 'skipped',
  ai_score     int,
  ai_verdict   jsonb,
  ai_model     text,
  ai_cost_usd  numeric(10,6),
  ai_attempts  int not null default 0,
  ai_leased_at timestamptz,                           -- stale lease => reclaimed by the cron
  ai_scored_at timestamptz,
  ai_error     text,

  -- Notification ------------------------------------------------------------
  notify_status   notify_status not null default 'pending',
  notify_attempts int not null default 0,

  -- Request metadata (no raw PII) -------------------------------------------
  ip_hash    text,                                    -- sha256(ip + salt), never the raw IP
  ua_hash    text,
  utm_source text,
  created_at timestamptz not null default now(),

  constraint app_consent      check (consent_given = true),
  constraint app_score_range  check (ai_score is null or ai_score between 0 and 100),
  -- Hard ceiling on the dynamic answers blob, so a bot cannot smuggle in bulk data.
  constraint app_answers_size check (length(custom_answers::text) <= 4096)
);

-- Dedupe. THIS is the real guarantee — it holds under concurrency, where an
-- application-layer check does not.
create unique index applications_job_email_uniq on applications (job_id, email_normalized);
create unique index applications_job_phone_uniq on applications (job_id, phone_e164);

-- Worker queues
create index applications_ai_queue     on applications (ai_status, created_at)
  where ai_status in ('pending', 'scoring');
create index applications_notify_queue on applications (notify_status, created_at)
  where notify_status = 'pending';

-- Rate-limit fallback when Redis is unreachable
create index applications_email_recent on applications (email_normalized, created_at desc);
create index applications_phone_recent on applications (phone_e164, created_at desc);
create index applications_ip_recent    on applications (ip_hash, created_at desc);

-- Review / reporting
create index applications_job_created  on applications (job_id, created_at desc);
create index applications_job_score    on applications (job_id, ai_score desc nulls last);
create index applications_status       on applications (status, created_at desc);
create index applications_resume_hash  on applications (resume_sha256) where resume_sha256 is not null;


-- ---------------------------------------------------------------------------
-- application_events — append-only audit trail
-- ---------------------------------------------------------------------------
create table application_events (
  id             bigserial primary key,
  application_id uuid references applications(id) on delete cascade,
  event_type     text not null,                       -- created | status_changed | ai_scored | notified | ...
  meta           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index application_events_app on application_events (application_id, created_at desc);


-- ---------------------------------------------------------------------------
-- counters — global caps and AI spend. numeric so it holds USD as well as counts.
-- window_start is the truncated period, e.g. date_trunc('hour', now()).
-- ---------------------------------------------------------------------------
create table counters (
  key          text        not null,                  -- 'apps:hour' | 'apps:day' | 'ai:day' | 'ai:spend_usd:month'
  window_start timestamptz not null,
  count        numeric     not null default 0,
  primary key (key, window_start)
);

create index counters_window on counters (window_start);


-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger jobs_touch   before update on jobs   for each row execute function touch_updated_at();
create trigger config_touch before update on config for each row execute function touch_updated_at();


-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Enabled on every table with ZERO policies. The anon key can therefore do
-- nothing at all, even if it leaked. Only the service_role key — held only by
-- the Vercel function — has access, because service_role bypasses RLS.
--
-- Also disable the Data API entirely:
--   Supabase Dashboard → Settings → API → Data API → set exposed schemas to none
-- ---------------------------------------------------------------------------
alter table config             enable row level security;
alter table jobs               enable row level security;
alter table applications       enable row level security;
alter table application_events enable row level security;
alter table counters           enable row level security;

-- No CREATE POLICY statements. That is intentional. Do not add any.

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
