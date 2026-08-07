// FantasyPros consensus rankings (ECR) enrichment, layered on top of the
// rosters the MFL/ESPN/Sleeper providers already fetched.
//
// Public API: https://api.fantasypros.com/public/v2/json — needs a
// FANTASYPROS_API_KEY env var (a GitHub Actions secret; request a key at
// https://secure.fantasypros.com/api-keys/request/). When that key is
// absent this module is a deliberate no-op: the sync writes rosters exactly
// as it does today and players simply carry no `ecr` field. FantasyPros is
// an enrichment here, never a dependency of the sync.
//
// HOW PLAYERS ARE MATCHED — the consensus-rankings response identifies
// players only by FantasyPros' own IDs (player_id, yahoo, cbs,
// sportsdata), so there is nothing on it to join our MFL/ESPN/Sleeper
// roster IDs against. The separate /nfl/players endpoint can emit foreign
// IDs via ?external_ids=mfl:espn, but it (a) has no Sleeper IDs at all,
// which would leave that provider unmatched regardless, and (b) would cost
// an extra ~8,600-player fetch every sync. Matching on a hard-normalized
// name works uniformly across all three providers off the one request we
// already make. Names that map to more than one ranked player are
// disambiguated by position, then by NFL team; anything still ambiguous is
// left unmatched rather than guessed at.

const FP_BASE = 'https://api.fantasypros.com/public/v2/json';

export function fantasyProsApiKey() {
  return process.env.FANTASYPROS_API_KEY || null;
}

// MFL, ESPN and Sleeper each spell a few positions differently. Fold them
// onto FantasyPros' vocabulary so position is usable as a tiebreaker.
const POSITION_ALIASES = {
  PK: 'K',
  PN: 'P',
  DEF: 'DST',
  'D/ST': 'DST',
};

function canonicalPosition(pos) {
  if (!pos) return '';
  const up = String(pos).toUpperCase();
  return POSITION_ALIASES[up] || up;
}

// MFL uses its own 3-letter code for eight teams; FantasyPros uses the
// standard abbreviations. Same list the Sleeper bye-week join already
// relies on, in the opposite direction.
const MFL_TEAM_TO_STANDARD = {
  GBP: 'GB',
  JAC: 'JAX',
  KCC: 'KC',
  LVR: 'LV',
  NEP: 'NE',
  NOS: 'NO',
  SFO: 'SF',
  TBB: 'TB',
};

function canonicalTeam(team) {
  if (!team) return '';
  const up = String(team).toUpperCase();
  return MFL_TEAM_TO_STANDARD[up] || up;
}

// Suffixes are spelled inconsistently across sources ("Marvin Harrison
// Jr." vs "Marvin Harrison") and never distinguish two active players, so
// they're dropped. Looped to catch a stacked "Jr. II".
const NAME_SUFFIX = /\s+(jr|sr|ii|iii|iv|v)$/;

export function normalizePlayerName(raw) {
  if (!raw) return '';
  let s = String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: Ekelér -> Ekeler
    .toLowerCase()
    .replace(/[.'’`]/g, '') // D.K. -> DK, O'Neal -> ONeal
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  while (NAME_SUFFIX.test(s)) s = s.replace(NAME_SUFFIX, '');
  return s;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fpGet(path, apiKey) {
  const res = await fetch(`${FP_BASE}${path}`, { headers: { 'x-api-key': apiKey } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FantasyPros request failed (${res.status}): ${path} — ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`FantasyPros returned non-JSON for ${path}: ${text.slice(0, 200)}`);
  }
}

function buildRankingIndex(players) {
  const byName = new Map();
  for (const p of players || []) {
    const key = normalizePlayerName(p.player_name);
    if (!key) continue;
    const entry = {
      ecr: toNumberOrNull(p.rank_ecr),
      posRank: p.pos_rank || null,
      tier: toNumberOrNull(p.tier),
      delta: toNumberOrNull(p.player_ecr_delta),
      position: canonicalPosition(p.player_position_id),
      team: canonicalTeam(p.player_team_id),
    };
    const existing = byName.get(key);
    if (existing) existing.push(entry);
    else byName.set(key, [entry]);
  }
  return byName;
}

function lookupPlayer(index, player) {
  const candidates = index.get(normalizePlayerName(player.name));
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const byPosition = candidates.filter((c) => c.position === canonicalPosition(player.position));
  if (byPosition.length === 1) return byPosition[0];

  const pool = byPosition.length > 0 ? byPosition : candidates;
  const byTeam = pool.filter((c) => c.team === canonicalTeam(player.team));
  return byTeam.length === 1 ? byTeam[0] : null;
}

// Where we are in the NFL calendar, computed from two rules rather than from a
// schedule lookup, so nothing has to be remembered or re-entered each year:
//
//   kickoff  — the Thursday after Labor Day (the first Monday in September)
//   flip-back — the Super Bowl, the second Sunday in February
//
// Both have held every year since the 17-game season arrived in 2021, and both
// are only used to pick between ranking sets, so being a day out at either edge
// costs nothing: draft and rest-of-season rankings barely disagree before a
// game has been played, and nothing at all is played the week after the Super
// Bowl. Note the Labor Day step — taking "the first Thursday in September"
// directly would be a week early whenever September starts on a Thursday.
//
// All UTC. The sync runs in UTC, and shifting these to Eastern would mean
// carrying a timezone table to move a boundary by a few hours in the middle of
// a week when nothing changes.
function nthWeekdayUtc(year, month, weekday, n) {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  return Date.UTC(year, month, 1 + offset + (n - 1) * 7);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// { inSeason, season } — season being the NFL season year, which is the
// calendar year everywhere except between New Year and the Super Bowl, when
// the season still running is the previous year's.
export function nflSeasonPhase(now = new Date()) {
  const year = now.getUTCFullYear();
  // First Monday in September, plus three days.
  const kickoff = nthWeekdayUtc(year, 8, 1, 1) + 3 * DAY_MS;
  // Second Sunday in February. The game ends around 03:00 UTC on the Monday,
  // so the day after is when the offseason has unambiguously begun.
  const offseasonBegins = nthWeekdayUtc(year, 1, 0, 2) + DAY_MS;
  const t = now.getTime();

  if (t >= kickoff) return { inSeason: true, season: year };
  if (t < offseasonBegins) return { inSeason: true, season: year - 1 };
  return { inSeason: false, season: year };
}

// The ranking set a league gets when config/leagues.json doesn't pin one.
//
// In season it's rest-of-season for everything, including dynasty: once real
// games are being played, preseason draft and dynasty lists go stale, and the
// question every lineup and waiver decision actually asks is who helps between
// now and the end of the year. Out of season it reverts to the list that
// matches how the league is run.
//
// The Dynasty sub-tab is the only one that gets dynasty rankings — salary-cap,
// draft-only and redraft all use draft rankings. Salary-cap leagues carry
// multi-year contracts and taxi squads, so putting them on draft rankings reads
// like an oversight. It isn't: they're managed on a redraft cadence here (the
// cap resets and the roster gets re-auctioned annually), so draft rankings match
// how the decisions actually get made. Don't "correct" this to follow roster
// mechanics — if a single league ever needs to differ, set rankingType on it in
// config/leagues.json, which also opts that league out of the seasonal flip
// entirely and pins it year-round.
export function automaticRankingType(league, now = new Date()) {
  if (nflSeasonPhase(now).inSeason) return 'ROS';
  return league.type === 'dynasty' ? 'DYNASTY' : 'DRAFT';
}

// Which ranking set a league is scored against. Scoring is overridable in
// config/leagues.json too.
//
// Superflex leagues rank QBs far higher than a 1-QB league does, which is
// exactly what FantasyPros' "OP" (offensive player) list represents. OP only
// covers offense, so those leagues fall back to the ALL list for kickers,
// defenses and IDP.
export function rankingSpecForLeague(league, now = new Date()) {
  const tags = Array.isArray(league.tags) ? league.tags : [];
  const isSuperflex = tags.some((t) => /superflex/i.test(String(t)));
  return {
    type: league.rankingType || automaticRankingType(league, now),
    // Explicit config wins; otherwise the format detected from the league's
    // own settings; PPR only as a last resort when detection found nothing.
    scoring: league.scoring || league.detectedScoring || 'PPR',
    positions: isSuperflex ? ['OP', 'ALL'] : ['ALL'],
  };
}

// One in-flight request per distinct (type, scoring, position) combination,
// shared across every league that needs it — with the current league set
// that's a handful of calls per sync rather than one per league.
export function createRankingsProvider(apiKey, season) {
  const cache = new Map();

  function getRankings(type, scoring, position) {
    const key = `${type}|${scoring}|${position}`;
    if (!cache.has(key)) {
      const params = new URLSearchParams({ position, type, scoring });
      // week=0 is FantasyPros' "preseason" slot, which is what draft and
      // dynasty rankings live under. In-season types (ROS/WEEKLY) are
      // published against the live week, so don't pin those to 0.
      if (type === 'DRAFT' || type === 'DYNASTY') params.set('week', '0');
      cache.set(
        key,
        fpGet(`/nfl/${season}/consensus-rankings?${params}`, apiKey).then((data) => ({
          index: buildRankingIndex(data?.players),
          lastUpdated: data?.last_updated ?? null,
          totalExperts: toNumberOrNull(data?.total_experts),
        }))
      );
    }
    return cache.get(key);
  }

  return { getRankings };
}

// Attaches an `ecr` object to every player on every league that has one, and
// records the ranking set used on the league itself so the page can label
// where the numbers came from. Mutates `leagues` in place.
//
// Failures are per-league and non-fatal: a league whose ranking set can't be
// fetched keeps its roster and just carries a rankingsError, matching how
// standings/scoring/lineup failures are already handled by the sync.
// `now` exists so the seasonal default (see automaticRankingType) is testable
// without waiting for September.
export async function attachRankings(leagues, leagueConfigs, { apiKey, season, now = new Date() }) {
  const provider = createRankingsProvider(apiKey, season);
  const configById = new Map(leagueConfigs.map((l) => [l.id, l]));
  const summary = [];

  for (const league of leagues) {
    if (!league.players || league.players.length === 0) continue;
    const spec = rankingSpecForLeague(configById.get(league.id) || league, now);

    try {
      const sets = await Promise.all(
        spec.positions.map((position) => provider.getRankings(spec.type, spec.scoring, position))
      );

      let matched = 0;
      for (const player of league.players) {
        for (const set of sets) {
          const hit = lookupPlayer(set.index, player);
          if (!hit) continue;
          player.ecr = {
            rank: hit.ecr,
            posRank: hit.posRank,
            tier: hit.tier,
            delta: hit.delta,
          };
          matched++;
          break;
        }
      }

      league.rankings = {
        type: spec.type,
        scoring: spec.scoring,
        position: spec.positions[0],
        lastUpdated: sets[0]?.lastUpdated ?? null,
        totalExperts: sets[0]?.totalExperts ?? null,
        matched,
        total: league.players.length,
      };
      league.rankingsError = null;
      summary.push(`${league.name}: ${matched}/${league.players.length} ranked (${spec.type}/${spec.scoring})`);
    } catch (err) {
      league.rankings = null;
      league.rankingsError = err.message;
      summary.push(`${league.name}: rankings failed — ${err.message}`);
    }
  }

  return summary;
}
