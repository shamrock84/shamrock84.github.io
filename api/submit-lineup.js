// Vercel serverless function: submits a starting lineup to MFL for the
// lineupPilot league (currently just MNMx Dynasty — config/leagues.json).
// Requires a valid Bearer token from api/login.js; the password itself is
// never sent here, only the signed token it issued.
//
// Requires MFL_USERNAME/MFL_PASSWORD (same as live-scoring.js) plus
// SESSION_SECRET (shared with login.js) as Vercel project environment
// variables.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchMflLineup, mflLogin, submitMflLineup } from '../scripts/lib/providers.mjs';
import { verifyToken } from './lib/auth.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));

const ALLOWED_ORIGINS = new Set([
  'https://melbostads.com',
  'https://shamrock84.github.io',
]);

async function loadLineupPilotLeague() {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const leagues = JSON.parse(raw).leagues || [];
  return leagues.find((l) => l.lineupPilot && l.provider !== 'espn') || null;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    res.status(500).json({ error: 'SESSION_SECRET is not configured on this deployment.' });
    return;
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!verifyToken(token, sessionSecret)) {
    res.status(401).json({ error: 'Log in again — your session has expired or is invalid.' });
    return;
  }

  const username = process.env.MFL_USERNAME;
  const password = process.env.MFL_PASSWORD;
  if (!username || !password) {
    res.status(500).json({ error: 'MFL_USERNAME and MFL_PASSWORD are not configured on this deployment.' });
    return;
  }

  const { starterIds } = req.body || {};
  if (!Array.isArray(starterIds) || starterIds.length === 0 || !starterIds.every((id) => typeof id === 'string')) {
    res.status(400).json({ error: 'starterIds must be a non-empty array of player id strings.' });
    return;
  }

  const league = await loadLineupPilotLeague();
  if (!league) {
    res.status(500).json({ error: 'No lineupPilot league configured.' });
    return;
  }

  try {
    // Read the current week from the same source the Rosters tab uses, so
    // we submit for the week actually being displayed rather than
    // hardcoding one.
    const readCookie = await mflLogin(username, password);
    const current = await fetchMflLineup(league, readCookie);

    const result = await submitMflLineup(username, password, league, starterIds, current.week);
    const mflOk = /<status>OK<\/status>/i.test(result.bodyText);
    if (!mflOk) {
      res.status(502).json({ error: `MFL rejected the submission: ${result.bodyText.slice(0, 300)}` });
      return;
    }

    res.status(200).json({ ok: true, week: current.week, starterIds });
  } catch (err) {
    res.status(502).json({ error: `Failed to submit lineup: ${err.message}` });
  }
}
