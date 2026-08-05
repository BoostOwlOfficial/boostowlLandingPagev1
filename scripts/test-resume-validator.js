#!/usr/bin/env node
// ============================================================================
// Unit tests for the resume validator. Not deployed (scripts/ is .vercelignored).
//   node scripts/test-resume-validator.js
// ============================================================================

'use strict';

const { validateResume, sanitizeFilename } = require('../api/careers/_lib/resume');

const MAX = 2 * 1024 * 1024;
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        expected ${expected}, got ${actual}`);
    fail++;
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const pdf = (body) => Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'ascii'),
  Buffer.from(body || '1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'ascii'),
  Buffer.from('\ntrailer\n<< /Size 1 >>\n%%EOF\n', 'ascii'),
]);

console.log('\nResume validator\n');

// ---- Happy path -----------------------------------------------------------
{
  const r = validateResume({ data: b64(pdf()), filename: 'resume.pdf', mime: 'application/pdf' }, MAX);
  check('valid PDF accepted', r.ok, true);
  check('sha256 computed', typeof r.sha256 === 'string' && r.sha256.length === 64, true);
  check('no flags on a clean PDF', r.flags.length, 0);
}

// ---- Type confusion -------------------------------------------------------
{
  const r = validateResume(
    { data: b64('This is a plain text file pretending to be a PDF. %%EOF'), filename: 'resume.pdf', mime: 'application/pdf' },
    MAX
  );
  check('text file renamed .pdf rejected', r.code, 'RESUME_NOT_PDF');
}
{
  // ZIP magic bytes (PK\x03\x04) — a zip bomb renamed to .pdf
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(500), Buffer.from('%%EOF')]);
  const r = validateResume({ data: b64(zip), filename: 'resume.pdf', mime: 'application/pdf' }, MAX);
  check('zip renamed .pdf rejected', r.code, 'RESUME_NOT_PDF');
}
{
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>%%EOF');
  const r = validateResume({ data: b64(svg), filename: 'x.pdf', mime: 'application/pdf' }, MAX);
  check('svg payload rejected', r.code, 'RESUME_NOT_PDF');
}
{
  const r = validateResume({ data: b64(pdf()), filename: 'resume.exe', mime: 'application/pdf' }, MAX);
  check('non-.pdf extension rejected', r.code, 'RESUME_NOT_PDF');
}
{
  const r = validateResume({ data: b64(pdf()), filename: 'resume.pdf', mime: 'text/html' }, MAX);
  check('wrong declared mime rejected', r.code, 'RESUME_NOT_PDF');
}

// ---- Integrity ------------------------------------------------------------
{
  const truncated = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3000, 0x41)]);
  const r = validateResume({ data: b64(truncated), filename: 'r.pdf', mime: 'application/pdf' }, MAX);
  check('truncated PDF rejected', r.code, 'RESUME_TRUNCATED');
}
{
  const enc = pdf('1 0 obj\n<< /Filter /Standard /Encrypt 2 0 R >>\nendobj\n');
  const r = validateResume({ data: b64(enc), filename: 'r.pdf', mime: 'application/pdf' }, MAX);
  check('password-protected PDF rejected', r.code, 'RESUME_ENCRYPTED');
}

// ---- Size -----------------------------------------------------------------
{
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3 * 1024 * 1024, 0x41), Buffer.from('%%EOF')]);
  const r = validateResume({ data: b64(big), filename: 'r.pdf', mime: 'application/pdf' }, MAX);
  check('oversized PDF rejected', r.code, 'RESUME_TOO_LARGE');
}
{
  const r = validateResume({ data: '', filename: 'r.pdf', mime: 'application/pdf' }, MAX);
  check('empty payload rejected', r.code, 'RESUME_EMPTY');
}
{
  const r = validateResume({ data: 'not!valid!base64!', filename: 'r.pdf', mime: 'application/pdf' }, MAX);
  check('malformed base64 rejected', r.code, 'RESUME_INVALID');
}
{
  const r = validateResume(null, MAX);
  check('null input rejected', r.code, 'RESUME_INVALID');
}

// ---- Active content is flagged, not rejected ------------------------------
{
  const js = pdf('1 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert\\(1\\)) >>\nendobj\n');
  const r = validateResume({ data: b64(js), filename: 'r.pdf', mime: 'application/pdf' }, MAX);
  check('PDF with JavaScript still accepted', r.ok, true);
  check('  ...but flagged', r.flags.includes('javascript'), true);
}

// ---- Filename sanitisation ------------------------------------------------
console.log('\nFilename sanitisation\n');
// Separators become '_' first, then runs of dots collapse to one:
//   ../../etc/passwd.pdf -> .._.._etc_passwd.pdf -> ._._etc_passwd.pdf
check('path traversal stripped', sanitizeFilename('../../etc/passwd.pdf'), '._._etc_passwd.pdf');
check('backslash traversal stripped', sanitizeFilename('..\\..\\win.pdf'), '._._win.pdf');
check('null byte stripped', sanitizeFilename('resume\x00.pdf'), 'resume.pdf');
check('RTL override stripped', sanitizeFilename('resume\u202Egnp.pdf'), 'resumegnp.pdf');
check('zero-width stripped', sanitizeFilename('res​ume.pdf'), 'resume.pdf');
check('empty falls back', sanitizeFilename(''), 'resume.pdf');
check('non-string falls back', sanitizeFilename(null), 'resume.pdf');
check('long name truncated to 120', sanitizeFilename('a'.repeat(300) + '.pdf').length, 120);

// A sanitised name must never be usable as a path.
const nasty = sanitizeFilename('../../../root/.ssh/id_rsa.pdf');
check('sanitised name has no separators', /[/\\]/.test(nasty), false);
check('sanitised name has no ".."', nasty.includes('..'), false);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
