// Vercel serverless function: submits a starting lineup to MFL for any
// league flagged lineupPilot in config/leagues.json. The client sends which
// league via leagueId; only ids that are actually flagged lineupPilot are
// accepted, so this can't be used to write to an arbitrary MFL league.
// Requires a valid Bearer token from api/login.js; the password itself is
// never sent here, only the signed token it issued.
//
// Only MFL leagues get past loadLineupPilotLeague below — deliberately an
// allowlist (provider === 'mfl' or unset), not a denylist of the providers
// that can't write. Sleeper and ESPN leagues can also carry lineupPilot: true
// now (myffl.html renders their current starters read-only, no Save
// control), and an allowlist means a future no-write provider added the
// same way can never fall through here by omission the way a denylist
// would require remembering to update.
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

async function loadLineupPilotLeague(leagueId) {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const leagues = JSON.parse(raw).leagues || [];
  return leagues.find((l) => l.id === leagueId && l.lineupPilot && (!l.provider || l.provider === 'mfl')) || null;
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

  const { leagueId, starterIds } = req.body || {};
  if (typeof leagueId !== 'string' || !leagueId) {
    res.status(400).json({ error: 'leagueId is required.' });
    return;
  }
  if (!Array.isArray(starterIds) || starterIds.length === 0 || !starterIds.every((id) => typeof id === 'string')) {
    res.status(400).json({ error: 'starterIds must be a non-empty array of player id strings.' });
    return;
  }

  const league = await loadLineupPilotLeague(leagueId);
  if (!league) {
    res.status(400).json({ error: 'Unknown or non-lineup-editable league.' });
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
