// Public login endpoint for the lineup-editing feature. A single shared
// password (SITE_PASSWORD) gates write access; on success it hands back a
// signed, stateless token (api/_lib/auth.mjs) the client stores and sends
// as a Bearer token on writes (submit-lineup.js).
//
// Failed attempts are rate-limited, because the token this hands out is worth
// guessing for: it submits real MFL lineups, commits straight to main through
// save-leagues.js, and lasts 30 days with no way to revoke it short of
// rotating SESSION_SECRET. CORS is no defence here — it only binds browsers,
// and a guessing script isn't one.
//
// Two counters, both of FAILURES only, kept in the plans Upstash store:
//   - per client IP: LOGIN_IP_MAX_FAILURES inside a window that slides from
//     the last failure, so a script that keeps trying never drains it;
//   - across everyone: LOGIN_GLOBAL_MAX_FAILURES, which is what stops a
//     guesser spreading across many IPs. The cost is deliberate and bounded:
//     while it's tripped the manager can't log in either, but every token
//     already issued keeps working, so in practice that's "a new device has
//     to wait an hour", not "the site is down".
// A locked-out request is refused BEFORE the password is compared and is
// not counted, so guessing during a lockout learns nothing and doesn't
// extend it. A correct password clears that IP's counter.
//
// Fails open: with no store configured, or the store unreachable, login
// works exactly as it did before this existed. Rate limiting is a second
// line behind the password, and an Upstash outage must not lock the manager
// out of their own site.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { storeBump, storeCounts, storeRelease } from './_lib/store.mjs';
import { resolveStore } from './plans.js';

const LOGIN_IP_MAX_FAILURES = 10;
const LOGIN_IP_WINDOW_SECONDS = 15 * 60;
const LOGIN_GLOBAL_MAX_FAILURES = 100;
const LOGIN_GLOBAL_WINDOW_SECONDS = 60 * 60;
const GLOBAL_KEY = 'login:fail:all';

// Vercel sets x-real-ip (and overwrites x-forwarded-for) itself, so neither
// is client-spoofable there. Anything missing collapses onto one shared key,
// which errs toward limiting harder, not toward letting a request skip it.
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return 'unknown';
}

// Hashing first gives timingSafeEqual the equal-length inputs it requires,
// so neither the content nor the length of SITE_PASSWORD leaks through how
// long a wrong guess takes to reject.
function passwordMatches(given, expected) {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type' })) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sitePassword = process.env.SITE_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sitePassword || !sessionSecret) {
    res.status(500).json({ error: 'SITE_PASSWORD and SESSION_SECRET are not configured on this deployment.' });
    return;
  }

  const store = resolveStore(process.env);
  const ipKey = `login:fail:ip:${clientIp(req)}`;

  if (store) {
    try {
      const [ipFailures, globalFailures] = await storeCounts(store, [ipKey, GLOBAL_KEY]);
      if (ipFailures >= LOGIN_IP_MAX_FAILURES || globalFailures >= LOGIN_GLOBAL_MAX_FAILURES) {
        res.status(429).json({ error: 'Too many failed login attempts. Please wait a while and try again.' });
        return;
      }
    } catch (err) {
      console.error(`login: rate-limit check skipped, store unavailable: ${err.message}`);
    }
  }

  const { password } = req.body || {};
  if (typeof password !== 'string' || !passwordMatches(password, sitePassword)) {
    if (store) {
      try {
        await storeBump(store, [
          { key: ipKey, ttlSeconds: LOGIN_IP_WINDOW_SECONDS },
          { key: GLOBAL_KEY, ttlSeconds: LOGIN_GLOBAL_WINDOW_SECONDS },
        ]);
      } catch (err) {
        console.error(`login: failed attempt not counted, store unavailable: ${err.message}`);
      }
    }
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  if (store) {
    // Best effort: a stale counter only matters to a script, and it expires.
    await storeRelease(store, ipKey).catch(() => {});
  }
  res.status(200).json({ token: createToken(sessionSecret) });
}

export { LOGIN_IP_MAX_FAILURES, LOGIN_GLOBAL_MAX_FAILURES };
