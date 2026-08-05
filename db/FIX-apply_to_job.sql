-- ============================================================================
-- HOTFIX: apply_to_job() referenced gen_random_bytes(), which lives in
-- pgcrypto. Supabase installs pgcrypto into the `extensions` schema, but this
-- function pins `search_path = public`, so the call failed at RUNTIME with
--   42883  function gen_random_bytes(integer) does not exist
-- CREATE FUNCTION succeeded, so this only showed up on a real application:
-- every submission returned 503 and nothing was written.
--
-- Fix: gen_random_uuid() is core Postgres 13+, needs no extension, and gives
-- the same 8 hex chars / 32 bits of entropy.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create or replace function apply_to_job(p_job_slug text, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_job        jobs;
  v_id         uuid;
  v_ref        text;
  v_constraint text;
begin
  select * into v_job from jobs where slug = p_job_slug for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'JOB_NOT_FOUND');
  end if;

  if not v_job.is_open
     or now() < v_job.opens_at
     or (v_job.closes_at is not null and now() >= v_job.closes_at) then
    update jobs set blocked_attempts = blocked_attempts + 1 where id = v_job.id;
    return jsonb_build_object('ok', false, 'error', 'JOB_CLOSED');
  end if;

  if v_job.max_applications is not null
     and v_job.application_count >= v_job.max_applications then
    update jobs set blocked_attempts = blocked_attempts + 1 where id = v_job.id;
    return jsonb_build_object('ok', false, 'error', 'JOB_FULL');
  end if;

  -- gen_random_uuid() is CORE Postgres (13+). Do NOT use gen_random_bytes()
  -- here: that lives in pgcrypto, which Supabase installs into the
  -- `extensions` schema, and this function pins `search_path = public` — so
  -- the call fails at RUNTIME with 42883 while CREATE FUNCTION succeeds.
  -- Same shape and entropy as gen_random_bytes(4): 8 hex chars, 32 bits.
  v_ref := 'BO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into applications (
    reference, job_id, job_slug,
    full_name, email, email_normalized, phone_e164, location_city,
    experience_bucket, notice_period, expected_ctc_band, source,
    linkedin_url, portfolio_url, github_url, why_boostowl, custom_answers,
    consent_given, consent_version,
    ai_status,
    ip_hash, ua_hash, utm_source
  ) values (
    v_ref, v_job.id, v_job.slug,
    p_data ->> 'full_name',
    p_data ->> 'email',
    p_data ->> 'email_normalized',
    p_data ->> 'phone_e164',
    p_data ->> 'location_city',
    p_data ->> 'experience_bucket',
    p_data ->> 'notice_period',
    p_data ->> 'expected_ctc_band',
    p_data ->> 'source',
    p_data ->> 'linkedin_url',
    p_data ->> 'portfolio_url',
    p_data ->> 'github_url',
    p_data ->> 'why_boostowl',
    coalesce(p_data -> 'custom_answers', '{}'::jsonb),
    true,
    p_data ->> 'consent_version',
    -- Master switch AND per-job switch must both be on, or it is never queued.
    case
      when coalesce((p_data ->> 'ai_master')::boolean, false) and v_job.ai_enabled
      then 'pending'::ai_status
      else 'skipped'::ai_status
    end,
    p_data ->> 'ip_hash',
    p_data ->> 'ua_hash',
    p_data ->> 'utm_source'
  )
  returning id into v_id;

  update jobs set application_count = application_count + 1 where id = v_job.id;

  insert into application_events (application_id, event_type, meta)
  values (v_id, 'created', jsonb_build_object('job_slug', v_job.slug));

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'reference', v_ref, 'resume_mode', v_job.resume_mode
  );

exception
  when unique_violation then
    -- NB: the diagnostics item is CONSTRAINT_NAME. Only DATATYPE_NAME and the
    -- EXCEPTION_* items carry a PG_ prefix; PG_CONSTRAINT_NAME does not exist
    -- and makes the whole CREATE FUNCTION fail.
    get stacked diagnostics v_constraint = constraint_name;

    -- Reference collision (1 in 4 billion) — the caller simply retries.
    if v_constraint = 'applications_reference_key' then
      return jsonb_build_object('ok', false, 'error', 'RETRY');
    end if;

    return jsonb_build_object(
      'ok', false,
      'error', 'DUPLICATE',
      'field', case v_constraint
                 when 'applications_job_email_uniq' then 'email'
                 when 'applications_job_phone_uniq' then 'phone'
                 else 'unknown'
               end
    );
end $$;
