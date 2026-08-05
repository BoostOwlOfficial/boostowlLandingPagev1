-- ============================================================================
-- BoostOwl Careers Portal — Functions
-- Run AFTER 01-schema.sql.
--
-- All functions are SECURITY DEFINER (they must bypass RLS) and are therefore
-- explicitly REVOKEd from anon/authenticated at the bottom of this file.
-- Only service_role may execute them. Do not grant them more widely.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- get_config() — the whole control panel in one round trip.
-- The Vercel function caches the result for 60s at module scope.
-- ---------------------------------------------------------------------------
create or replace function get_config()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from config;
$$;


-- ---------------------------------------------------------------------------
-- apply_to_job() — the single atomic write.
--
-- SELECT ... FOR UPDATE serialises concurrent applicants to the same role, so
-- max_applications is exact: the 201st simultaneous applicant gets JOB_FULL,
-- never a 201st row. The unique indexes catch duplicate email/phone in the same
-- transaction, so cap + dedupe are decided together or not at all.
--
-- Returns: {ok:true, id, reference, resume_mode}
--       or {ok:false, error:'JOB_NOT_FOUND'|'JOB_CLOSED'|'JOB_FULL'|'DUPLICATE'|'RETRY', field?}
-- ---------------------------------------------------------------------------
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

  v_ref := 'BO-' || upper(encode(gen_random_bytes(4), 'hex'));

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


-- ---------------------------------------------------------------------------
-- attach_resume() — called after the PDF lands in storage.
-- If this never runs, the application still exists with resume_status='failed'.
-- A candidate is never lost to a storage blip.
-- ---------------------------------------------------------------------------
create or replace function attach_resume(
  p_id       uuid,
  p_path     text,
  p_filename text,
  p_bytes    int,
  p_sha256   text,
  p_flags    jsonb default '[]'::jsonb
)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update applications
     set resume_path = p_path,
         resume_original_filename = p_filename,
         resume_bytes = p_bytes,
         resume_sha256 = p_sha256,
         resume_flags = coalesce(p_flags, '[]'::jsonb),
         resume_status = 'ok'
   where id = p_id;

  insert into application_events (application_id, event_type, meta)
  values (p_id, 'resume_attached', jsonb_build_object('bytes', p_bytes, 'flags', p_flags));

  return found;
end $$;


-- ---------------------------------------------------------------------------
-- bump_counter() — atomic increment, returns the new value.
-- ---------------------------------------------------------------------------
create or replace function bump_counter(p_key text, p_window timestamptz, p_delta numeric default 1)
returns numeric
language plpgsql security definer set search_path = public as $$
declare v_new numeric;
begin
  insert into counters (key, window_start, count)
  values (p_key, p_window, p_delta)
  on conflict (key, window_start) do update set count = counters.count + p_delta
  returning count into v_new;
  return v_new;
end $$;


-- ---------------------------------------------------------------------------
-- reserve_global_slot() — the circuit breaker against a distributed flood.
-- Atomically checks the hour and day caps, then reserves a slot. If either cap
-- is exceeded nothing is reserved and the caller returns 503.
-- ---------------------------------------------------------------------------
create or replace function reserve_global_slot(p_cap_hour int, p_cap_day int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hour timestamptz := date_trunc('hour', now());
  v_day  timestamptz := date_trunc('day',  now());
  v_h    numeric;
  v_d    numeric;
begin
  select coalesce(count, 0) into v_h from counters where key = 'apps:hour' and window_start = v_hour;
  select coalesce(count, 0) into v_d from counters where key = 'apps:day'  and window_start = v_day;

  if coalesce(v_h, 0) >= p_cap_hour then
    return jsonb_build_object('ok', false, 'reason', 'HOURLY_CAP', 'count', coalesce(v_h, 0));
  end if;
  if coalesce(v_d, 0) >= p_cap_day then
    return jsonb_build_object('ok', false, 'reason', 'DAILY_CAP', 'count', coalesce(v_d, 0));
  end if;

  perform bump_counter('apps:hour', v_hour, 1);
  perform bump_counter('apps:day',  v_day,  1);

  return jsonb_build_object('ok', true,
                            'hour', coalesce(v_h, 0) + 1,
                            'day',  coalesce(v_d, 0) + 1);
end $$;


-- ---------------------------------------------------------------------------
-- count_recent() — rate-limit fallback used only when Upstash Redis is
-- unreachable. Rate limiting must never silently switch off.
--   p_field: 'email' | 'phone' | 'ip'
-- ---------------------------------------------------------------------------
create or replace function count_recent(p_field text, p_value text, p_since timestamptz)
returns int
language plpgsql stable security definer set search_path = public as $$
declare v_n int;
begin
  if p_field = 'email' then
    select count(*) into v_n from applications
     where email_normalized = p_value and created_at >= p_since;
  elsif p_field = 'phone' then
    select count(*) into v_n from applications
     where phone_e164 = p_value and created_at >= p_since;
  elsif p_field = 'ip' then
    select count(*) into v_n from applications
     where ip_hash = p_value and created_at >= p_since;
  else
    raise exception 'count_recent: unknown field %', p_field;
  end if;
  return coalesce(v_n, 0);
end $$;


-- ---------------------------------------------------------------------------
-- claim_ai_batch() — leases rows for the scoring cron.
--
-- FOR UPDATE SKIP LOCKED means two overlapping cron runs never score the same
-- row. A row whose lease has expired (worker died mid-flight) is reclaimed.
-- The join to jobs re-checks ai_enabled, so turning a job's AI off stops its
-- pending rows immediately.
-- ---------------------------------------------------------------------------
create or replace function claim_ai_batch(p_limit int default 10, p_lease_minutes int default 10)
returns setof applications
language plpgsql security definer set search_path = public as $$
begin
  return query
  update applications a
     set ai_status = 'scoring', ai_leased_at = now()
   where a.id in (
     select x.id
       from applications x
       join jobs j on j.id = x.job_id
      where j.ai_enabled = true
        and (x.ai_status = 'pending'
             or (x.ai_status = 'scoring'
                 and x.ai_leased_at < now() - make_interval(mins => p_lease_minutes)))
        and x.ai_attempts < 3
      order by x.created_at
      limit p_limit
      for update skip locked
   )
  returning a.*;
end $$;


-- ---------------------------------------------------------------------------
-- backfill_ai_queue() — call after switching a job's ai_enabled on, to score
-- applications that already arrived. Pass null to backfill every enabled job.
-- ---------------------------------------------------------------------------
create or replace function backfill_ai_queue(p_job_slug text default null)
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update applications a
     set ai_status = 'pending', ai_attempts = 0, ai_error = null
    from jobs j
   where j.id = a.job_id
     and j.ai_enabled = true
     and a.ai_status = 'skipped'
     and (p_job_slug is null or j.slug = p_job_slug);
  get diagnostics v_n = row_count;
  return v_n;
end $$;


-- ---------------------------------------------------------------------------
-- expire_stale_ai_queue() — a row that has waited longer than p_days is marked
-- 'skipped' so the queue cannot grow without bound while AI is switched off.
-- ---------------------------------------------------------------------------
create or replace function expire_stale_ai_queue(p_days int default 30)
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update applications
     set ai_status = 'skipped'
   where ai_status in ('pending', 'scoring')
     and created_at < now() - make_interval(days => p_days);
  get diagnostics v_n = row_count;
  return v_n;
end $$;


-- ---------------------------------------------------------------------------
-- purge_expired_applications() — DPDP retention. Returns the storage paths so
-- the maintenance cron can delete the PDFs too. Call inside a transaction and
-- delete from storage BEFORE committing if you want strict cleanup.
-- ---------------------------------------------------------------------------
create or replace function purge_expired_applications(p_days int)
returns table (deleted_id uuid, resume_path text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  delete from applications a
   where a.created_at < now() - make_interval(days => p_days)
     and a.status not in ('hired', 'offer')       -- keep active/successful candidates
  returning a.id, a.resume_path;
end $$;


-- ---------------------------------------------------------------------------
-- storage_used_bytes() — drives the storage soft limit.
-- ---------------------------------------------------------------------------
create or replace function storage_used_bytes()
returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(resume_bytes), 0)::bigint from applications where resume_status = 'ok';
$$;


-- ---------------------------------------------------------------------------
-- keepalive() — pinged daily by the maintenance cron so the Supabase free tier
-- never pauses after 7 idle days.
-- ---------------------------------------------------------------------------
create or replace function keepalive()
returns timestamptz
language sql security definer set search_path = public as $$
  select now();
$$;


-- ---------------------------------------------------------------------------
-- Lock down. A SECURITY DEFINER function callable by anon would be a hole.
-- ---------------------------------------------------------------------------
revoke all on function get_config()                                  from public, anon, authenticated;
revoke all on function apply_to_job(text, jsonb)                     from public, anon, authenticated;
revoke all on function attach_resume(uuid, text, text, int, text, jsonb) from public, anon, authenticated;
revoke all on function bump_counter(text, timestamptz, numeric)      from public, anon, authenticated;
revoke all on function reserve_global_slot(int, int)                 from public, anon, authenticated;
revoke all on function count_recent(text, text, timestamptz)         from public, anon, authenticated;
revoke all on function claim_ai_batch(int, int)                      from public, anon, authenticated;
revoke all on function backfill_ai_queue(text)                       from public, anon, authenticated;
revoke all on function expire_stale_ai_queue(int)                    from public, anon, authenticated;
revoke all on function purge_expired_applications(int)               from public, anon, authenticated;
revoke all on function storage_used_bytes()                          from public, anon, authenticated;
revoke all on function keepalive()                                   from public, anon, authenticated;
