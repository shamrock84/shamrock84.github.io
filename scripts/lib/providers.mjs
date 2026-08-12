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
const espnBase = (season) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues`;

// Which season a given league is being read from. YEAR is only the fallback:
// leagues roll over to a new season on their own commissioner's schedule,
// anywhere from February to April for MFL and later still for redraft, so the
// sync resolves a season per league (see resolveSeason in fetch-rosters.mjs)
// and hangs it on the league object. Every league-scoped call below reads it
// from here, which is why none of them needed a new parameter.
//
// Global lookups — the player database, bye weeks, the injury report — stay on
// YEAR deliberately. They aren't league-scoped, MFL player IDs are stable
// across seasons, and the one field that is season-specific (bye weeks) only
// matters once games are being played, by which point every league has rolled
// over and the distinction is moot.
export function seasonOf(league) {
  return String(league?.season || YEAR);
}

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

// NFL injury-report designation (Questionable/Doubtful/Out/etc.), collapsed
// to the short badge MFL's own roster page shows next to a name — e.g. "(O)"
// for Out. Each provider spells these differently (MFL: "Out"; ESPN:
// "OUT"/"INJURY_RESERVE" with underscores; Sleeper: "IR"/"Sus"), so this is
// the one place that reconciles them into a single vocabulary. Returns null
// for anyone healthy/unlisted so callers can skip rendering a badge entirely
// rather than showing something like "(ACTIVE)".
const INJURY_STATUS_MAP = {
  QUESTIONABLE: 'Q',
  DOUBTFUL: 'D',
  OUT: 'O',
  PROBABLE: 'P',
  'DAY TO DAY': 'DTD',
  'INJURY RESERVE': 'IR',
  'INJURED RESERVE': 'IR',
  IR: 'IR',
  PUP: 'PUP',
  'PHYSICALLY UNABLE TO PERFORM': 'PUP',
  NFI: 'NFI',
  'NON FOOTBALL INJURY': 'NFI',
  // MFL's own spelling of the two reserve lists, verified against the real
  // injury report by probe-injury-detail.yml (2 IR-PUP and 1 IR-NFI in a
  // 325-row August report). The hyphen is already a space by the time this
  // map is consulted, and without these two entries the length fallback below
  // sliced "IR PUP" to "IR " — a trailing-space string that renders as a
  // convincing "IR" and ranks -1 in INJURY_SEVERITY, so a season-long reserve
  // designation sorted *below* a Questionable and lost every disagreement to
  // it. PUP and NFI were already in that list waiting for these.
  'IR PUP': 'PUP',
  'IR NFI': 'NFI',
  // Not an injury, and reaches the page as its own designation for the same
  // reason HOL does. Spelled out here rather than left to the slice, which
  // produced the same 'RET' by accident. It is deliberately *not* in
  // INJURY_SEVERITY: a retired player is a roster problem but not a triage
  // one, and ranking him above IR would put him at the top of a card whose
  // first row should be the thing you can still do something about.
  RETIRED: 'RET',
  SUSPENDED: 'SUSP',
  SUS: 'SUSP',
  SUSPENSION: 'SUSP',
  COV: 'COVID',
  'COVID-19': 'COVID',
};

export function normalizeInjuryStatus(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toUpperCase().replace(/[_-]/g, ' ');
  if (!key || key === 'ACTIVE' || key === 'HEALTHY') return null;
  return INJURY_STATUS_MAP[key] || (key.length <= 4 ? key : key.slice(0, 3));
}

export function leagueUrl(league) {
  if (league.provider === 'espn') {
    return `https://fantasy.espn.com/football/team?leagueId=${league.id}&teamId=${league.franchiseId}`;
  }
  if (league.provider === 'sleeper') {
    return `https://sleeper.com/leagues/${league.id}`;
  }
  return `https://www.myfantasyleague.com/${seasonOf(league)}/home/${league.id}`;
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

// Dedicated login for lineup submission, kept fully separate from
// mflLogin() (used everywhere else) rather than risk touching that
// proven/shared read path. Confirmed via live testing that /import needs
// TWO things exports never needed: (1) the login itself scoped to the
// league via L=, and (2) the import call sent to the SAME regional host
// (e.g. www43.myfantasyleague.com) that login redirects to — the generic
// api.myfantasyleague.com host doesn't recognize the league-scoped session
// even though the cookie itself is domain-wide (.myfantasyleague.com) and
// present either way. This resolves that host dynamically from the
// login's redirect chain instead of hardcoding a shard number.
async function mflLoginForImport(username, password, leagueId, season = YEAR) {
  const url = `https://api.myfantasyleague.com/${season}/login?USERNAME=${encodeURIComponent(username)}&PASSWORD=${encodeURIComponent(password)}&L=${leagueId}&XML=1`;
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
    throw new Error(`MFL league-scoped login did not return a session cookie. Response: ${text.slice(0, 300)}`);
  }

  const hostMatch = res.url.match(/^https:\/\/([^/]+)\//);
  const host = hostMatch ? hostMatch[1] : new URL(BASE).host;
  return { cookie, host };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// year defaults to the current season; pass a specific year (e.g. for
// prior-season lookups) to hit that year's API host instead. A full sync
// makes a lot of MFL requests back-to-back, and MFL rate-limits bursts
// (429) — retry with a short backoff instead of failing leagues that just
// happened to be later in the sync.
export async function mflGet(path, cookie, year = YEAR, attempt = 1) {
  const res = await fetch(`https://api.myfantasyleague.com/${year}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'follow',
  });
  if (res.status === 429 && attempt < 4) {
    await sleep(attempt * 1500);
    return mflGet(path, cookie, year, attempt + 1);
  }
  if (!res.ok) {
    // The status rides on the error because one caller has to tell a definitive
    // 404 apart from a transient failure: see mflLeagueExists.
    const err = new Error(`MFL request failed (${res.status}): ${path} (year ${year})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Does this league exist yet in the given season? This is what lets the sync
// follow each league's own rollover instead of a date on the calendar: MFL
// commissioners roll a league over anywhere between February and April, and
// redraft leagues later still, so "it's 2027 now" says nothing about whether
// any particular league has a 2027 home yet.
//
// Deliberately TYPE=league and not TYPE=rosters. A redraft league that HAS
// rolled over has no players on it until the draft, so an empty-roster test
// would strand exactly those leagues on last season all summer. The league
// record exists the moment the commissioner rolls over, which is the thing
// actually being asked about.
//
// Returns false rather than throwing: "not there yet" is the expected answer
// for most of the year, not an error.
//
// Verified against the real API via .github/workflows/probe-league-season.yml
// (league 26696, seasons 2026 and 2028): a season the league is in returns
// {encoding, league, version} with league.id and league.name populated; a
// season it isn't in returns a clean HTTP 404. mflGet retries 429 and nothing
// else, so that 404 throws immediately rather than burning three round trips —
// a negative probe costs one fast request. The data.error check below never
// fired, and is kept only because it costs nothing and fails in the safe
// direction (a false negative just leaves a league where it already was).
export async function mflLeagueExists(league, cookie, season) {
  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, season);
    // A 200 is not the same as a league. Confirmed in the wild against a league
    // whose new season hadn't been set up: the request answers fine and carries
    // no usable league record, which is why this checks the body rather than
    // trusting the status.
    if (data?.error) return false;
    return Boolean(data?.league?.id || data?.league?.name);
  } catch (err) {
    // 404 is MFL's definitive "no such league-season". Anything else — a 429
    // from the probe burst, a network blip — means we simply don't know, and
    // null says so. That distinction matters because the caller acts on false
    // by walking a league back a season; it must never do that on a hiccup.
    if (err.status === 404) return false;
    return null;
  }
}

// ESPN keeps the same league id across seasons, so the same question is
// answerable the same way — expected to 404 on a season the league isn't in.
//
// Confirmed alongside MFL via probe-league-season.yml (league 1966972, seasons
// 2026 and 2028): a season the league is in returns a body with id, seasonId
// and settings; a season it isn't in returns HTTP 404 with a JSON
// GENERAL_NOT_FOUND payload, which espnGet turns into a throw.
//
// One caveat MFL doesn't have, and it survives that verification: ESPN reads
// are cookie-authenticated, so expired espn_s2/SWID make every season fail,
// which reads here as "doesn't exist" for all of them. Safe — the league stays
// where it is and is never dragged backwards — but it means an ESPN league
// would silently never roll over. Two things catch it: the roster fetch for
// that league would be erroring on its card anyway, and the probe treats a
// false control season as a hard failure for exactly this reason.
//
// Sleeper has no equivalent and deliberately isn't probed: there, a new season
// is a whole new league id and the old one keeps answering forever, so nothing
// can be inferred from a request succeeding. Those stay put until the id is
// edited in the Admin tab, which is the desired behaviour anyway.
export async function espnLeagueExists(league, season) {
  try {
    const data = await espnGet({ ...league, season }, 'view=mSettings');
    return Boolean(data?.id || data?.settings);
  } catch (err) {
    // Same tri-state as MFL, and it earns its keep here: a 401 from expired
    // espn_s2/SWID now reads as "don't know" rather than "the season is gone",
    // so stale cookies can't walk an ESPN league backwards. Missing cookies
    // throw before any request and carry no status, which lands here too.
    if (err.status === 404) return false;
    return null;
  }
}

// --- Scoring format detection -------------------------------------------
//
// config/leagues.json's `scoring` picks which FantasyPros list the ECR column
// is drawn from, and that choice comes down to a single number: what a
// reception is worth. 1 is PPR, 0.5 is half, 0 (or no rule at all) is standard.
// Every provider publishes it, so it never needs to be transcribed from a rules
// document by hand.
//
// Anything that isn't one of those three values returns null rather than being
// rounded to the nearest. FantasyPros publishes exactly three lists; a league
// scoring 0.25 or 1.5 per catch isn't any of them, and guessing would put the
// ECR column quietly on the wrong one.
export function receptionPointsToFormat(points) {
  if (points == null || !Number.isFinite(points)) return null;
  if (points === 0) return 'STD';
  if (points === 0.5) return 'HALF';
  if (points === 1) return 'PPR';
  return null;
}

// MFL's exports come from XML, so every leaf is wrapped as {$t: "value"} and a
// single-element list arrives as a bare object rather than an array.
const mflText = (v) => (v && typeof v === 'object' ? v.$t : v);
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// The positions a reception rate has to describe. QB and PK can technically be
// credited a catch and Def never is, so including them would let a rule that
// covers nobody relevant outvote the one that covers everybody.
const RECEIVING_POSITIONS = ['RB', 'WR', 'TE'];

// TYPE=rules, verified against the real API (probe-league-scoring.yml):
//   rules.positionRules[] = { positions: "QB|RB|WR|TE|PK", rule: [ ... ] }
//   rule[]                = { event: {$t:"CC"}, points: {$t:"*1"}, range: {...} }
// CC is the catch/reception event. The leading * on points means "per event",
// which is exactly the per-reception rate wanted here.
//
// Rules are scoped to position groups, so a league with a TE premium carries two
// CC rules at different rates — nine of these eighteen leagues do. The rate that
// describes the league is the one most receiving positions actually get, so this
// counts positions rather than rules: RB and WR on 0.5 with TE on 1.0 is a half-PPR
// league with a TE premium, not a coin flip. Ties go to the lower rate, since a
// premium is the thing added on top.
export async function fetchMflReceptionPoints(league, cookie) {
  const data = await mflGet(`/export?TYPE=rules&L=${league.id}&JSON=1`, cookie, seasonOf(league));
  // position -> rate, so each receiving position is counted exactly once even
  // when it appears in more than one group.
  const byPosition = new Map();
  const detail = [];
  for (const group of asArray(data?.rules?.positionRules)) {
    const positions = String(mflText(group?.positions) ?? '').split('|').map((x) => x.trim());
    const covered = positions.filter((x) => RECEIVING_POSITIONS.includes(x));
    for (const rule of asArray(group?.rule)) {
      if (mflText(rule?.event) !== 'CC') continue;
      const n = Number(String(mflText(rule?.points) ?? '').replace(/^\*/, ''));
      if (!Number.isFinite(n)) continue;
      detail.push({ positions: positions.join('|'), points: n });
      for (const pos of covered) byPosition.set(pos, n);
    }
  }
  // No reception rule for any receiving position is a real answer, not a
  // failure: that's standard scoring.
  if (byPosition.size === 0) return { points: 0, values: detail.map((d) => d.points), detail };

  const counts = new Map();
  for (const rate of byPosition.values()) counts.set(rate, (counts.get(rate) || 0) + 1);
  const points = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return { points, values: [...byPosition.values()], detail, byPosition: Object.fromEntries(byPosition) };
}

// statId 53 is receptions. An absent item means the league scores none.
export async function fetchEspnReceptionPoints(league) {
  const data = await espnGet(league, 'view=mSettings');
  const items = data?.settings?.scoringSettings?.scoringItems || [];
  const rec = items.find((i) => i.statId === 53);
  const points = rec ? Number(rec.points) : 0;
  return { points: Number.isFinite(points) ? points : null, values: rec ? [points] : [] };
}

// scoring_settings.rec. Note bonus_rec_te and rec_fd sit alongside it — those
// are bonuses on top, not the base rate, so they're deliberately ignored.
export async function fetchSleeperReceptionPoints(league) {
  const data = await sleeperGet(`/league/${league.id}`);
  const rec = data?.scoring_settings?.rec;
  const points = rec == null ? 0 : Number(rec);
  return { points: Number.isFinite(points) ? points : null, values: [points] };
}

// { format, points, values } — format is null when the league doesn't map onto
// one of FantasyPros' three lists, which is the caller's cue to leave it alone.
export async function detectScoringFormat(league, cookie) {
  const provider = league.provider || 'mfl';
  const read = provider === 'espn'
    ? fetchEspnReceptionPoints(league)
    : provider === 'sleeper'
    ? fetchSleeperReceptionPoints(league)
    : fetchMflReceptionPoints(league, cookie);
  // Spread rather than repack: the per-position breakdown is the evidence for
  // the base rate, and dropping it here left the probe printing "undefined"
  // for exactly the nine leagues whose answer most needed checking.
  const info = await read;
  return { ...info, format: receptionPointsToFormat(info.points) };
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

// What MFL carries about an injury beyond the designation itself: a body part
// and an expected return date, both of which probe-injury-detail.yml found
// filled on 325 of 325 rows. Pure, and separate from the fetch, so the parsing
// rules below are testable without reaching MFL (scripts/test-injury-detail.mjs).
//
// Two of those rules are judgement rather than transcription:
//
// `details` reads "Undisclosed" for a large share of the report, which is the
// feed saying it doesn't know. Printing that word under a player's name spends
// a line to say nothing, so it becomes no detail at all — the same distinction
// the page draws everywhere else between "nothing to report" and "not asked".
//
// `exp_return` is kept verbatim as a string rather than parsed into a date.
// The page decides whether a return date is worth showing at all (it carries a
// season-end sentinel for retired and season-ending cases), and a date that
// crossed the sync as a Date would arrive there as an ISO timestamp claiming a
// precision the feed doesn't have.
export function injuryEntryFromRow(row) {
  const status = normalizeInjuryStatus(row?.status);
  if (!status) return null;
  const rawPart = String(row?.details ?? '').trim();
  const part = rawPart && rawPart.toLowerCase() !== 'undisclosed' ? rawPart : null;
  const until = String(row?.exp_return ?? '').trim() || null;
  return { status, detail: part || until ? { part, until } : null };
}

// NFL injury report, keyed by MFL player id — like fetchNflByeWeeks, a
// plain NFL-schedule-adjacent fact rather than anything league-specific, so
// one global call per sync instead of once per league. MFL's TYPE=injuries
// doesn't take a league param at all.
export async function fetchMflInjuries(cookie) {
  const data = await mflGet('/export?TYPE=injuries&JSON=1', cookie);
  const rawRows = data?.injuries?.injury;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];
  const map = new Map();
  for (const r of rows) {
    const entry = injuryEntryFromRow(r);
    if (entry) map.set(r.id, entry);
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
    cookie,
    seasonOf(league)
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
  const priorYear = Number(seasonOf(league)) - 1;
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

// Auction/salary-cap leagues only. TYPE=salaryAdjustments returns the whole
// league's adjustment history (drops, carry-overs, etc.) regardless of the
// FRANCHISE param, so this fetches once and sums the entries that belong to
// our franchise — matches the "Salary Adjustments" total MFL's own UI shows.
async function fetchSalaryAdjustments(league, cookie) {
  const data = await mflGet(`/export?TYPE=salaryAdjustments&L=${league.id}&JSON=1`, cookie, seasonOf(league));
  const rawRows = data?.salaryAdjustments?.salaryAdjustment;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];
  return rows
    .filter((r) => r.franchise_id === league.franchiseId)
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
}

// Starting-lineup slot requirements (e.g. "1 QB, 2-3 RB, 2-3 WR, 1-2 TE, 1
// PK, 1 Def"), parsed from TYPE=league's `starters.position` node — the
// same league export fetchLeagueRoster already fetches for franchise/team
// info, just a different part of it. A slot's own `limit` can already be a
// range ("2-3") for a single position; a slot whose `name` joins multiple
// positions with "+" (e.g. "RB+WR+TE") is a genuine flex spot — it widens
// every position it's eligible for by its own max, without lowering any of
// their already-established minimums (a flex slot is optional on top of
// the dedicated ones, not a second guaranteed starter at every position it
// could fill).
// The same starters node, parsed for arithmetic instead of display: the
// generic slot shape the power score fills ([{ positions, count }], see
// computePowerScore in lib/fantasypros.mjs — the shape lives as plain data
// precisely so this file never has to import that one; api/ imports this
// file and vercel.json's ignoreCommand doesn't list fantasypros.mjs).
//
// Dedicated slots contribute their *minimum* — the guaranteed starters — and
// two kinds of flex sit on top: slots whose name joins positions with "+"
// (a literal flex spot, counted at its max), and the gap between
// `starters.count` (the true lineup size, when MFL provides it) and
// everything already accounted for, eligible to any skill position whose
// own range has headroom (max > min). That gap is how "1 QB, 2-3 RB, 2-3
// WR, 1-2 TE, 1 PK, 1 Def / count 9" becomes one flex slot rather than
// being lost to the min-sum. Without a count the mins stand alone — an
// undercount, but the same undercount for every franchise in the league,
// which is the only property the ordinal needs.
//
// Kicker/defense/IDP slots never become entries (see POWER_POSITIONS for
// why), but their minimums still count against `starters.count`, or the gap
// would hand their slots to flex.
const POWER_SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

export function startingSlotCounts(leagueData) {
  const rawSlots = leagueData?.league?.starters?.position;
  const slots = Array.isArray(rawSlots) ? rawSlots : rawSlots ? [rawSlots] : [];
  if (slots.length === 0) return null;

  const dedicated = new Map(); // position -> { min, max }
  const flexSlots = [];
  for (const slot of slots) {
    const positions = String(slot.name || '').split('+').map((s) => s.trim()).filter(Boolean);
    if (positions.length === 0) continue;
    const [minStr, maxStr] = String(slot.limit ?? '').split('-');
    const min = Number(minStr) || 0;
    const max = maxStr !== undefined ? (Number(maxStr) || min) : min;
    if (min === 0 && max === 0) continue;
    if (positions.length === 1) {
      const existing = dedicated.get(positions[0]) || { min: 0, max: 0 };
      dedicated.set(positions[0], { min: existing.min + min, max: existing.max + max });
    } else {
      flexSlots.push({ positions, count: max });
    }
  }

  const entries = [];
  let accounted = 0;
  for (const [pos, { min }] of dedicated) {
    accounted += min;
    if (POWER_SKILL_POSITIONS.has(pos) && min > 0) entries.push({ positions: [pos], count: min });
  }
  for (const f of flexSlots) {
    accounted += f.count;
    const skill = f.positions.filter((p) => POWER_SKILL_POSITIONS.has(p));
    if (skill.length > 0 && f.count > 0) entries.push({ positions: skill, count: f.count });
  }

  const total = Number(leagueData?.league?.starters?.count);
  if (Number.isFinite(total) && total > accounted) {
    const eligible = [...dedicated]
      .filter(([pos, { min, max }]) => POWER_SKILL_POSITIONS.has(pos) && max > min)
      .map(([pos]) => pos);
    if (eligible.length > 0) entries.push({ positions: eligible, count: total - accounted });
  }

  return entries.length > 0 ? entries : null;
}

// Sleeper spells the whole lineup out as a flat array on the league object
// the roster fetch already has — ["QB","RB","RB","WR","WR","TE","FLEX",
// "SUPER_FLEX",...] — so this is a vocabulary mapping, not a request.
// Bench/reserve/taxi rows and kicker/defense/IDP slots are dropped for the
// same reasons as everywhere else in the power score.
const SLEEPER_FLEX_POSITIONS = {
  FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  WRRB_FLEX: ['WR', 'RB'],
  REC_FLEX: ['WR', 'TE'],
};

export function slotsFromSleeperRosterPositions(rosterPositions) {
  if (!Array.isArray(rosterPositions) || rosterPositions.length === 0) return null;
  const counts = new Map();
  for (const raw of rosterPositions) {
    const slot = String(raw || '').toUpperCase();
    const positions = POWER_SKILL_POSITIONS.has(slot) ? [slot] : SLEEPER_FLEX_POSITIONS[slot];
    if (!positions) continue;
    const key = positions.join('+');
    const existing = counts.get(key) || { positions, count: 0 };
    existing.count++;
    counts.set(key, existing);
  }
  const entries = [...counts.values()];
  return entries.length > 0 ? entries : null;
}

export function formatStartingLineupRequirement(leagueData) {
  const rawSlots = leagueData?.league?.starters?.position;
  const slots = Array.isArray(rawSlots) ? rawSlots : rawSlots ? [rawSlots] : [];
  if (slots.length === 0) return null;

  const dedicated = new Map(); // position -> { min, max }
  const flexMax = new Map(); // position -> extra max contributed by flex slots

  for (const slot of slots) {
    const positions = String(slot.name || '').split('+').map((s) => s.trim()).filter(Boolean);
    if (positions.length === 0) continue;
    const [minStr, maxStr] = String(slot.limit ?? '').split('-');
    const min = Number(minStr) || 0;
    const max = maxStr !== undefined ? (Number(maxStr) || min) : min;
    if (min === 0 && max === 0) continue;

    if (positions.length === 1) {
      const pos = positions[0];
      const existing = dedicated.get(pos) || { min: 0, max: 0 };
      dedicated.set(pos, { min: existing.min + min, max: existing.max + max });
    } else {
      for (const pos of positions) {
        flexMax.set(pos, (flexMax.get(pos) || 0) + max);
      }
    }
  }

  const allPositions = new Set([...dedicated.keys(), ...flexMax.keys()]);
  const parts = [...allPositions]
    .sort((a, b) => positionRank(a) - positionRank(b))
    .map((pos) => {
      const ded = dedicated.get(pos) || { min: 0, max: 0 };
      const totalMax = ded.max + (flexMax.get(pos) || 0);
      if (ded.min === 0 && totalMax === 0) return null;
      return ded.min === totalMax ? `${ded.min} ${pos}` : `${ded.min}-${totalMax} ${pos}`;
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}

// The players on one franchise's roster, as MFL's XML-derived JSON leaves
// them: absent when the franchise is empty, a bare object when it holds
// exactly one player, an array otherwise.
function mflRosterPlayers(franchise) {
  const raw = franchise?.player;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// Every player held by any franchise in the league — the complement of the
// free agent pool, which is what the Top Available card is derived from: a
// player is available only if *nobody* in the league has him, and our own
// roster cannot answer that. Names rather than ids because that is what the
// ranking lists join on; see normalizePlayerName in lib/fantasypros.mjs.
//
// This is its own request, made in its own late pass by fetch-rosters.mjs,
// rather than a widening of the FRANCHISE-scoped export in fetchLeagueRoster.
// Widening that one looked free — same endpoint, same request count — but the
// league-wide export is a much heavier response, and the first sync to try it
// spent enough of MFL's rate limit that three scoring fetches and a lineup
// fetch behind it came back 429. Availability is the least important thing
// this sync collects, so it goes last and it is the thing that degrades.
// Returns `{ names, franchises }` — the flat name list availability joins on,
// and the same players grouped per franchise, which is what the power score
// grades. One response, parsed one level deeper; the second consumer is why
// this stopped returning a bare array. Franchise player ids here are MFL's
// own, the same id space the projections' `mflid` lives in — the join the
// power score leans on.
export async function fetchMflRosteredNames(league, cookie, playerMap) {
  const data = await mflGet(`/export?TYPE=rosters&L=${league.id}&JSON=1`, cookie, seasonOf(league));

  const rawFranchises = Array.isArray(data?.rosters?.franchise)
    ? data.rosters.franchise
    : data?.rosters?.franchise
    ? [data.rosters.franchise]
    : [];

  const names = [];
  const franchises = [];
  for (const f of rawFranchises) {
    const players = [];
    for (const p of mflRosterPlayers(f)) {
      const name = playerMap.get(p.id)?.name;
      if (!name) continue;
      names.push(name);
      players.push({ id: String(p.id), name });
    }
    franchises.push({ franchiseId: String(f.id), players });
  }
  return names.length > 0 ? { names, franchises } : null;
}

// Whether a league's draft has finished, read from MFL's TYPE=draftResults.
//
// The signal, verified against the real API by probe-draft-status.yml: MFL
// returns *every* pick in the draft, and an unmade one comes back with an
// empty `player` and an empty `timestamp`. So one unmade pick means the draft
// is not done. August Judgment Day returned 216 picks — 65 made, 151 unmade —
// while four settled leagues returned every pick filled (216/0, 180/0, 41/0,
// 41/0). No timestamps or roster-size guessing needed.
//
// `null` means "couldn't tell", which is its own answer and must not be
// confused with "not finished": a league with no draft scheduled returns zero
// picks (Worlds Collide does), and so does one whose draft MFL simply doesn't
// carry. Those keep their wire rather than being hidden on a guess.
//
// Split from the fetch so the parsing can be pinned by a test — the shapes
// here are undocumented and unreachable from a sandbox, so the fixtures in
// scripts/test-draft-status.mjs are copied from what the probe actually
// printed.
export function draftStatusFromResults(data) {
  const unit = data?.draftResults?.draftUnit;
  // A league can run more than one draft unit (a per-division draft, say).
  // Every one of them has to be finished for the league to be finished.
  const units = Array.isArray(unit) ? unit : unit ? [unit] : [];

  let made = 0;
  let unmade = 0;
  for (const u of units) {
    const raw = u?.draftPick;
    const picks = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const pick of picks) {
      if (pick?.player) made++;
      else unmade++;
    }
  }

  if (made + unmade === 0) return null;
  return { made, unmade, complete: unmade === 0 };
}

export async function fetchMflDraftStatus(league, cookie) {
  const data = await mflGet(`/export?TYPE=draftResults&L=${league.id}&JSON=1`, cookie, seasonOf(league));
  return draftStatusFromResults(data);
}

// Sleeper says so directly on the league object the roster fetch already has
// in hand, so this costs nothing. Its lifecycle runs pre_draft -> drafting ->
// in_season -> complete; the first two are the ones with an unfinished draft.
// An unrecognised or missing status is "couldn't tell", same as MFL's.
const SLEEPER_UNDRAFTED = new Set(['pre_draft', 'drafting']);

export function sleeperDraftInProgress(status) {
  if (!status) return null;
  return SLEEPER_UNDRAFTED.has(String(status));
}

export async function fetchLeagueRoster(league, cookie, playerMap, byeWeeks, injuries) {
  const [leagueData, rostersData] = await Promise.all([
    mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league)),
    mflGet(`/export?TYPE=rosters&L=${league.id}&FRANCHISE=${league.franchiseId}&JSON=1`, cookie, seasonOf(league)),
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

  const rawPlayers = mflRosterPlayers(rosterFranchise);

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
      injuryStatus: injuries?.get(p.id)?.status ?? null,
      // Exact, by MFL player id. Every other provider's rosters have to reach
      // this same report by name instead — see attachInjuryDetail in
      // fetch-rosters.mjs, which is where the two sides can be joined without
      // providers.mjs taking a dependency on fantasypros.mjs (api/ imports
      // this file, and vercel.json's ignoreCommand doesn't cover that one).
      injuryDetail: injuries?.get(p.id)?.detail ?? null,
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

  // Salary cap totals: only meaningful for salary-cap leagues. The cap amount
  // comes off the league export we already fetched above; salary adjustments
  // needs its own request. This used to key off a separate `format: 'auction'`
  // field that always agreed with the type, so the type alone drives it now.
  let salaryCap = null;
  let salaryAdjustments = null;
  if (league.type === 'salarycap') {
    const capAmount = leagueData?.league?.salaryCapAmount;
    salaryCap = capAmount ? Number(capAmount) : null;
    try {
      salaryAdjustments = await fetchSalaryAdjustments(league, cookie);
    } catch (err) {
      console.error(`Failed to fetch salary adjustments for ${league.name}: ${err.message}`);
    }
  }

  let startingLineup = null;
  let lineupSlots = null;
  try {
    startingLineup = formatStartingLineupRequirement(leagueData);
    // The arithmetic version of the same node, for the power score. Never
    // written to data/rosters.json — fetch-rosters.mjs consumes it in the
    // same run and deletes it before the file is written.
    lineupSlots = startingSlotCounts(leagueData);
  } catch (err) {
    console.error(`Failed to parse starting lineup requirements for ${league.name}: ${err.message}`);
  }

  return {
    id: league.id,
    name: league.name,
    type: league.type,
    leagueName: leagueData?.league?.name || league.name,
    franchiseId: league.franchiseId,
    teamName: franchiseInfo?.name || league.name,
    url: leagueUrl(league),
    players,
    salaryCap,
    salaryAdjustments,
    startingLineup,
    lineupSlots,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

export async function fetchStandings(league, cookie) {
  const [leagueData, standingsData] = await Promise.all([
    mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league)),
    mflGet(`/export?TYPE=leagueStandings&L=${league.id}&JSON=1`, cookie, seasonOf(league)),
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
  const leagueData = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league));
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
    mflGet(`/export?TYPE=liveScoring&L=${league.id}&JSON=1`, cookie, seasonOf(league)),
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
  const weeklyData = await mflGet(`/export?TYPE=weeklyResults&L=${league.id}&W=1&JSON=1`, cookie, seasonOf(league));
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

// Submits a starting lineup for the given week. Confirmed against MFL's own
// interactive API-test docs (api_info?STATE=test&CCAT=import&TYPE=lineup):
// TYPE is "lineup", not "setLineup" — that earlier guess was rejected
// outright ("Invalid Data Type"). Required: L, W, STARTERS (comma-separated
// player ids). FRANCHISE_ID must be OMITTED here — confirmed via a live
// test error ("Can not specify a FRANCHISE_ID other than the owner's"):
// it's only for a commissioner acting on another owner's behalf, and our
// login IS the owner, so MFL infers the franchise automatically. Takes
// username/password directly (not a pre-existing cookie) because it needs
// its own league-scoped login — see mflLoginForImport. Like every /import
// call, this returns XML regardless of JSON=1, so fetch as text.
export async function submitMflLineup(username, password, league, starterIds, week) {
  const season = seasonOf(league);
  const { cookie, host } = await mflLoginForImport(username, password, league.id, season);
  const url = `https://${host}/${season}/import?TYPE=lineup&L=${league.id}&W=${week}&STARTERS=${starterIds.join(',')}&JSON=1`;
  const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'follow' });
  const bodyText = await res.text();
  return { status: res.status, ok: res.ok, bodyText, host };
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
  let url = `${espnBase(seasonOf(league))}/${league.id}?${viewParams}`;

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
    const err = new Error(`ESPN request failed (${res.status}) at ${url}: ${bodyText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
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
        injuryStatus: normalizeInjuryStatus(p.injuryStatus),
      };
    })
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));

  return {
    id: league.id,
    name: league.name,
    type: league.type,
    leagueName: data.settings?.name || league.name,
    franchiseId: league.franchiseId,
    teamName: espnTeamName(team),
    url: leagueUrl(league),
    players,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

// The ESPN half of fetchMflRosteredNames, and a second request for the same
// reason it is on MFL — plus one of its own: the roster fetch above pins
// rosterForTeamId to get its entries populated at all, and dropping that is
// exactly the sort of change that can't be verified from here (see the
// comment on fetchEspnLeagueRoster). An empty answer is "don't know" rather
// than "nobody is rostered", since the unscoped view is suspected of
// returning empty entries.
// Shaped like fetchMflRosteredNames' answer for the same two consumers. ESPN
// player ids are ESPN's own, useless against the projections — the power
// score joins these by name.
export async function fetchEspnRosteredNames(league) {
  const data = await espnGet(league, 'view=mRoster&scoringPeriodId=1');
  const names = [];
  const franchises = [];
  for (const team of data.teams || []) {
    const players = [];
    for (const entry of team.roster?.entries || []) {
      const name = entry.playerPoolEntry?.player?.fullName;
      if (!name) continue;
      names.push(name);
      players.push({ id: String(entry.playerId ?? ''), name });
    }
    franchises.push({ franchiseId: String(team.id), players });
  }
  return names.length > 0 ? { names, franchises } : null;
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

// --- Sleeper ---
// Sleeper's API is fully public — no login, cookies, or API key needed for
// any of it, unlike MFL (login) or ESPN (espn_s2/SWID cookies).

const SLEEPER_BASE = 'https://api.sleeper.app/v1';

async function sleeperGet(path) {
  const res = await fetch(`${SLEEPER_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Sleeper request failed (${res.status}): ${path}`);
  }
  return res.json();
}

// Sleeper's full player database (~12k players) — fetch once and share
// across every Sleeper league in a sync, same role as loadPlayerMap (MFL).
export async function loadSleeperPlayerMap() {
  const data = await sleeperGet('/players/nfl');
  const map = new Map();
  for (const [id, p] of Object.entries(data)) {
    map.set(id, {
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || `Unknown Player (${id})`,
      position: (p.fantasy_positions && p.fantasy_positions[0]) || p.position || '',
      team: p.team || 'FA',
      injuryStatus: normalizeInjuryStatus(p.injury_status),
    });
  }
  return map;
}

// users + rosters have to be joined to get a display team name — Sleeper
// rosters only carry an owner_id, the team name lives on the user's
// metadata (or falls back to their display name).
async function sleeperTeamNames(league) {
  const [users, rosters] = await Promise.all([
    sleeperGet(`/league/${league.id}/users`),
    sleeperGet(`/league/${league.id}/rosters`),
  ]);
  const userById = new Map(users.map((u) => [u.user_id, u]));
  const names = new Map();
  for (const r of rosters) {
    const user = userById.get(r.owner_id);
    names.set(String(r.roster_id), user?.metadata?.team_name || user?.display_name || `Team ${r.roster_id}`);
  }
  return { names, rosters };
}

// MFL's nflByeWeeks map (shared with the MFL sync — bye weeks are a plain
// NFL-schedule fact, not provider-specific) is keyed by MFL's own team
// codes, which use non-standard 3-letter abbreviations for 8 teams. Sleeper
// uses the standard codes for all of them. Confirmed against MFL's actual
// TYPE=nflByeWeeks team list — every other team's code already matches.
const SLEEPER_TEAM_TO_MFL_BYE_KEY = {
  GB: 'GBP',
  JAX: 'JAC',
  KC: 'KCC',
  LV: 'LVR',
  NE: 'NEP',
  NO: 'NOS',
  SF: 'SFO',
  TB: 'TBB',
};

// Sleeper doesn't expose season-to-date fantasy points directly, but each
// week's matchups response includes players_points — every rostered
// player's score for that week, already computed under this league's own
// scoring settings. Summing those across every completed week gives the
// same "season points under this league's rules" that MFL/ESPN show,
// without needing to pull raw stats and reimplement scoring ourselves.
export async function fetchSleeperSeasonPoints(league) {
  const state = await sleeperGet('/state/nfl');
  // Preseason: state.week is 0 and nothing has been played yet.
  const lastCompletedWeek = state.week > 0 ? state.week : 0;
  if (lastCompletedWeek === 0) return new Map();

  const weeklyMatchups = await Promise.all(
    Array.from({ length: lastCompletedWeek }, (_, i) => sleeperGet(`/league/${league.id}/matchups/${i + 1}`))
  );

  const totals = new Map();
  for (const matchups of weeklyMatchups) {
    for (const m of matchups || []) {
      for (const [playerId, points] of Object.entries(m.players_points || {})) {
        totals.set(playerId, (totals.get(playerId) || 0) + (Number(points) || 0));
      }
    }
  }
  return totals;
}

export async function fetchSleeperLeagueRoster(league, playerMap, byeWeeks) {
  const [leagueData, { names, rosters }, seasonPoints] = await Promise.all([
    sleeperGet(`/league/${league.id}`),
    sleeperTeamNames(league),
    fetchSleeperSeasonPoints(league).catch(() => new Map()),
  ]);

  const roster = rosters.find((r) => String(r.roster_id) === String(league.franchiseId));
  if (!roster) {
    throw new Error(`No roster ${league.franchiseId} found in Sleeper league ${league.id}`);
  }

  const taxiSet = new Set((roster.taxi || []).map(String));
  const reserveSet = new Set((roster.reserve || []).map(String));

  const players = (roster.players || [])
    .map((id) => {
      const info = playerMap.get(String(id)) || {};
      let status = 'ROSTER';
      if (reserveSet.has(String(id))) status = 'INJURED_RESERVE';
      else if (taxiSet.has(String(id))) status = 'TAXI_SQUAD';
      const byeKey = SLEEPER_TEAM_TO_MFL_BYE_KEY[info.team] || info.team;
      return {
        id: String(id),
        name: info.name || `Unknown Player (${id})`,
        position: info.position || '',
        team: info.team || 'FA',
        bye: byeWeeks?.get(byeKey) ?? null,
        pts: seasonPoints.has(String(id)) ? seasonPoints.get(String(id)) : null,
        status,
        injuryStatus: info.injuryStatus ?? null,
      };
    })
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));

  return {
    id: league.id,
    name: league.name,
    type: league.type,
    leagueName: leagueData.name || league.name,
    franchiseId: league.franchiseId,
    teamName: names.get(String(league.franchiseId)) || league.name,
    url: leagueUrl(league),
    players,
    // Free with the rosters we already have in hand — sleeperTeamNames
    // fetches every roster in the league, not just ours.
    rosteredNames: rosters.flatMap((r) =>
      (r.players || []).map((id) => playerMap.get(String(id))?.name).filter(Boolean)
    ),
    // The per-franchise view of the same rosters, for the power score — which
    // is why Sleeper's power refreshes every sync while MFL/ESPN's follow the
    // once-a-day roster read. Ids here are Sleeper's, which look exactly like
    // MFL ids (small numeric strings) and must never be joined as them; the
    // power score joins these by name (see computeLeaguePower's joinById).
    rosterFranchises: rosters.map((r) => ({
      franchiseId: String(r.roster_id),
      players: (r.players || [])
        .map((id) => ({ id: String(id), name: playerMap.get(String(id))?.name }))
        .filter((p) => p.name),
    })),
    // Sleeper also spells out the lineup slots on the league object — again
    // free, and consumed/deleted by fetch-rosters.mjs like lineupSlots on MFL.
    lineupSlots: slotsFromSleeperRosterPositions(leagueData.roster_positions),
    // Also free: it's a field on the league object fetched above. MFL needs
    // its own request for the same answer.
    draftInProgress: sleeperDraftInProgress(leagueData.status),
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

export async function fetchSleeperStandings(league) {
  const { names, rosters } = await sleeperTeamNames(league);
  if (rosters.length === 0) {
    throw new Error('No standings data returned for this league');
  }

  return rosters
    .map((r) => {
      const pointsFor = Number(r.settings?.fpts ?? 0) + Number(r.settings?.fpts_decimal ?? 0) / 100;
      const pointsAgainst = Number(r.settings?.fpts_against ?? 0) + Number(r.settings?.fpts_against_decimal ?? 0) / 100;
      return {
        franchiseId: String(r.roster_id),
        teamName: names.get(String(r.roster_id)) || `Team ${r.roster_id}`,
        wins: r.settings?.wins ?? 0,
        losses: r.settings?.losses ?? 0,
        ties: r.settings?.ties ?? 0,
        pointsFor: pointsFor.toFixed(2),
        pointsAgainst: pointsAgainst.toFixed(2),
        isMe: String(r.roster_id) === String(league.franchiseId),
      };
    })
    .sort((a, b) => b.wins - a.wins || Number(b.pointsFor) - Number(a.pointsFor));
}

export async function fetchSleeperScoring(league) {
  const [state, { names }] = await Promise.all([
    sleeperGet('/state/nfl'),
    sleeperTeamNames(league),
  ]);
  const week = state.week > 0 ? state.week : state.display_week;
  if (!week) {
    throw new Error('No live scoring available yet');
  }

  const matchups = await sleeperGet(`/league/${league.id}/matchups/${week}`);
  if (!matchups || matchups.length === 0) {
    throw new Error('No live scoring available yet');
  }

  const teams = matchups
    .map((m) => ({
      franchiseId: String(m.roster_id),
      teamName: names.get(String(m.roster_id)) || `Team ${m.roster_id}`,
      score: m.points ?? 0,
      isMe: String(m.roster_id) === String(league.franchiseId),
    }))
    .sort((a, b) => b.score - a.score)
    .map((t) => ({ ...t, score: t.score.toFixed(2) }));

  return { week, teams };
}

// Read-only: which of the franchise's players are currently set as
// starters. Unlike fetchMflLineup, this is never paired with a submit
// function — Sleeper's public API has no lineup-write endpoint (confirmed
// against their own docs: "This is a read only API. At this time, there's
// no write API access."), so myffl.html only ever renders this for
// display, never with a Save/Submit control. Same week-resolution as
// fetchSleeperScoring (display_week covers preseason, before state.week
// ticks past 0) — falling back further to week 1 when even display_week
// is still unset, same known-limitation tradeoff fetchMflLineup already
// makes for MFL. Confirmed necessary in practice: SFB16 runs its own Week
// 1 during the NFL preseason, ahead of Sleeper's global state ticking
// over at all, so without this fallback its lineup never resolves even
// once a manager has actually set one. Pilot feature: only called for
// leagues flagged lineupPilot in config/leagues.json.
export async function fetchSleeperLineup(league) {
  const state = await sleeperGet('/state/nfl');
  const week = state.week > 0 ? state.week : (state.display_week || 1);

  const matchups = await sleeperGet(`/league/${league.id}/matchups/${week}`);
  const mine = (matchups || []).find((m) => String(m.roster_id) === String(league.franchiseId));
  if (!mine) {
    throw new Error(`No matchup data for roster ${league.franchiseId} in week ${week}`);
  }

  // Sleeper represents an empty starting slot as the literal string "0",
  // not an omitted entry — filter those out along with any other falsy id.
  const starterIds = (mine.starters || []).filter((id) => id && id !== '0').map(String);
  return { week: String(week), starterIds };
}
