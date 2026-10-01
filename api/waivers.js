// Vercel serverless function behind the Waivers tab: the manager's own
// pending waiver claims in every Dynasty/Redraft league, and every auction
// still open in every Salary Cap league. Read once when the tab opens (and
// on its Refresh button), never polled, never written anywhere.
//
// Login-gated, unlike live-scoring.js — and not merely as the page's usual
// deterrent. A pending claim is private strategy (who you're after, what you
// bid, who you'd drop) that the league's own site shows to nobody else,
// which is exactly why this is an endpoint and not a field in the public
// data/rosters.json snapshot. See the "Waivers & auctions" section of
// scripts/lib/providers.mjs for the shapes read and how unconfirmed they are.
//
// Requires MFL_USERNAME/MFL_PASSWORD/ESPN_S2/ESPN_SWID plus SESSION_SECRET
// as Vercel project environment variables — all already set for
// live-scoring.js and submit-lineup.js.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  mflLogin,
  fetchMflLeagueData,
  mflFranchiseNames,
  loadPlayerMap,
  setMflRequestInterval,
  fetchMflPendingWaivers,
  fetchMflActiveAuctions,
  fetchEspnPendingWaivers,
  fetchEspnPlayerNames,
} from '../scripts/lib/providers.mjs';
import { verifyToken } from './lib/auth.mjs';
import { applyCors } from './lib/cors.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));

// One cold read is login + the global player list + two requests per MFL
// league (TYPE=league for the host and franchise names, then the claims or
// the transaction log), paced 300ms apart — the same interval, and the same
// reasoning, as live-scoring.js's LIVE_SCORING_MFL_INTERVAL_MS.
export const config = { maxDuration: 30 };
setMflRequestInterval(300);

// Per warm instance, same posture as live-scoring.js's cache: the cookie,
// the multi-megabyte global player list, and each league's TYPE=league read
// barely change, while the claims and auctions themselves are never cached.
const cache = {
  mflCookie: null,
  mflCookieAt: 0,
  mflPlayerMap: null,
  mflPlayerMapAt: 0,
  leagueData: new Map(), // leagueId -> { data, at }
};
const COOKIE_TTL_MS = 20 * 60 * 1000;
const PLAYER_MAP_TTL_MS = 60 * 60 * 1000;
const LEAGUE_DATA_TTL_MS = 60 * 60 * 1000;

async function getMflCookie(username, password) {
  if (cache.mflCookie && Date.now() - cache.mflCookieAt < COOKIE_TTL_MS) return cache.mflCookie;
  cache.mflCookie = await mflLogin(username, password);
  cache.mflCookieAt = Date.now();
  return cache.mflCookie;
}

// Never throws — without it the card shows raw ids, which beats no card.
async function getMflPlayerMap(cookie) {
  if (cache.mflPlayerMap && Date.now() - cache.mflPlayerMapAt < PLAYER_MAP_TTL_MS) return cache.mflPlayerMap;
  try {
    cache.mflPlayerMap = await loadPlayerMap(cookie);
    cache.mflPlayerMapAt = Date.now();
  } catch {
    // Keep whatever was cached; unstamped, so the next request retries.
  }
  return cache.mflPlayerMap || new Map();
}

async function getMflLeagueData(league, cookie) {
  const hit = cache.leagueData.get(league.id);
  if (hit && Date.now() - hit.at < LEAGUE_DATA_TTL_MS) return hit.data;
  const data = await fetchMflLeagueData(league, cookie);
  cache.leagueData.set(league.id, { data, at: Date.now() });
  return data;
}

// Which card a league belongs on. Draft Only leagues never open a wire.
// Salary Cap is the auction card whatever the provider; every other type is
// the waivers card.
export function waiversKindFor(league) {
  if (league.type === 'draftonly') return null;
  return league.type === 'salarycap' ? 'auctions' : 'waivers';
}

const playerOf = (map, id) => {
  const p = map.get(String(id));
  return { id: String(id), name: p?.name || null, position: p?.position || '', team: p?.team || '' };
};

async function readLeague(league, getCookie, getPlayerMap) {
  const kind = waiversKindFor(league);
  const provider = league.provider || 'mfl';
  const base = { id: league.id, kind, provider };

  if (provider === 'sleeper') {
    // Sleeper's public API publishes a claim only once it has processed —
    // there is no read for one still pending, and no auth to ask with.
    return { ...base, unsupported: 'Sleeper doesn’t publish pending claims.' };
  }

  if (provider === 'espn') {
    if (kind !== 'waivers') return { ...base, unsupported: 'Auctions are read from MFL only.' };
    const claims = await fetchEspnPendingWaivers(league);
    const names = await fetchEspnPlayerNames(league, claims.flatMap((c) => [...c.adds, ...c.drops]));
    return {
      ...base,
      claims: claims.map((c) => ({ ...c, adds: c.adds.map((id) => playerOf(names, id)), drops: c.drops.map((id) => playerOf(names, id)) })),
    };
  }

  const cookie = await getCookie();
  const leagueData = await getMflLeagueData(league, cookie);
  if (kind === 'auctions') {
    const auctions = await fetchMflActiveAuctions(league, cookie, leagueData);
    const players = await getPlayerMap(cookie);
    const nameById = mflFranchiseNames(leagueData);
    return {
      ...base,
      auctions: auctions.map((a) => ({
        ...a,
        player: playerOf(players, a.playerId),
        franchiseName: nameById.get(a.franchiseId) || a.franchiseId,
        mine: a.franchiseId === league.franchiseId,
      })),
    };
  }
  const claims = await fetchMflPendingWaivers(league, cookie, leagueData);
  const players = await getPlayerMap(cookie);
  return {
    ...base,
    claims: claims.map((c) => ({ ...c, adds: c.adds.map((id) => playerOf(players, id)), drops: c.drops.map((id) => playerOf(players, id)) })),
  };
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS', headers: 'Authorization' })) return;
  if (req.method !== 'GET') {
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

  const { leagues = [] } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const targets = leagues.filter((l) => waiversKindFor(l));

  // Login and the player list are shared across leagues and fetched lazily
  // (a portfolio with no MFL league never logs in), memoized as promises so
  // concurrent leagues share one request instead of racing to each make one.
  let cookiePromise = null;
  const getCookie = () => {
    if (!cookiePromise) {
      const { MFL_USERNAME: u, MFL_PASSWORD: p } = process.env;
      cookiePromise = u && p
        ? getMflCookie(u, p)
        : Promise.reject(new Error('MFL_USERNAME and MFL_PASSWORD are not configured on this deployment.'));
    }
    return cookiePromise;
  };
  let playerMapPromise = null;
  const getPlayerMap = (cookie) => (playerMapPromise ||= getMflPlayerMap(cookie));

  // One league failing never costs the others — same degrade-not-fail rule
  // as the sync. An error is reported per league, distinct from "nothing
  // pending", so the card never presents a failed read as an empty one.
  const settled = await Promise.allSettled(targets.map((l) => readLeague(l, getCookie, getPlayerMap)));
  const out = settled.map((r, i) => (r.status === 'fulfilled'
    ? r.value
    : { id: targets[i].id, kind: waiversKindFor(targets[i]), provider: targets[i].provider || 'mfl', error: r.reason?.message || String(r.reason) }));

  res.status(200).json({ generatedAt: new Date().toISOString(), leagues: out });
}
