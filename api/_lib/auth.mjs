// Shared stateless auth for the write-capable lineup endpoints (login.js,
// submit-lineup.js). A single shared password (SITE_PASSWORD) gates write
// access; on success login.js hands back an HMAC-signed token that the
// client stores and sends as a Bearer token on writes, so the password
// itself is only ever typed once, not re-sent per submission. No database —
// the token carries its own expiry and signature, verified fresh each time.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function createToken(secret) {
  const payload = { exp: Date.now() + TOKEN_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return false;

  const expectedSig = sign(payloadB64, secret);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch {
    return false;
  }
}

// The shared-secret check for the endpoints cron-job.org calls
// (game-time-check.js, weekly-results.js), which have no login session.
// Constant-time: both sides are hashed first, so the comparison never
// short-circuits on the first wrong character and timingSafeEqual gets the
// equal-length inputs it requires.
//
// Header only: `Authorization: Bearer <secret>`. `?key=` used to work and is
// now refused — a secret in a URL lands in Vercel's request logs and in the
// scheduler's run history. A request that still carries `?key=` logs a
// warning (never the value) whether or not its header is valid, because a
// header-authorized request would otherwise hide a leftover key in a
// scheduler's URL indefinitely.
export function secretMatches(given, secret) {
  if (typeof given !== 'string' || !given || !secret) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function cronAuthorized(req, secret) {
  if (req.query?.key !== undefined) {
    console.warn('cron auth: ?key= in the URL is ignored and should be removed — send the secret as an Authorization: Bearer header');
  }
  if (!secret) return false;
  const header = req.headers?.authorization || '';
  const bearer = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : '';
  return secretMatches(bearer, secret);
}
