// Public login endpoint for the lineup-editing feature. A single shared
// password (SITE_PASSWORD) gates write access; on success it hands back a
// signed, stateless token (api/lib/auth.mjs) the client stores and sends
// as a Bearer token on writes (submit-lineup.js).

import { createToken } from './lib/auth.mjs';

const ALLOWED_ORIGINS = new Set([
  'https://melbostads.com',
  'https://shamrock84.github.io',
]);

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
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

  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== sitePassword) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  res.status(200).json({ token: createToken(sessionSecret) });
}
