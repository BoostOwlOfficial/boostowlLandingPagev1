// ============================================================================
// Resume validation.
//
// The client claims a MIME type and a filename. Neither is trusted. What is
// trusted: the bytes.
//
// Edge cases covered here are listed in CAREERS-ADMIN.md §5 / the plan §4.
// ============================================================================

'use strict';

const crypto = require('crypto');

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const EOF_MARKER = Buffer.from('%%EOF', 'ascii');

// Active-content markers. These are FLAGGED, never rejected — legitimate
// exporters (Word, LaTeX, Canva) emit /OpenAction constantly, so rejecting
// would block real candidates. Safe to accept because the bucket is private
// and every object is served Content-Disposition: attachment.
const ACTIVE_CONTENT_MARKERS = [
  { marker: '/JavaScript', flag: 'javascript' },
  { marker: '/JS',         flag: 'javascript' },
  { marker: '/Launch',     flag: 'launch_action' },
  { marker: '/EmbeddedFile', flag: 'embedded_file' },
  { marker: '/OpenAction', flag: 'open_action' },
];

/** Base64 decodes to roughly 3/4 of its length. Check before allocating. */
function approxDecodedBytes(b64) {
  const len = b64.length;
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'resume.pdf';
  return name
    .replace(/[\x00-\x1F\x7F]/g, '')                 // control characters
    .replace(/[\u200B-\u200D\uFEFF]/g, '')           // zero-width
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')    // bidi overrides (RTL spoofing)
    .replace(/[/\\]/g, '_')                          // path separators
    .replace(/\.{2,}/g, '.')                         // traversal
    .trim()
    .slice(0, 120) || 'resume.pdf';
}

/**
 * Validate an uploaded resume.
 *
 * @param {object} input  { data: base64 string, filename, mime }
 * @param {number} maxBytes
 * @returns {{ok:true, buffer, bytes, sha256, filename, flags} | {ok:false, code, message}}
 */
function validateResume(input, maxBytes) {
  if (!input || typeof input !== 'object') {
    return { ok: false, code: 'RESUME_INVALID', message: 'No file received.' };
  }

  const { data, filename, mime } = input;

  if (typeof data !== 'string' || data.length === 0) {
    return { ok: false, code: 'RESUME_EMPTY', message: 'The file appears to be empty.' };
  }

  // ---- Size, checked BEFORE decoding so an oversized payload is never
  //      materialised in memory. ------------------------------------------
  const approx = approxDecodedBytes(data);
  if (approx > maxBytes) {
    return {
      ok: false,
      code: 'RESUME_TOO_LARGE',
      message: `That file is about ${(approx / 1048576).toFixed(1)} MB. Please upload a PDF under ${(maxBytes / 1048576).toFixed(0)} MB.`,
    };
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return { ok: false, code: 'RESUME_INVALID', message: 'The file could not be read. Please try again.' };
  }

  // ---- Decode ------------------------------------------------------------
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    return { ok: false, code: 'RESUME_INVALID', message: 'The file could not be read. Please try again.' };
  }

  const bytes = buffer.length;
  if (bytes === 0) {
    return { ok: false, code: 'RESUME_EMPTY', message: 'The file appears to be empty.' };
  }
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: 'RESUME_TOO_LARGE',
      message: `Please upload a PDF under ${(maxBytes / 1048576).toFixed(0)} MB.`,
    };
  }

  // ---- Declared type. Advisory only; the magic-byte check below is the
  //      real gate. --------------------------------------------------------
  if (mime && mime !== 'application/pdf') {
    return { ok: false, code: 'RESUME_NOT_PDF', message: 'Please upload a PDF file.' };
  }
  const safeName = sanitizeFilename(filename);
  if (!/\.pdf$/i.test(safeName)) {
    return { ok: false, code: 'RESUME_NOT_PDF', message: 'Please upload a PDF file.' };
  }

  // ---- Magic bytes. Kills a renamed .exe, a zip bomb, SVG/HTML payloads. --
  if (!buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return {
      ok: false,
      code: 'RESUME_NOT_PDF',
      message: 'That file is not a PDF. Please export your resume as a PDF and try again.',
    };
  }

  // ---- Completeness. A truncated upload passes the magic-byte check but
  //      would fail AI scoring later with a confusing error. ---------------
  const tail = buffer.subarray(Math.max(0, bytes - 2048));
  if (tail.indexOf(EOF_MARKER) === -1) {
    return {
      ok: false,
      code: 'RESUME_TRUNCATED',
      message: 'That PDF looks incomplete. Please re-export it and try again.',
    };
  }

  // ---- Encryption. Must be rejected explicitly: an encrypted PDF cannot be
  //      read by us or by the scorer, and the candidate gets a clear reason
  //      instead of silent failure downstream. ----------------------------
  const head = buffer.subarray(0, Math.min(bytes, 4096)).toString('latin1');
  const foot = tail.toString('latin1');
  if (/\/Encrypt\b/.test(foot) || /\/Encrypt\b/.test(head)) {
    return {
      ok: false,
      code: 'RESUME_ENCRYPTED',
      message: 'That PDF is password-protected. Please upload an unlocked copy.',
    };
  }

  // ---- Active content: flag, do not reject. ------------------------------
  const scanWindow = buffer.subarray(0, Math.min(bytes, 262144)).toString('latin1');
  const flags = [];
  for (const { marker, flag } of ACTIVE_CONTENT_MARKERS) {
    if (scanWindow.includes(marker) && !flags.includes(flag)) flags.push(flag);
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return { ok: true, buffer, bytes, sha256, filename: safeName, flags };
}

module.exports = { validateResume, sanitizeFilename, approxDecodedBytes };
