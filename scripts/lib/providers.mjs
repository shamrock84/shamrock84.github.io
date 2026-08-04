// Shared MFL/ESPN fetch logic used by both scripts/fetch-rosters.mjs (the
// full GitHub Actions sync) and api/live-scoring.js (the Vercel live-scoring
// proxy). Keeping this in one place means the two never drift out of sync.

export const YEAR = process.env.MFL_YEAR || String(new Date().getFullYear());
const BASE = `https://api.myfantasyleague.com/${YEAR}`;
const ESPN_S2 = process.env.ESPN_S2;
const ESPN_SWID = process.env.ESPN_SWID;
// fantasy.espn.com's API redirects (sometimes to a generic marketing page
// instead of a clean auth error) — lm-api-reads is the current stable host
// used directly by maintained ESPN API client libraries.
const ESPN_BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${YEAR}/segments/0/leagues`;

export const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'PK', 'PN', 'Off', 'DL', 'DE', 'DT', 'LB', 'CB', 'S', 'DB', 'Def'];

export function positionRank(pos) {
  const idx = POSITION_ORDER.indexOf(pos);
  return idx === -1 ? POSITION_ORDER.length : idx;
}

export function formatPlayerName(raw) {
  if (!raw) return '';
  const parts = raw.split(', ');
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : raw;
}

export function leagueUrl(league) {
  if (league.provider === 'espn') {
    return `https://fantasy.espn.com/football/team?leagueId=${league.id}&teamId=${league.franchiseId}`;
  }
  return `https://www.myfantasyleague.com/${YEAR}/home/${league.id}`;
}

// --- MFL ---

export async function mflLogin(username, password) {
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

// year defaults to the current season; pass a specific year (e.g. for
// prior-season lookups) to hit that year's API host instead.
export async function mflGet(path, cookie, year = YEAR) {
  const res = await fetch(`https://api.myfantasyleague.com/${year}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`MFL request failed (${res.status}): ${path} (year ${year})`);
  }
  return res.json();
}

export async function loadPlayerMap(cookie) {
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

// Bye week per NFL team, e.g. "PHI" -> "10". One global call (not
// per-league) — team codes match the `team` field already on every player
// record, so no translation needed.
export async function fetchNflByeWeeks(cookie) {
  const data = await mflGet('/export?TYPE=nflByeWeeks&JSON=1', cookie);
  const list = data?.nflByeWeeks?.team ?? [];
  const map = new Map();
  for (const t of list) {
    map.set(t.id, t.bye_week ?? null);
  }
  return map;
}

// Season-to-date fantasy points for a specific set of players, under this
// league's own scoring rules. MFL requires an explicit PLAYERS= list — a
// bare league-wide request just returns an empty placeholder. Reads 0 for
// everyone before the season starts, which is correct (no games played).
export async function fetchMflSeasonPoints(league, cookie, playerIds) {
  if (playerIds.length === 0) return new Map();
  const data = await mflGet(
    `/export?TYPE=playerScores&W=YTD&L=${league.id}&PLAYERS=${playerIds.join(',')}&JSON=1`,
    cookie
  );
  const rawRows = data?.playerScores?.playerScore;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];
  const map = new Map();
  for (const r of rows) {
    map.set(r.id, r.score !== '' && r.score != null ? Number(r.score) : 0);
  }
  return map;
}

// Same as fetchMflSeasonPoints but for last season — confirmed working
// against real data for long-running dynasty leagues (same league ID
// resolves fine against last year's API host). Expected to fail for
// single-season bestball leagues, which get a fresh ID every year; callers
// should treat failure as "no prior-year data available", not an error.
export async function fetchMflPriorYearPoints(league, cookie, playerIds) {
  if (playerIds.length === 0) return new Map();
  const priorYear = Number(YEAR) - 1;
  const data = await mflGet(
    `/export?TYPE=playerScores&W=YTD&L=${league.id}&PLAYERS=${playerIds.join(',')}&JSON=1`,
    cookie,
    priorYear
  );
  const rawRows = data?.playerScores?.playerScore;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];
  const map = new Map();
  for (const r of rows) {
    map.set(r.id, r.score !== '' && r.score != null ? Number(r.score) : 0);
  }
  return map;
}

export async function fetchLeagueRoster(league, cookie, playerMap, byeWeeks) {
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

  const basePlayers = rawPlayers.map((p) => {
    const info = playerMap.get(p.id) || {};
    return {
      id: p.id,
      name: info.name || `Unknown Player (${p.id})`,
      position: info.position || '',
      team: info.team || 'FA',
      bye: byeWeeks?.get(info.team) ?? null,
      status: p.status || 'ROSTER',
      // Only meaningful for auction-format leagues; MFL includes these on
      // the roster export directly for leagues with a salary cap enabled.
      salary: p.salary ?? null,
      contractYear: p.contractYear ?? null,
    };
  });

  // Points lookups are best-effort — a hiccup here shouldn't take down a
  // roster fetch that otherwise succeeded, so players just show no PTS.
  // priorYearPts is expected to fail for single-season bestball leagues
  // (fresh league ID every year) — that's fine, it just stays empty there.
  const playerIds = basePlayers.map((p) => p.id);
  let pointsMap = new Map();
  try {
    pointsMap = await fetchMflSeasonPoints(league, cookie, playerIds);
  } catch (err) {
    console.error(`Failed to fetch season points for ${league.name}: ${err.message}`);
  }
  let priorYearPointsMap = new Map();
  try {
    priorYearPointsMap = await fetchMflPriorYearPoints(league, cookie, playerIds);
  } catch (err) {
    console.error(`Failed to fetch prior-year points for ${league.name}: ${err.message}`);
  }

  const players = basePlayers
    .map((p) => ({
      ...p,
      pts: pointsMap.has(p.id) ? pointsMap.get(p.id) : null,
      priorYearPts: priorYearPointsMap.has(p.id) ? priorYearPointsMap.get(p.id) : null,
    }))
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));

  return {
    id: league.id,
    name: league.name,
    type: league.type,
    format: league.format || null,
    leagueName: leagueData?.league?.name || league.name,
    franchiseId: league.franchiseId,
    teamName: franchiseInfo?.name || league.name,
    url: leagueUrl(league),
    players,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

export async function fetchStandings(league, cookie) {
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

// Fetches just the franchise-id -> name map for an MFL league (the part of
// TYPE=league that fetchScoring needs). Callers that already have this
// cached (e.g. the live-scoring proxy) can skip re-fetching it every poll.
export async function fetchMflFranchiseNames(league, cookie) {
  const leagueData = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie);
  const franchises = leagueData?.league?.franchises?.franchise ?? [];
  const franchiseList = Array.isArray(franchises) ? franchises : [franchises];
  return new Map(franchiseList.map((f) => [f.id, f.name]));
}

// nameById is optional — pass a cached Map (from fetchMflFranchiseNames) to
// skip the TYPE=league call. Omit it to fetch names fresh every time (what
// the full sync does, since it only runs once every few hours anyway).
export async function fetchScoring(league, cookie, nameById) {
  const [names, liveData] = await Promise.all([
    nameById ? Promise.resolve(nameById) : fetchMflFranchiseNames(league, cookie),
    mflGet(`/export?TYPE=liveScoring&L=${league.id}&JSON=1`, cookie),
  ]);

  const live = liveData?.liveScoring;
  const rawRows = live?.franchise;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];

  if (rows.length === 0) {
    throw new Error('No live scoring available yet');
  }

  const teams = rows
    .map((f) => ({
      franchiseId: f.id,
      teamName: names.get(f.id) || f.id,
      score: Number(f.score ?? 0),
      isMe: f.id === league.franchiseId,
    }))
    .sort((a, b) => b.score - a.score)
    .map((t) => ({ ...t, score: t.score.toFixed(2) }));

  return { week: live?.week ?? null, teams };
}

// Which of the franchise's currently-rostered players are set as starters
// for the current week. liveScoring (what fetchScoring uses) is gated by
// the season actually being live, so pre-season this uses weeklyResults
// instead — confirmed against real data that it carries starter/nonstarter
// status independent of whether the week's games have started.
// KNOWN LIMITATION: W is hardcoded to 1. Fine while the season hasn't
// started (there's only ever a week 1 to look at), but needs to track the
// actual current week once the regular season advances past week 1.
// Pilot feature: only called for leagues flagged lineupPilot in
// config/leagues.json, so an API shape surprise here can't break the sync.
export async function fetchMflLineup(league, cookie) {
  const weeklyData = await mflGet(`/export?TYPE=weeklyResults&L=${league.id}&W=1&JSON=1`, cookie);
  const matchups = weeklyData?.weeklyResults?.matchup;
  const matchupList = Array.isArray(matchups) ? matchups : matchups ? [matchups] : [];
  let mine = null;
  for (const m of matchupList) {
    const franchises = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
    const found = franchises.find((f) => f.id === league.franchiseId);
    if (found) { mine = found; break; }
  }
  if (!mine) {
    throw new Error('No week-1 weeklyResults data for this franchise yet');
  }

  const rawPlayers = mine.player
    ? (Array.isArray(mine.player) ? mine.player : [mine.player])
    : [];
  const starterIds = rawPlayers
    .filter((p) => String(p.status || '').toLowerCase() === 'starter')
    .map((p) => p.id);

  return { week: '1', starterIds };
}

// Submits a starting lineup for the given week. UNVERIFIED request shape —
// MFL's setLineup import command isn't something this project has called
// before. Safe-tested via scripts/test-set-lineup.mjs, which re-submits a
// league's exact CURRENT starters (a no-op if the format is right) and
// re-fetches afterward to confirm nothing actually changed, rather than
// guessing blind against a real lineup. Only ever called for lineupPilot
// leagues, and only from the write-side UI once that test has passed.
export async function submitMflLineup(league, cookie, starterIds, week) {
  // Unlike every export used elsewhere in this file, /import doesn't honor
  // JSON=1 — it returns XML regardless. Fetch as text and hand back the raw
  // body; callers (currently just the diagnostic test script) are
  // responsible for interpreting it until the real shape is confirmed.
  const url = `${BASE}/import?TYPE=setLineup&L=${league.id}&FRANCHISE_ID=${league.franchiseId}&W=${week}&STARTERS=${starterIds.join(',')}&JSON=1`;
  const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'follow' });
  const bodyText = await res.text();
  return { status: res.status, ok: res.ok, bodyText };
}

// --- ESPN fantasy football (undocumented API, reverse-engineered from the
// community — field names/IDs below are best-effort; verified working
// against real leagues for standings/scoring as of this writing) ---

export const ESPN_POSITION_MAP = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'PK', 16: 'Def' };
export const ESPN_PRO_TEAM_MAP = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB',
  10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG',
  20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU',
};
const ESPN_IR_SLOT_ID = 21;

export function espnTeamName(team) {
  return team?.name || [team?.location, team?.nickname].filter(Boolean).join(' ').trim() || String(team?.id ?? '');
}

export async function espnGet(league, viewParams) {
  if (!ESPN_S2 || !ESPN_SWID) {
    throw new Error('ESPN_S2 and ESPN_SWID environment variables are required for ESPN leagues.');
  }
  const cookie = `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}`;
  let url = `${ESPN_BASE}/${league.id}?${viewParams}`;

  // fetch() drops the Cookie header on cross-origin redirects (WHATWG spec),
  // and ESPN's API is known to redirect fantasy.espn.com -> a different host
  // (e.g. lm-api-reads.fantasy.espn.com) for reads. Follow redirects manually
  // so our auth cookie doesn't silently vanish mid-request.
  let res;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      url = new URL(location, url).toString();
      continue;
    }
    break;
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`ESPN request failed (${res.status}) at ${url}: ${bodyText.slice(0, 300)}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch (err) {
    throw new Error(
      `ESPN response wasn't valid JSON (status ${res.status}, ${bodyText.length} bytes) at ${url}: ${bodyText.slice(0, 300)}`
    );
  }
}

export async function fetchEspnLeagueRoster(league) {
  // mRoster alone returns team objects with an empty roster.entries unless
  // scoped to a specific team/period — rosterForTeamId + scoringPeriodId
  // populate it. scoringPeriodId=1 is a safe pre-season default.
  // proTeamSchedules_wl is an attempt at getting bye weeks alongside the
  // rest — UNVERIFIED, since both ESPN leagues have 0 players (no draft
  // yet) so there's nothing to check this against. Bye/pts extraction below
  // is defensive and falls back to null on any shape mismatch rather than
  // breaking the roster fetch.
  const data = await espnGet(
    league,
    `view=mRoster&view=mTeam&view=mSettings&view=proTeamSchedules_wl&rosterForTeamId=${league.franchiseId}&scoringPeriodId=1`
  );

  const teams = data.teams || [];
  const team = teams.find((t) => String(t.id) === String(league.franchiseId));
  if (!team) {
    throw new Error(`No team ${league.franchiseId} found in ESPN league ${league.id}`);
  }

  const byeByProTeamId = new Map(
    (data.settings?.proTeams || []).map((t) => [t.id, t.byeWeek ?? null])
  );

  const rawEntries = team.roster?.entries || [];
  const players = rawEntries
    .map((e) => {
      const p = e.playerPoolEntry?.player || {};
      const seasonStat = (p.stats || []).find((s) => s.statSourceId === 0 && s.statSplitTypeId === 0);
      return {
        id: String(e.playerId),
        name: p.fullName || `Unknown Player (${e.playerId})`,
        position: ESPN_POSITION_MAP[p.defaultPositionId] || '',
        team: ESPN_PRO_TEAM_MAP[p.proTeamId] ?? 'FA',
        bye: byeByProTeamId.get(p.proTeamId) ?? null,
        pts: seasonStat?.appliedTotal ?? null,
        status: e.lineupSlotId === ESPN_IR_SLOT_ID ? 'INJURED_RESERVE' : 'ROSTER',
      };
    })
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));

  return {
    id: league.id,
    name: league.name,
    type: league.type,
    format: league.format || null,
    leagueName: data.settings?.name || league.name,
    franchiseId: league.franchiseId,
    teamName: espnTeamName(team),
    url: leagueUrl(league),
    players,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

export async function fetchEspnStandings(league) {
  const data = await espnGet(league, 'view=mTeam');
  const teams = data.teams || [];
  if (teams.length === 0) {
    throw new Error('No standings data returned for this league');
  }

  return teams
    .map((t) => ({
      franchiseId: String(t.id),
      teamName: espnTeamName(t),
      wins: t.record?.overall?.wins ?? 0,
      losses: t.record?.overall?.losses ?? 0,
      ties: t.record?.overall?.ties ?? 0,
      pointsFor: Number(t.record?.overall?.pointsFor ?? 0).toFixed(2),
      pointsAgainst: Number(t.record?.overall?.pointsAgainst ?? 0).toFixed(2),
      isMe: String(t.id) === String(league.franchiseId),
    }))
    .sort((a, b) => b.wins - a.wins || Number(b.pointsFor) - Number(a.pointsFor));
}

export async function fetchEspnScoring(league) {
  const data = await espnGet(league, 'view=mScoreboard&view=mTeam');
  const teamsById = new Map((data.teams || []).map((t) => [t.id, espnTeamName(t)]));
  const currentPeriod = data.status?.currentMatchupPeriod;
  const schedule = (data.schedule || []).filter((m) => m.matchupPeriodId === currentPeriod);

  const rows = [];
  for (const m of schedule) {
    if (m.home) rows.push({ teamId: m.home.teamId, score: m.home.totalPoints ?? 0 });
    if (m.away) rows.push({ teamId: m.away.teamId, score: m.away.totalPoints ?? 0 });
  }
  if (rows.length === 0) {
    throw new Error('No live scoring available yet');
  }

  const teams = rows
    .map((r) => ({
      franchiseId: String(r.teamId),
      teamName: teamsById.get(r.teamId) || String(r.teamId),
      score: r.score,
      isMe: String(r.teamId) === String(league.franchiseId),
    }))
    .sort((a, b) => b.score - a.score)
    .map((t) => ({ ...t, score: t.score.toFixed(2) }));

  return { week: currentPeriod ?? null, teams };
}
