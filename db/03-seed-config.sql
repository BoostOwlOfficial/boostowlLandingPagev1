-- ============================================================================
-- BoostOwl Careers Portal — Config seed
-- Run AFTER 02-functions.sql.
--
-- Safe to re-run: existing rows are left untouched (ON CONFLICT DO NOTHING).
-- To reset one key to its default, delete the row first, then re-run this file.
--
-- Every key is documented in CAREERS-ADMIN.md §3.
-- Values marked [CEILING] are additionally clamped in code — config can make
-- them stricter, never looser.
-- ============================================================================

insert into config (key, value, description) values

-- ── Master switches ────────────────────────────────────────────────────────
('applications_open',        'true'::jsonb,
 'Global kill switch. false => every role shows maintenance_message and /api/apply returns 503.'),

('maintenance_message',      '"We are not accepting applications right now. Please check back soon."'::jsonb,
 'Shown on the careers page when applications_open is false.'),

-- ── Resume ─────────────────────────────────────────────────────────────────
('resume_upload_enabled',    'true'::jsonb,
 'false => the upload field disappears and the form falls back to links only. Flipped automatically when storage hits its soft limit.'),

('resume_max_bytes',         '2097152'::jsonb,
 '2 MB. [CEILING 4194304] Base64 inflates by ~1.37x and Vercel caps request bodies at 4.5 MB.'),

-- ── Anti-bot ───────────────────────────────────────────────────────────────
('turnstile_enabled',        'true'::jsonb,
 'Cloudflare Turnstile verification. Setting false logs a loud warning on every request.'),

('turnstile_fail_open',      'false'::jsonb,
 'Manual override for a Cloudflare outage. true => accept applications when the verify API is unreachable. Set back to false as soon as the outage ends.'),

('min_form_dwell_seconds',   '5'::jsonb,
 'Reject submissions faster than this after page load. [FLOOR 2] Enforced via a server-signed token, so the timestamp cannot be forged.'),

-- ── Rate limits (per applicant) ────────────────────────────────────────────
('rate_limit_ip_hour',       '3'::jsonb,   'Applications per IP per hour.  [CEILING 20]'),
('rate_limit_ip_day',        '10'::jsonb,  'Applications per IP per day.   [CEILING 50]'),
('rate_limit_ip_week',       '20'::jsonb,  'Applications per IP per week.  [CEILING 100]'),
('rate_limit_email_30d',     '3'::jsonb,   'Applications per email across ALL roles in 30 days. One-per-role is separately enforced by a unique index.'),
('rate_limit_phone_30d',     '3'::jsonb,   'Applications per phone across ALL roles in 30 days.'),

-- ── Global circuit breaker ─────────────────────────────────────────────────
('global_cap_hour',          '60'::jsonb,  'Total applications per hour across all roles. [CEILING 500]'),
('global_cap_day',           '300'::jsonb, 'Total applications per day across all roles.  [CEILING 2000]'),

-- ── Storage ────────────────────────────────────────────────────────────────
('storage_soft_limit_bytes', '800000000'::jsonb,
 '800 MB of the Supabase free tier 1 GB. At this point uploads stop, applications continue link-only, and you get an alert.'),

-- ── AI scoring ─────────────────────────────────────────────────────────────
('ai_scoring_enabled',       'false'::jsonb,
 'MASTER SWITCH. false => nothing is scored, ever, regardless of any job ai_enabled flag. Flip to true when you are ready to spend.'),

('ai_default_for_new_jobs',  'false'::jsonb,
 'Default value of jobs.ai_enabled for newly created roles.'),

('ai_provider',              '"anthropic"'::jsonb,
 'Which model vendor to score with: anthropic | openai | google | openai_compatible. Nothing outside api/careers/_lib/ai.js knows the difference, so switching is a row edit.'),

('ai_model',                 '"claude-haiku-4-5"'::jsonb,
 'Model id for the chosen provider. e.g. claude-haiku-4-5 (anthropic), gpt-5-mini (openai), gemini-2.5-flash (google), llama-3.3-70b-versatile (groq). Must be set for every provider except anthropic.'),

('ai_base_url',              '""'::jsonb,
 'Override the API base URL. Empty = provider default. REQUIRED for openai_compatible: Groq https://api.groq.com/openai, OpenRouter https://openrouter.ai/api, Together https://api.together.xyz, Ollama http://localhost:11434.'),

('ai_price_in_per_mtok',     '1.0'::jsonb,
 'USD per million INPUT tokens, for cost tracking. Update when you change provider or model. Default is Claude Haiku 4.5.'),

('ai_price_out_per_mtok',    '5.0'::jsonb,
 'USD per million OUTPUT tokens, for cost tracking. Update when you change provider or model. Default is Claude Haiku 4.5.'),

('ai_daily_cap',             '100'::jsonb,
 'Maximum resumes scored per day. [CEILING 500]'),

('ai_monthly_budget_usd',    '10'::jsonb,
 'Hard monthly spend limit. When reached scoring pauses; applications are unaffected. [CEILING 50]'),

('ai_include_resume_pdf',    'true'::jsonb,
 'false => score from the form answers only. Roughly 70% cheaper (~$0.002 vs ~$0.008 per application).'),

('ai_batch_size',            '10'::jsonb,
 'Rows claimed per cron run. The cron fires every 5 minutes.'),

('ai_max_attempts',          '3'::jsonb,
 'Retries before a row is marked failed.'),

('ai_queue_expiry_days',     '30'::jsonb,
 'A row waiting longer than this is marked skipped, so the queue cannot grow without bound while AI is off.'),

-- ── Notifications ──────────────────────────────────────────────────────────
('notify_email_enabled',     'true'::jsonb,  'Email you when an application arrives.'),
('notify_email_to',          '"admin@boostowl.io"'::jsonb, 'Recipient for new-application alerts.'),
('notify_email_from',        '"careers@boostowl.io"'::jsonb, 'Verified Resend sender.'),
('notify_ack_candidate',     'false'::jsonb, 'Also send the applicant a confirmation email.'),
('alert_email_to',           '"admin@boostowl.io"'::jsonb, 'Operational alerts: caps tripped, storage full, budget exhausted.'),

-- ── Compliance (DPDP Act 2023) ─────────────────────────────────────────────
('retention_days',           '365'::jsonb,
 'Applications older than this are purged nightly, along with their resumes. Candidates with status hired or offer are exempt.'),

('consent_version',          '"2026-08-v1"'::jsonb,
 'Bump whenever consent_text changes. Stored per application so you know exactly what each candidate agreed to.'),

('consent_text',
 '"I consent to BoostOwl Pvt. Ltd. storing and processing the information and documents I have submitted for the purpose of evaluating my application for employment. I understand my data will be retained for up to 12 months and that I may request its deletion at any time."'::jsonb,
 'Shown next to the consent checkbox. Changing this requires bumping consent_version.'),

-- ── Blocklists ─────────────────────────────────────────────────────────────
('blocked_email_domains',
 '["mailinator.com","guerrillamail.com","10minutemail.com","tempmail.com","temp-mail.org","throwawaymail.com","yopmail.com","trashmail.com","sharklasers.com","getnada.com","dispostable.com","maildrop.cc","fakeinbox.com","mintemail.com","spam4.me"]'::jsonb,
 'Disposable-mail domains rejected at submission. Add more as you see them.'),

('blocked_emails',    '[]'::jsonb,     'Manual moderation. Exact normalized addresses to reject.'),
('blocked_ip_hashes', '[]'::jsonb,     'Manual moderation. sha256(ip + IP_HASH_SALT) values to reject.'),

-- ── Form field options ─────────────────────────────────────────────────────
-- Adding a new CTC band or notice period is a row edit here, not a deploy.
('form_options',
 '{
   "experience_bucket": [
     {"value":"fresher","label":"Fresher / student"},
     {"value":"0-1","label":"0-1 years"},
     {"value":"1-3","label":"1-3 years"},
     {"value":"3-5","label":"3-5 years"},
     {"value":"5-8","label":"5-8 years"},
     {"value":"8+","label":"8+ years"}
   ],
   "notice_period": [
     {"value":"immediate","label":"Immediately"},
     {"value":"15d","label":"Within 15 days"},
     {"value":"30d","label":"30 days"},
     {"value":"60d","label":"60 days"},
     {"value":"90d","label":"90 days or more"}
   ],
   "expected_ctc_band": [
     {"value":"na","label":"Prefer not to say"},
     {"value":"lt3","label":"Under ₹3 LPA"},
     {"value":"3-6","label":"₹3-6 LPA"},
     {"value":"6-10","label":"₹6-10 LPA"},
     {"value":"10-15","label":"₹10-15 LPA"},
     {"value":"15-25","label":"₹15-25 LPA"},
     {"value":"25+","label":"₹25+ LPA"},
     {"value":"stipend","label":"Internship stipend"}
   ],
   "source": [
     {"value":"linkedin","label":"LinkedIn"},
     {"value":"instagram","label":"Instagram"},
     {"value":"twitter","label":"X / Twitter"},
     {"value":"referral","label":"Referred by someone"},
     {"value":"website","label":"BoostOwl website"},
     {"value":"jobboard","label":"A job board"},
     {"value":"other","label":"Somewhere else"}
   ]
 }'::jsonb,
 'Dropdown options for the standard form fields. The apply endpoint validates submitted values against this list.'),

-- ── Departments (filter chips) ─────────────────────────────────────────────
('departments',
 '[
   {"value":"engineering","label":"Engineering","order":1},
   {"value":"design","label":"Design","order":2},
   {"value":"sales","label":"Sales & Growth","order":3},
   {"value":"operations","label":"Operations","order":4},
   {"value":"internship","label":"Internships","order":5}
 ]'::jsonb,
 'Must contain every value used in jobs.department.'),

-- ── Careers page content ───────────────────────────────────────────────────
('hero_stats',
 '[{"value":"2-3","label":"weeks to offer"}]'::jsonb,
 'Up to two extra stat tiles beside the careers hero. The open-role count is prepended automatically from live data, so these are the ones you control. '
 'EVERY VALUE HERE IS A PUBLIC CLAIM AND NOTHING VERIFIES IT — the tile renders whatever string you put in. Only add a stat you would stand behind in an interview. '
 '"2-3 weeks to offer" is kept because it matches the Offer stage in hiring_process; a headcount tile was deliberately removed rather than published unverified.'),

('careers_page',
 '{
   "hero_eyebrow": "Careers at BoostOwl",
   "hero_title": "Build the operating system for 60 million Indian SMBs",
   "hero_subtitle": "We are a small, DPIIT-recognised team turning WhatsApp into the place small businesses actually run on. Real users, real revenue, and a lot still to build.",
   "why_cards": [
     {"title":"Early team, real ownership","body":"You will own a surface end to end, not a ticket queue. Decisions get made in a conversation, not a committee."},
     {"title":"Shipping to real businesses","body":"Paying SMBs use what we build, this week. Feedback arrives in hours, not quarters."},
     {"title":"DPIIT-recognised startup","body":"CIN U58200UP2025PTC234603, DIPP232087. Registered, funded operations and a serious roadmap."},
     {"title":"Honest about the stage","body":"We are early. That means scope and impact most places cannot offer, and the ambiguity that comes with it."}
   ],
   "principles": [
     "Ship weekly. A working thing beats a perfect plan.",
     "Talk to users directly - everyone, not just the founders.",
     "Write it down. Decisions live in docs, not in someone head.",
     "Own the outcome, not the task."
   ],
   "open_application_note": "Do not see a role that fits? Send an open application and tell us what you would want to own."
 }'::jsonb,
 'All careers page copy. Editable without a deploy.'),

('hiring_process',
 '[
   {"step":1,"title":"You apply","detail":"The form below. Takes about 10 minutes if you write a real answer.","timing":"Day 0"},
   {"step":2,"title":"We read it","detail":"A human reads every application. You hear back either way.","timing":"Within 5 working days"},
   {"step":3,"title":"Intro call","detail":"30 minutes with a founder. Your background, our stage, mutual fit.","timing":"Week 1"},
   {"step":4,"title":"Practical task","detail":"A short, paid, realistic task. No unpaid take-homes and no algorithm puzzles.","timing":"Week 2"},
   {"step":5,"title":"Offer","detail":"Comp, scope and start date. We move fast once we are sure.","timing":"Week 2-3"}
 ]'::jsonb,
 'The hiring process timeline shown on the careers page.'),

('careers_faq',
 '[
   {"q":"Is this remote?","a":"It depends on the role - each listing states its location and work mode. Engineering roles are hybrid or remote; operations roles are usually onsite in Hapur, UP."},
   {"q":"Do you hire freshers?","a":"Yes. Several roles are explicitly open to freshers and interns. We care much more about what you have built than where you studied."},
   {"q":"How is compensation decided?","a":"By role, scope and experience - not by what you earned before. We do not ask for your current CTC."},
   {"q":"Do interns convert to full time?","a":"That is the intent for most internships, and we will tell you up front if a particular one is fixed-term."},
   {"q":"How long does the process take?","a":"Two to three weeks from application to offer. If it will take longer, we tell you why."},
   {"q":"What happens to my data?","a":"It is used only to evaluate your application, kept for up to 12 months, and deleted on request. See our privacy policy."}
 ]'::jsonb,
 'FAQ items on the careers page.')

on conflict (key) do nothing;
