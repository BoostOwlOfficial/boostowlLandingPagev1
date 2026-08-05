// ============================================================================
// Rate limiting — Upstash Redis over HTTP, with a Postgres fallback.
//
// Rate limiting must never silently switch off. If Redis is unreachable we
// count rows in Postgres instead: slower, same limits. Only if BOTH are
// unreachable does the request fail closed.
//
// Fixed windows (not sliding): a request is keyed to floor(now / windowSize).
// Simpler, one round trip, and predictable enough for this use case.
// ============================================================================

'use strict';

const { rpc } = require('./supabase');

const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

function redisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * Run an Upstash pipeline. Returns an array of results, or null if Redis is
 * unavailable — the caller then falls back to Postgres.
 */
async function pipeline(commands, timeoutMs = 3000) {
  if (!redisConfigured()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.error('[limits] redis pipeline HTTP', resp.status);
      return null;
    }
    const data = await resp.json();
    return Array.isArray(data) ? data.map((r) => (r ? r.result : null)) : null;
  } catch (err) {
    console.error('[limits] redis unreachable:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function windowKey(prefix, value, seconds) {
  const bucket = Math.floor(Date.now() / 1000 / seconds);
  return `rl:${prefix}:${value}:${bucket}`;
}

/**
 * Burn a one-time nonce. Returns true if this nonce had not been used before.
 * `SET key 1 NX EX ttl` returns null when the key already exists.
 *
 * If Redis is down this returns true (fail-open) — replay protection is a
 * defence-in-depth layer, and the dwell-time check plus Turnstile still apply.
 */
async function burnNonce(nonce, ttlSeconds = 7200) {
  const results = await pipeline([['SET', `nonce:${nonce}`, '1', 'NX', 'EX', String(ttlSeconds)]]);
  if (results === null) return true;
  return results[0] === 'OK';
}

/**
 * Check every per-applicant limit.
 *
 * @returns {{ok: true} | {ok: false, reason: string, retryAfter: number}}
 */
async function checkRateLimits({ ipHash, emailNormalized, phoneE164 }, config) {
  const checks = [
    { key: windowKey('ip:h', ipHash, HOUR),  limit: config.rate_limit_ip_hour,  reason: 'IP_HOUR',  retryAfter: HOUR },
    { key: windowKey('ip:d', ipHash, DAY),   limit: config.rate_limit_ip_day,   reason: 'IP_DAY',   retryAfter: DAY },
    { key: windowKey('ip:w', ipHash, WEEK),  limit: config.rate_limit_ip_week,  reason: 'IP_WEEK',  retryAfter: WEEK },
  ];

  const thirtyDays = 30 * DAY;
  if (emailNormalized) {
    checks.push({
      key: windowKey('em', emailNormalized, thirtyDays),
      limit: config.rate_limit_email_30d, reason: 'EMAIL_30D', retryAfter: DAY,
    });
  }
  if (phoneE164) {
    checks.push({
      key: windowKey('ph', phoneE164, thirtyDays),
      limit: config.rate_limit_phone_30d, reason: 'PHONE_30D', retryAfter: DAY,
    });
  }

  // One pipeline: INCR + EXPIRE per check.
  const commands = [];
  for (const c of checks) {
    commands.push(['INCR', c.key]);
    commands.push(['EXPIRE', c.key, String(c.retryAfter === WEEK ? WEEK : (c.reason.includes('30D') ? thirtyDays : c.retryAfter))]);
  }

  const results = await pipeline(commands);

  if (results !== null) {
    for (let i = 0; i < checks.length; i++) {
      const count = Number(results[i * 2]);
      if (Number.isFinite(count) && count > checks[i].limit) {
        return { ok: false, reason: checks[i].reason, retryAfter: checks[i].retryAfter };
      }
    }
    return { ok: true };
  }

  // ---- Redis unavailable: count rows in Postgres instead. -----------------
  console.warn('[limits] falling back to Postgres counting');
  try {
    const now = Date.now();
    const iso = (ms) => new Date(now - ms).toISOString();

    const [ipHour, ipDay, emailCount, phoneCount] = await Promise.all([
      rpc('count_recent', { p_field: 'ip', p_value: ipHash, p_since: iso(HOUR * 1000) }, 4000),
      rpc('count_recent', { p_field: 'ip', p_value: ipHash, p_since: iso(DAY * 1000) }, 4000),
      emailNormalized
        ? rpc('count_recent', { p_field: 'email', p_value: emailNormalized, p_since: iso(thirtyDays * 1000) }, 4000)
        : Promise.resolve(0),
      phoneE164
        ? rpc('count_recent', { p_field: 'phone', p_value: phoneE164, p_since: iso(thirtyDays * 1000) }, 4000)
        : Promise.resolve(0),
    ]);

    if (Number(ipHour) >= config.rate_limit_ip_hour) return { ok: false, reason: 'IP_HOUR', retryAfter: HOUR };
    if (Number(ipDay) >= config.rate_limit_ip_day) return { ok: false, reason: 'IP_DAY', retryAfter: DAY };
    if (Number(emailCount) >= config.rate_limit_email_30d) return { ok: false, reason: 'EMAIL_30D', retryAfter: DAY };
    if (Number(phoneCount) >= config.rate_limit_phone_30d) return { ok: false, reason: 'PHONE_30D', retryAfter: DAY };

    return { ok: true };
  } catch (err) {
    // Both stores unreachable — fail closed rather than accept unlimited traffic.
    console.error('[limits] Postgres fallback failed:', err.message);
    return { ok: false, reason: 'LIMITER_UNAVAILABLE', retryAfter: 60 };
  }
}

/**
 * Global circuit breaker. Atomic in Postgres so concurrent requests cannot
 * both slip past the cap.
 */
async function reserveGlobalSlot(config) {
  try {
    const result = await rpc(
      'reserve_global_slot',
      { p_cap_hour: config.global_cap_hour, p_cap_day: config.global_cap_day },
      5000
    );
    if (result && result.ok === false) {
      return { ok: false, reason: result.reason, count: result.count };
    }
    return { ok: true };
  } catch (err) {
    // Postgres is down; apply_to_job would fail anyway. Let it through here so
    // the caller reports the real database error rather than a bogus cap hit.
    console.error('[limits] global cap check failed:', err.message);
    return { ok: true, degraded: true };
  }
}

module.exports = {
  burnNonce,
  checkRateLimits,
  reserveGlobalSlot,
  redisConfigured,
};
