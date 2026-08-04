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
// format is a dynasty-league subclass: 'dynasty' rosters render as before,
// 'auction' rosters additionally show each player's salary and contract years.
// Display order matters here and is preserved verbatim on the page
// (rosters, scoring, and standings cards all follow this order).
const DYNASTY_LEAGUES = [
  { id: '26696', franchiseId: '0001', name: 'MNMx Dynasty', type: 'dynasty', format: 'dynasty' },
  { id: '25608', franchiseId: '0001', name: 'OSD', type: 'dynasty', format: 'dynasty' },
  { id: '23545', franchiseId: '0008', name: 'Survivor', type: 'dynasty', format: 'dynasty' },
  { id: '35217', franchiseId: '0004', name: 'Iron Bank', type: 'dynasty', format: 'auction' },
  { id: '34850', franchiseId: '0010', name: 'Wise Guys', type: 'dynasty', format: 'auction' },
  { id: '30641', franchiseId: '0003', name: 'Super Cap', type: 'dynasty', format: 'auction' },
  { id: '64470', franchiseId: '0005', name: 'Game On', type: 'dynasty', format: 'auction' },
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
        // Only meaningful for auction-format leagues; MFL includes these on
        // the roster export directly for leagues with a salary cap enabled.
        salary: p.salary ?? null,
        contractYear: p.contractYear ?? null,
      };
    })
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));

  return {
    id: league.id,
    name: league.name,
    type: league.type,
    format: league.format || null,
    leagueName: leagueData?.league?.name || league.name,
    franchiseId: league.franchiseId,
    teamName: franchiseInfo?.name || league.name,
    url: `https://www.myfantasyleague.com/${YEAR}/home/${league.id}`,
    players,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

async function fetchStandings(league, cookie) {
  const [leagueData, standingsData] = await Promise.all([
    mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie),
    mflGet(`/export?TYPE=leagueStandings&L=${league.id}&JSON=1`, cookie),
  ]);

  const franchises = leagueData?.league?.franchises?.franchise ?? [];
  const franchiseList = Array.isArray(franchises) ? franchises : [franchises];
  const nameById = new Map(franchiseList.map((f) => [f.id, f.name]));

  const rawRows = standingsData?.leagueStandings?.franchise;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];

  if (rows.length === 0) {
    throw new Error('No standings data returned for this league');
  }

  // Rows arrive pre-sorted by MFL's own tiebreakers, so rank = array order.
  return rows.map((r) => ({
    franchiseId: r.id,
    teamName: nameById.get(r.id) || r.id,
    wins: Number(r.h2hw ?? 0),
    losses: Number(r.h2hl ?? 0),
    ties: Number(r.h2ht ?? 0),
    pointsFor: Number(r.pf ?? 0).toFixed(2),
    pointsAgainst: Number(r.pa ?? 0).toFixed(2),
    isMe: r.id === league.franchiseId,
  }));
}

async function fetchScoring(league, cookie) {
  const [leagueData, liveData] = await Promise.all([
    mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie),
    mflGet(`/export?TYPE=liveScoring&L=${league.id}&JSON=1`, cookie),
  ]);

  const franchises = leagueData?.league?.franchises?.franchise ?? [];
  const franchiseList = Array.isArray(franchises) ? franchises : [franchises];
  const nameById = new Map(franchiseList.map((f) => [f.id, f.name]));

  const live = liveData?.liveScoring;
  const rawRows = live?.franchise;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];

  if (rows.length === 0) {
    throw new Error('No live scoring available yet');
  }

  const teams = rows
    .map((f) => ({
      franchiseId: f.id,
      teamName: nameById.get(f.id) || f.id,
      score: Number(f.score ?? 0),
      isMe: f.id === league.franchiseId,
    }))
    .sort((a, b) => b.score - a.score)
    .map((t) => ({ ...t, score: t.score.toFixed(2) }));

  return { week: live?.week ?? null, teams };
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
        format: league.format || null,
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
        format: league.format || null,
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

  for (const league of DYNASTY_LEAGUES) {
    const target = leagues.find((l) => l.id === league.id);
    if (!target) continue;
    try {
      target.standings = await fetchStandings(league, cookie);
      target.standingsError = null;
      console.log(`Fetched standings for ${league.name}: ${target.standings.length} teams`);
    } catch (err) {
      console.error(`Failed to fetch standings for ${league.name}: ${err.message}`);
      const prev = previousById.get(league.id);
      target.standings = prev?.standings || [];
      target.standingsError = err.message;
    }
  }

  for (const league of LEAGUES) {
    const target = leagues.find((l) => l.id === league.id);
    if (!target || !league.franchiseId) continue;
    try {
      target.scoring = await fetchScoring(league, cookie);
      target.scoringError = null;
      console.log(`Fetched scoring for ${league.name}: ${target.scoring.teams.length} teams`);
    } catch (err) {
      console.error(`Failed to fetch scoring for ${league.name}: ${err.message}`);
      const prev = previousById.get(league.id);
      target.scoring = prev?.scoring || null;
      target.scoringError = err.message;
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
