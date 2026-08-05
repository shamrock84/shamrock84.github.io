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

// Which ranking set a league is scored against. The Dynasty sub-tab is the
// only one that gets dynasty rankings — salary-cap, best ball and redraft
// all use draft rankings.
//
// Salary-cap leagues carry multi-year contracts and taxi squads, so putting
// them on draft rankings reads like an oversight. It isn't: they're managed
// on a redraft cadence here (the cap resets and the roster gets re-auctioned
// annually), so draft rankings match how the decisions actually get made.
// Don't "correct" this to follow roster mechanics — if a single league ever
// needs to differ, set rankingType on it in config/leagues.json.
//
// Scoring is overridable there too, and rankingType is what you switch to
// ROS once the regular season is underway, since draft rankings go stale the
// moment real games are played.
//
// Superflex leagues rank QBs far higher than a 1-QB league does, which is
// exactly what FantasyPros' "OP" (offensive player) list represents. OP only
// covers offense, so those leagues fall back to the ALL list for kickers,
// defenses and IDP.
export function rankingSpecForLeague(league) {
  const tags = Array.isArray(league.tags) ? league.tags : [];
  const isSuperflex = tags.some((t) => /superflex/i.test(String(t)));
  return {
    type: league.rankingType || (league.type === 'dynasty' ? 'DYNASTY' : 'DRAFT'),
    scoring: league.scoring || 'PPR',
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
export async function attachRankings(leagues, leagueConfigs, { apiKey, season }) {
  const provider = createRankingsProvider(apiKey, season);
  const configById = new Map(leagueConfigs.map((l) => [l.id, l]));
  const summary = [];

  for (const league of leagues) {
    if (!league.players || league.players.length === 0) continue;
    const spec = rankingSpecForLeague(configById.get(league.id) || league);

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
