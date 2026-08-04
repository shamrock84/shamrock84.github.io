#!/usr/bin/env node
// Logs into MyFantasyLeague, pulls the roster for each configured league/franchise,
// and writes a consolidated data/rosters.json for rosters.html to render.
//
// Requires MFL_USERNAME and MFL_PASSWORD env vars (set as GitHub Actions secrets).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const YEAR = process.env.MFL_YEAR || String(new Date().getFullYear());
const USERNAME = process.env.MFL_USERNAME;
const PASSWORD = process.env.MFL_PASSWORD;
const BASE = `https://api.myfantasyleague.com/${YEAR}`;
const OUTPUT_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));

// Add/remove leagues here. franchiseId is *your* team in that league.
// type controls which tab a league shows up under on rosters.html.
const DYNASTY_LEAGUES = [
  { id: '26696', franchiseId: '0001', name: 'MNMx Dynasty', type: 'dynasty' },
  { id: '35217', franchiseId: '0004', name: 'Iron Bank', type: 'dynasty' },
  { id: '25608', franchiseId: '0001', name: 'OSD', type: 'dynasty' },
  { id: '34850', franchiseId: '0010', name: 'Wise Guys', type: 'dynasty' },
  { id: '23545', franchiseId: '0008', name: 'Survivor', type: 'dynasty' },
  { id: '30641', franchiseId: '0003', name: 'Super Cap', type: 'dynasty' },
  { id: '64470', franchiseId: '0005', name: 'Game On', type: 'dynasty' },
];

const BESTBALL_LEAGUES = [
  { id: '56191', franchiseId: '0012', name: 'Worlds Collide', type: 'bestball' },
  { id: '34203', franchiseId: '0006', name: "Rug's Playground", type: 'bestball' },
  { id: '72911', franchiseId: '0006', name: 'April Pre-NFL Draft', type: 'bestball' },
  { id: '54766', franchiseId: '0004', name: 'May Rookies', type: 'bestball' },
  { id: '54458', franchiseId: '0004', name: 'June Tecmo Ball', type: 'bestball' },
  { id: '61777', franchiseId: '0003', name: 'July Semiquincentennial', type: 'bestball' },
  { id: '30196', franchiseId: '0004', name: 'July Fantasy Football for Dummies', type: 'bestball' },
];

const LEAGUES = [...DYNASTY_LEAGUES, ...BESTBALL_LEAGUES];

const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'PK', 'PN', 'Off', 'DL', 'DE', 'DT', 'LB', 'CB', 'S', 'DB', 'Def'];

function positionRank(pos) {
  const idx = POSITION_ORDER.indexOf(pos);
  return idx === -1 ? POSITION_ORDER.length : idx;
}

function formatPlayerName(raw) {
  if (!raw) return '';
  const parts = raw.split(', ');
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : raw;
}

async function mflLogin(username, password) {
  const url = `${BASE}/login?USERNAME=${encodeURIComponent(username)}&PASSWORD=${encodeURIComponent(password)}&XML=1`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();

  let cookie = null;
  const setCookieHeaders = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const sc of setCookieHeaders) {
    const m = sc && sc.match(/MFL_USER_ID=[^;]+/);
    if (m) { cookie = m[0]; break; }
  }
  if (!cookie) {
    const m = text.match(/MFL_USER_ID=[^;"'\s]+/);
    if (m) cookie = m[0];
  }
  if (!cookie) {
    throw new Error(`MFL login did not return a session cookie. Response: ${text.slice(0, 300)}`);
  }
  return cookie;
}

async function mflGet(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`MFL request failed (${res.status}): ${path}`);
  }
  return res.json();
}

async function loadPlayerMap(cookie) {
  const data = await mflGet('/export?TYPE=players&DETAILS=1&JSON=1', cookie);
  const list = data?.players?.player ?? [];
  const map = new Map();
  for (const p of list) {
    map.set(p.id, {
      name: formatPlayerName(p.name),
      position: p.position || '',
      team: p.team || 'FA',
    });
  }
  return map;
}

async function fetchLeagueRoster(league, cookie, playerMap) {
  const [leagueData, rostersData] = await Promise.all([
    mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie),
    mflGet(`/export?TYPE=rosters&L=${league.id}&FRANCHISE=${league.franchiseId}&JSON=1`, cookie),
  ]);

  const franchises = leagueData?.league?.franchises?.franchise ?? [];
  const franchiseInfo = Array.isArray(franchises)
    ? franchises.find((f) => f.id === league.franchiseId)
    : franchises;

  const rosterFranchise = Array.isArray(rostersData?.rosters?.franchise)
    ? rostersData.rosters.franchise[0]
    : rostersData?.rosters?.franchise;

  if (!rosterFranchise) {
    throw new Error('No roster data returned for this franchise');
  }

  const rawPlayers = rosterFranchise.player
    ? (Array.isArray(rosterFranchise.player) ? rosterFranchise.player : [rosterFranchise.player])
    : [];

  const players = rawPlayers
    .map((p) => {
      const info = playerMap.get(p.id) || {};
      return {
        id: p.id,
        name: info.name || `Unknown Player (${p.id})`,
        position: info.position || '',
        team: info.team || 'FA',
        status: p.status || 'ROSTER',
      };
    })
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));

  return {
    id: league.id,
    name: league.name,
    type: league.type,
    leagueName: leagueData?.league?.name || league.name,
    franchiseId: league.franchiseId,
    teamName: franchiseInfo?.name || league.name,
    url: `https://www.myfantasyleague.com/${YEAR}/home/${league.id}`,
    players,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

async function loadPreviousOutput() {
  try {
    const raw = await readFile(OUTPUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('MFL_USERNAME and MFL_PASSWORD environment variables are required.');
  }

  const previous = await loadPreviousOutput();
  const previousById = new Map((previous?.leagues ?? []).map((l) => [l.id, l]));

  const cookie = await mflLogin(USERNAME, PASSWORD);
  const playerMap = await loadPlayerMap(cookie);

  const leagues = [];
  for (const league of LEAGUES) {
    if (!league.franchiseId) {
      console.log(`Skipping ${league.name}: no franchiseId configured yet`);
      leagues.push({
        id: league.id,
        name: league.name,
        type: league.type,
        leagueName: league.name,
        franchiseId: null,
        teamName: league.name,
        url: `https://www.myfantasyleague.com/${YEAR}/home/${league.id}`,
        players: [],
        updatedAt: null,
        error: 'Franchise ID not configured yet',
      });
      continue;
    }
    try {
      const result = await fetchLeagueRoster(league, cookie, playerMap);
      leagues.push(result);
      console.log(`Fetched ${league.name}: ${result.players.length} players`);
    } catch (err) {
      console.error(`Failed to fetch ${league.name}: ${err.message}`);
      const prev = previousById.get(league.id);
      leagues.push({
        id: league.id,
        name: league.name,
        type: league.type,
        leagueName: prev?.leagueName || league.name,
        franchiseId: league.franchiseId,
        teamName: prev?.teamName || league.name,
        url: prev?.url || `https://www.myfantasyleague.com/${YEAR}/home/${league.id}`,
        players: prev?.players || [],
        updatedAt: prev?.updatedAt || null,
        error: err.message,
      });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    year: YEAR,
    leagues,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
