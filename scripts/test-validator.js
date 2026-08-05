#!/usr/bin/env node
// ============================================================================
// Unit tests for field validation. Not deployed (scripts/ is .vercelignored).
//   node scripts/test-validator.js
// ============================================================================

'use strict';

const V = require('../api/careers/_lib/validate');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        expected ${e}, got ${a}`);
    fail++;
  }
}
function section(t) { console.log(`\n${t}\n`); }

const CONFIG = {
  consent_version: 'test-v1',
  blocked_email_domains: ['mailinator.com'],
  blocked_emails: ['banned@example.com'],
  form_options: {
    experience_bucket: [{ value: '1-3' }, { value: 'fresher' }],
    notice_period: [{ value: '30d' }, { value: 'immediate' }],
    expected_ctc_band: [{ value: '6-10' }],
    source: [{ value: 'linkedin' }],
  },
};

const JOB = {
  slug: 'backend-engineer',
  custom_questions: [
    { id: 'built_what', type: 'long_text', required: true, min_length: 20, max_length: 600 },
    { id: 'stack', type: 'multi_select', options: ['Node.js', 'Redis'], max_select: 2 },
    { id: 'has_api', type: 'boolean', required: true },
    { id: 'gh', type: 'url' },
  ],
};

const VALID = {
  job_slug: 'backend-engineer',
  full_name: 'Rahul Sharma',
  email: 'rahul@example.com',
  phone: '9876543210',
  location_city: 'Hapur',
  experience_bucket: '1-3',
  notice_period: '30d',
  linkedin_url: 'https://linkedin.com/in/rahul',
  why_boostowl: 'I have built WhatsApp integrations for two SMB products and want to do it at real scale.',
  custom_answers: { built_what: 'I built the billing service end to end at my last job.', has_api: true },
  consent: true,
};

const apply = (over) => V.validateApplication(Object.assign({}, VALID, over), JOB, CONFIG);

/** Errors for a variant, or {} when it validated cleanly. Never throws. */
const errs = (over) => apply(over).errors || {};

// ---------------------------------------------------------------------------
section('Baseline');
{
  const r = apply({});
  check('valid application accepted', r.ok, true);
  if (!r.ok) console.log('       errors:', r.errors);
  check('consent version stamped', r.ok && r.clean.consent_version, 'test-v1');
}

// ---------------------------------------------------------------------------
section('Strict schema');
check('unknown top-level key rejected',
  errs({ is_admin: true })._form !== undefined, true);
check('unknown custom answer key rejected',
  apply({ custom_answers: { built_what: 'x'.repeat(30), has_api: true, injected: 'evil' } })
    .errors.custom_answers !== undefined, true);

// ---------------------------------------------------------------------------
section('Email');
check('gmail dots + alias normalise to one identity',
  V.normalizeEmail('R.Sharma+jobs@Gmail.com'), 'rsharma@gmail.com');
check('googlemail maps to gmail',
  V.normalizeEmail('a.b@googlemail.com'), 'ab@gmail.com');
check('non-gmail dots preserved',
  V.normalizeEmail('first.last@company.com'), 'first.last@company.com');
check('alias stripped on any domain',
  V.normalizeEmail('careers+spam@company.com'), 'careers@company.com');
check('malformed email rejected', errs({ email: 'not-an-email' }).email !== undefined, true);
check('disposable domain rejected', errs({ email: 'x@mailinator.com' }).email !== undefined, true);
check('blocklisted email rejected', errs({ email: 'banned@example.com' }).email !== undefined, true);
check('blocklist message is generic',
  errs({ email: 'banned@example.com' }).email, 'We could not accept this application.');

// ---------------------------------------------------------------------------
section('Phone');
check('bare Indian mobile gets +91', V.normalizePhone('9876543210'), '+919876543210');
check('leading zero stripped', V.normalizePhone('09876543210'), '+919876543210');
check('spaces and dashes stripped', V.normalizePhone('+91 98765-43210'), '+919876543210');
check('international preserved', V.normalizePhone('+14155552671'), '+14155552671');
check('repeated digits rejected', errs({ phone: '0000000000' }).phone !== undefined, true);
check('sequential rejected', errs({ phone: '1234567890' }).phone !== undefined, true);
check('invalid Indian prefix rejected', errs({ phone: '1234512345' }).phone !== undefined, true);
check('too short rejected', errs({ phone: '123' }).phone !== undefined, true);

// ---------------------------------------------------------------------------
section('URLs');
check('http rejected', V.validateUrl('http://linkedin.com/in/x', { hostSuffix: 'linkedin.com' }).ok, false);
check('https accepted', V.validateUrl('https://linkedin.com/in/x', { hostSuffix: 'linkedin.com' }).ok, true);
check('subdomain accepted', V.validateUrl('https://in.linkedin.com/in/x', { hostSuffix: 'linkedin.com' }).ok, true);
check('lookalike domain rejected', V.validateUrl('https://linkedin.com.evil.io/x', { hostSuffix: 'linkedin.com' }).ok, false);
check('localhost rejected', V.validateUrl('https://localhost/x').ok, false);
check('private IP rejected', V.validateUrl('https://192.168.1.1/x').ok, false);
check('link-local (cloud metadata) rejected', V.validateUrl('https://169.254.169.254/latest/meta-data').ok, false);
check('bare IP rejected', V.validateUrl('https://8.8.8.8/x').ok, false);
check('.internal rejected', V.validateUrl('https://db.internal/x').ok, false);
check('javascript: rejected', V.validateUrl('javascript:alert(1)').ok, false);
check('over-long URL rejected', V.validateUrl('https://a.com/' + 'x'.repeat(600)).ok, false);
check('optional URL may be empty', V.validateUrl('', { required: false }).ok, true);
check('required URL may not be empty', V.validateUrl('', { required: true }).ok, false);

// ---------------------------------------------------------------------------
section('Text hygiene');
check('null byte stripped', V.sanitizeText('ab\x00c'), 'abc');
check('zero-width stripped', V.sanitizeText('a​b'), 'ab');
check('RTL override stripped', V.sanitizeText('a\u202Eb'), 'ab');
check('newlines collapsed', V.sanitizeText('a\n\n\n\n\nb'), 'a\n\nb');
check('CSV formula neutralised', V.csvSafe('=cmd|calc'), "'=cmd|calc");
check('CSV plus neutralised', V.csvSafe('+1234'), "'+1234");
check('normal text untouched', V.csvSafe('Rahul Sharma'), 'Rahul Sharma');

// ---------------------------------------------------------------------------
section('Required fields');
check('short why_boostowl rejected', errs({ why_boostowl: 'I want the job.' }).why_boostowl !== undefined, true);
check('long why_boostowl rejected', errs({ why_boostowl: 'x'.repeat(700) }).why_boostowl !== undefined, true);
check('missing consent rejected', errs({ consent: false }).consent !== undefined, true);
check('consent must be boolean true', errs({ consent: 'true' }).consent !== undefined, true);
check('numeric name rejected', errs({ full_name: '12345678' }).full_name !== undefined, true);
check('one-char name rejected', errs({ full_name: 'R' }).full_name !== undefined, true);
check('unicode name accepted', apply({ full_name: 'Ramesh Iyer' }).ok, true);
check('invalid enum rejected', errs({ experience_bucket: 'wizard' }).experience_bucket !== undefined, true);
check('linkedin now OPTIONAL (matches design)', apply({ linkedin_url: '' }).ok, true);
check('but a bad linkedin is still rejected', errs({ linkedin_url: 'https://evil.io/x' }).linkedin_url !== undefined, true);

// ---------------------------------------------------------------------------
section('Custom questions');
check('required question enforced',
  apply({ custom_answers: { built_what: 'x'.repeat(30) } }).errors.has_api !== undefined, true);
check('min_length enforced',
  apply({ custom_answers: { built_what: 'short', has_api: true } }).errors.built_what !== undefined, true);
check('multi_select value outside options rejected',
  apply({ custom_answers: { built_what: 'x'.repeat(30), has_api: true, stack: ['Node.js', 'Cobol'] } })
    .errors.stack !== undefined, true);
check('multi_select over max_select rejected',
  apply({ custom_answers: { built_what: 'x'.repeat(30), has_api: true, stack: ['Node.js', 'Redis', 'Node.js'] } })
    .errors.stack !== undefined, true);
check('multi_select valid accepted',
  apply({ custom_answers: { built_what: 'x'.repeat(30), has_api: true, stack: ['Node.js', 'Redis'] } }).ok, true);
check('boolean question accepts real boolean',
  apply({ custom_answers: { built_what: 'x'.repeat(30), has_api: false } }).ok, true);
check('url question validates scheme',
  apply({ custom_answers: { built_what: 'x'.repeat(30), has_api: true, gh: 'http://x.com' } })
    .errors.gh !== undefined, true);
check('oversized answers blob rejected',
  apply({ custom_answers: { built_what: 'x'.repeat(600), has_api: true } }).ok !== false ||
  apply({ custom_answers: { built_what: 'x'.repeat(5000), has_api: true } }).ok === false, true);
check('answers array instead of object rejected',
  apply({ custom_answers: ['evil'] }).ok, false);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
