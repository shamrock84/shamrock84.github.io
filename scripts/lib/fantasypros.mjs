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

// FantasyPros' own player-page URL, read off the rankings response rather than
// built from the player's name. A slug guessed from a name is right until it
// isn't: the site disambiguates two players who share one (josh-allen.php is
// the quarterback, josh-allen-lb.php the linebacker), and normalizePlayerName
// above deliberately drops the suffixes some slugs keep (michael-pittman-jr).
// A link to the wrong player is worse than no link, so a response carrying
// none of these fields yields null and the name simply isn't linked.
//
// Three shapes are accepted because the response has carried different ones:
// an absolute URL, a site-relative path, or the bare slug.
const FP_SITE = 'https://www.fantasypros.com';

export function playerPageUrl(p) {
  const raw = p?.player_page_url || p?.player_url || p?.player_filename || null;
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `${FP_SITE}${s}`;
  const slug = s.replace(/\.php$/i, '');
  return slug ? `${FP_SITE}/nfl/players/${slug}.php` : null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A sync makes a burst of FantasyPros calls back-to-back — rankings per
// league, sleepers, then up to a handful of projections GETs — and
// FantasyPros rate-limits bursts (429) exactly the way MFL does. mflGet in
// providers.mjs already retries a 429 with a short backoff rather than
// failing whatever request happened to land last in the burst; this mirrors
// that fix, which is what let a WR projections call 429 immediately after
// the QB and RB calls just ahead of it succeeded (see fetch-rosters.mjs).
async function fpGet(path, apiKey, attempt = 1) {
  const res = await fetch(`${FP_BASE}${path}`, { headers: { 'x-api-key': apiKey } });
  if (res.status === 429 && attempt < 4) {
    await sleep(attempt * 1500);
    return fpGet(path, apiKey, attempt + 1);
  }
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

// How deep a ranking list is kept in data/rosters.json for the Top Available
// card. This is the card's reach and nothing else: a free agent is findable
// only if he is inside the pool, so the number is chosen against how deep the
// leagues are rather than against how far anyone scrolls. Counted *after*
// kickers and defenses are dropped — see WIRE_EXCLUDED_POSITIONS — so all 250
// are players somebody might actually claim.
//
// It started at 150, which was too shallow for the leagues that need the card
// most. A twelve-team dynasty roster runs 25-30 deep, so 300-plus players are
// spoken for and the top 150 are all gone — that group's wire read as empty
// when what it really was, was unexamined. 250 reaches past the rostered band
// in every league here.
//
// The cost is real and is paid by every visitor on every page load, not once
// at sync time: each pool is roughly 40KB of the file at this depth, and there
// are typically three of them. That is the ceiling on going deeper still.
export const RANKING_POOL_SIZE = 250;

// How many available players are recorded per league. Four pages is plenty
// for a waiver-wire glance, and a pre-draft redraft league — where literally
// everyone is a free agent — would otherwise store the whole pool back again
// once per league.
export const AVAILABLE_LIMIT = 40;

// Stored site-relative, since every one of these is a fantasypros.com URL and
// the origin repeated 450 times is 25KB of nothing. Anything that isn't on
// that origin is kept whole. The page reverses this with one rule; what it
// must never do is build the URL from the player's name — see playerPageUrl.
function compactPlayerUrl(url) {
  if (!url) return null;
  return url.startsWith(FP_SITE) ? url.slice(FP_SITE.length) : url;
}

// Kickers and defenses are left out of the pool entirely, and so out of the
// Top Available card built from it.
//
// Nobody rosters them in a keeper league, so they are *structurally* always
// free — which meant that deepening the pool to 250 dragged in a block of
// players who are permanently on every wire and permanently uninteresting.
// They were 38% of the Dynasty/Salary Cap card, six of the first page's ten
// rows, crowding out the players you might actually claim.
//
// The obvious objection — that this hides the best available defense in a
// league that starts one — turns out not to bite, and the numbers are worth
// recording because they're the whole reason this is safe to do globally:
//
//   DRAFT|PPR|ALL    16 DST + 15 K, and neither of its two leagues starts one
//   DYNASTY|PPR|ALL   2 DST +  0 K, and all three of its leagues start 1 Def
//   DRAFT|HALF|OP     none — the superflex OP list is offense-only
//
// So the pool full of them serves leagues that don't use them, and the
// leagues that do use them draw on a list that barely ranks them (FantasyPros
// gives defenses almost no dynasty value, correctly). The cost is two
// defenses those three leagues could never have found a use for.
//
// This filters the *pool* only, never buildRankingIndex — a kicker on your own
// roster still gets his ECR number on the roster card, exactly as before.
const WIRE_EXCLUDED_POSITIONS = new Set(['K', 'DST']);

// The ranking list itself, best first — the same response buildRankingIndex
// turns into a name lookup, kept in list form so the page can show who is
// unrostered rather than only where our own players place among them.
// Players with no rank are dropped: they cannot be placed in an ordered list,
// and an unranked player is not a "top" anything.
//
// The position filter runs before the truncation, so RANKING_POOL_SIZE buys
// 250 players you might claim rather than 250 minus whatever kickers happened
// to rank inside it.
//
// `team` is here so the Top Available card can print the NFL team beside the
// name the way every roster row does. It has to come off the pool entry rather
// than off a roster: the whole point of a row there is that nobody holds the
// player, so there is no roster copy to read a team from. This is the one
// field on a pool entry the page cannot derive, and at three bytes a player it
// is about 3KB across the three pools — the cost worth watching here is depth
// (see RANKING_POOL_SIZE), not width.
export function buildRankingList(players) {
  return (players || [])
    .map((p) => ({
      name: p.player_name,
      position: canonicalPosition(p.player_position_id),
      // 'FA' rather than '' when FantasyPros carries no team, matching what
      // every provider in lib/providers.mjs already writes onto a rostered
      // player — so the page has one convention to render and "no NFL team"
      // never has to be told apart from "field absent" (which is what a
      // rosters.json synced before this existed has, and is the only case the
      // page treats as unknown).
      team: canonicalTeam(p.player_team_id) || 'FA',
      rank: toNumberOrNull(p.rank_ecr),
      url: compactPlayerUrl(playerPageUrl(p)),
    }))
    .filter((p) => p.name && p.rank != null && !WIRE_EXCLUDED_POSITIONS.has(p.position))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, RANKING_POOL_SIZE);
}

export function buildRankingIndex(players) {
  const byName = new Map();
  for (const p of players || []) {
    const key = normalizePlayerName(p.player_name);
    if (!key) continue;
    const entry = {
      ecr: toNumberOrNull(p.rank_ecr),
      posRank: p.pos_rank || null,
      tier: toNumberOrNull(p.tier),
      delta: toNumberOrNull(p.player_ecr_delta),
      url: playerPageUrl(p),
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
          list: buildRankingList(data?.players),
          lastUpdated: data?.last_updated ?? null,
          totalExperts: toNumberOrNull(data?.total_experts),
        }))
      );
    }
    return cache.get(key);
  }

  return { getRankings };
}

// How a league finds the ranking list its ECR numbers came from. The three
// parts are exactly what's already recorded on `league.rankings`, so nothing
// extra has to be stored per league to make the join.
export function rankingPoolKey({ type, scoring, position }) {
  return `${type}|${scoring}|${position}`;
}

// Attaches an `ecr` object to every player on every league that has one, and
// records the ranking set used on the league itself so the page can label
// where the numbers came from. Mutates `leagues` in place.
//
// Returns `{ summary, pools }` — the pools being the top of each ranking list
// actually used, keyed by rankingPoolKey, which the sync writes alongside the
// leagues. Two Analytics cards need them: Top Players is the list itself, and
// Top Available is the list minus everyone rostered in a given league.
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
  const pools = {};

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
            // Absent when the response carried no page field for this player
            // — the page treats that as "don't link the name" rather than
            // constructing a URL of its own. See playerPageUrl.
            url: hit.url,
          };
          matched++;
          break;
        }
      }

      league.rankings = {
        type: spec.type,
        scoring: spec.scoring,
        // The primary list only. A superflex league also draws on ALL for
        // kickers, defenses and IDP, but those two lists number their ranks
        // on different scales, so mixing them into one ordered pool would
        // interleave two rankings that don't compare. The overall list is
        // the one the analytics cards are ordered by.
        position: spec.positions[0],
        lastUpdated: sets[0]?.lastUpdated ?? null,
        totalExperts: sets[0]?.totalExperts ?? null,
        matched,
        total: league.players.length,
      };
      league.rankingsError = null;

      const primary = sets[0];
      const key = rankingPoolKey(league.rankings);
      if (primary?.list?.length > 0 && !pools[key]) {
        pools[key] = {
          type: spec.type,
          scoring: spec.scoring,
          position: spec.positions[0],
          lastUpdated: primary.lastUpdated ?? null,
          players: primary.list,
        };
      }
      // Only when this run actually re-read the league's rosters. Most syncs
      // skip that (see the once-a-day rule in fetch-rosters.mjs) and carry the
      // previous list forward instead — assigning null over it here would
      // empty the card on five runs out of six.
      if (Array.isArray(league.rosteredNames)) {
        league.available = availableFromPool(pools[key], league.rosteredNames);
      }

      summary.push(`${league.name}: ${matched}/${league.players.length} ranked (${spec.type}/${spec.scoring})`);
    } catch (err) {
      league.rankings = null;
      league.rankingsError = err.message;
      summary.push(`${league.name}: rankings failed — ${err.message}`);
    }
  }

  return { summary, pools };
}

// Attaches a `sleeper` object to every player who appears on FantasyPros'
// "Sleepers" list — undervalued/breakout picks, published as editorial
// content rather than a full positional ranking, confirmed reachable by
// probe-fantasypros-sleepers.yml as `type=SLEEPERS` (plural) on the SAME
// consensus-rankings endpoint attachRankings already calls. That probe is
// the reason this is spelled the way it is: `type=SLEEPER` (singular) is
// NOT an error, it silently falls back to the Draft list — FantasyPros
// doesn't 4xx an unrecognized `type`, so a misspelling here would ship a
// column that quietly means something else. Always re-verify with that
// probe before touching the literal string 'SLEEPERS' below.
//
// One fetch for the whole sync, not one per league. Sleepers is a single
// curated list rather than a scoring-sensitive positional ranking the way
// DRAFT/DYNASTY/ROS are, so unlike attachRankings this doesn't vary the
// request by league type or scoring format — every league joins against
// the same list. (Untested: whether the list itself would actually differ
// by scoring format. Fixed at PPR/ALL rather than assumed either way.)
//
// Joined exactly like ECR — buildRankingIndex/lookupPlayer by normalized
// name, a name collision resolving to nobody rather than a guess — because
// the Sleepers response is shaped identically to every other
// consensus-rankings response; nothing about the join needed to change.
//
// Failure here is non-fatal at the call site (see fetch-rosters.mjs): a
// league's roster and its primary ECR numbers must never be held hostage
// by a secondary, "nice to have" list.
// The join itself, pulled out of attachSleepers so it's testable without a
// network call — mirrors how attachInjuryDetail takes already-fetched data
// rather than fetching inside the function it's named for.
export function applySleepers(leagues, index) {
  let matched = 0;
  for (const league of leagues) {
    for (const player of league.players || []) {
      const hit = lookupPlayer(index, player);
      if (!hit) continue;
      player.sleeper = { rank: hit.ecr, posRank: hit.posRank, tier: hit.tier, url: hit.url };
      matched++;
    }
  }
  return matched;
}

export async function attachSleepers(leagues, { apiKey, season }) {
  const data = await fpGet(`/nfl/${season}/consensus-rankings?position=ALL&type=SLEEPERS&scoring=PPR`, apiKey);
  const matched = applySleepers(leagues, buildRankingIndex(data?.players));
  return { matched, total: (data?.players || []).length, lastUpdated: data?.last_updated ?? null };
}

// The best-ranked players in this league's pool that nobody in the league
// rosters. Names only: the rank, position and profile link all live on the
// pool entry the page looks the name back up in, and repeating them once per
// league is the same bytes over again for eighteen leagues.
//
// `null` rather than `[]` when the league-wide roster couldn't be read, which
// is a different statement: an empty array says "no good free agents", null
// says "don't know", and only the second should keep a league out of the
// card's denominator.
export function availableFromPool(pool, rosteredNames) {
  if (!pool || !Array.isArray(rosteredNames) || rosteredNames.length === 0) return null;

  const rostered = new Set(rosteredNames.map(normalizePlayerName).filter(Boolean));
  const seen = new Set();
  const available = [];
  for (const p of pool.players) {
    const key = normalizePlayerName(p.name);
    if (!key || rostered.has(key) || seen.has(key)) continue;
    seen.add(key);
    available.push(p.name);
    if (available.length >= AVAILABLE_LIMIT) break;
  }
  return available;
}

// ---- Power ranks --------------------------------------------------------
// A power rank grades every franchise in a league by the projected points of
// its best legal starting lineup — homegrown, because the probe
// (probe-fantasypros-power-rank.yml) established that nothing team-shaped
// exists behind the partner API: every candidate endpoint 403d
// ("Missing Authentication Token" is API Gateway for "no such route") while
// the consensus-rankings control answered 200 with the same key. What the
// key *can* reach is season projections, whose rows carry points under all
// three scoring variants at once and — the find that shapes everything below
// — an `mflid`, so the fifteen MFL leagues join by player id and never
// touch the name-matching machinery at all.
//
// The score is a floor, not a valuation of the whole roster: each league's
// starting slots are filled greedily from the franchise's best projected
// players and the bench contributes nothing. That underrates depth on
// purpose — a power rank is an ordinal *within* one league, and the only
// property it needs is that every franchise in that league is valued by the
// same rule. Cross-league comparison of scores is meaningless twice over
// (different slots, different scoring) and the page must never do it.

// The positions a power score counts. Kickers and defenses are excluded for
// the wire's reasons plus one of their own: their projections are nearly
// flat, and the name-join for a defense ("Ravens D/ST" vs "Baltimore
// Ravens") fails in a different way per provider. Their slots are dropped
// from the valuation entirely, which biases every franchise in a league
// equally and so moves no one's rank.
export const POWER_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// What ESPN leagues are valued against: the platform's default lineup. ESPN's
// real slot counts live in an mSettings view this project has never probed,
// and a guessed-but-uniform shape keeps the ordinal fair — every franchise in
// the league is valued against the same slots, which is the property that
// matters. Reaching for the real counts starts with a probe, not here.
export const DEFAULT_POWER_SLOTS = [
  { positions: ['QB'], count: 1 },
  { positions: ['RB'], count: 2 },
  { positions: ['WR'], count: 2 },
  { positions: ['TE'], count: 1 },
  { positions: ['RB', 'WR', 'TE'], count: 1 },
];

// One projections index per sync, shared by every league the way the
// rankings provider is. Entries carry all three scoring variants because the
// response does — one fetch per position serves PPR, half and standard
// leagues alike.
//
// byName mirrors buildRankingIndex's collision rule: two projected players
// whose names normalize alike tombstone the key to null rather than letting
// the first one win, because crediting a franchise with the wrong Josh Allen
// is worse than crediting it with neither. byMflId has no such hazard — ids
// are unique — which is why the MFL join never consults byName at all.
export function buildProjectionIndex(playersByPosition) {
  const byMflId = new Map();
  const byName = new Map();
  for (const [position, players] of Object.entries(playersByPosition || {})) {
    for (const p of players || []) {
      const stats = p?.stats || {};
      const entry = {
        name: p?.name ?? '',
        position,
        points: {
          PPR: toNumberOrNull(stats.points_ppr),
          HALF: toNumberOrNull(stats.points_half),
          STD: toNumberOrNull(stats.points),
        },
      };
      if (p?.mflid != null && String(p.mflid) !== '0') {
        byMflId.set(String(p.mflid), entry);
      }
      const key = normalizePlayerName(p?.name);
      if (!key) continue;
      byName.set(key, byName.has(key) ? null : entry);
    }
  }
  return { byMflId, byName };
}

// week=0 is FantasyPros' preseason slot, same as draft/dynasty rankings
// use, and is what the probe actually asked.
//
// WHAT HAPPENS IN-SEASON IS NOT YET KNOWN, and it is the open question
// hanging over this whole feature. Three answers are possible once games
// are played: week=0 keeps serving frozen August numbers (stale, and
// silently — the card goes on rendering plausible ranks off projections
// that predate every injury and breakout of the season), it starts
// serving rest-of-season numbers (ideal), or it empties out.
// probe-fantasypros-power-rank.yml asks the questions that distinguish
// these and is meant to be re-run after kickoff; `week` is a parameter
// here rather than a literal so the answer costs a call-site change
// rather than a rewrite.
//
// The guard below is what makes the third case loud rather than quiet. An
// empty position means the endpoint stopped answering the way it did when
// the probe looked, and computing on it would hand every franchise a zero
// score, every zero would tie, and the card would show every team ranked
// first — plausible enough to read past. Throwing instead lands in
// fetch-rosters.mjs's catch, which logs it and leaves the previous sync's
// power object in place: stale-but-real beats confidently-wrong, the same
// trade every other fallback here makes.
export async function fetchProjections({ apiKey, season, week = 0, inSeason = false }) {
  const playersByPosition = {};
  for (const position of POWER_POSITIONS) {
    const data = await fpGet(`/nfl/${season}/projections?position=${position}&week=${week}`, apiKey);
    const players = data?.players || [];
    if (players.length === 0) {
      const err = new Error(`projections returned no ${position}s for ${season} week ${week}`);
      // Tagged so fetch-rosters.mjs can tell this apart from fpGet's own
      // throw (a non-2xx status, e.g. a 429 rate limit, or bad JSON): both
      // land here as "projections unavailable" and produce the same empty
      // column on the card, but only this one means the season's list
      // genuinely isn't up yet rather than the last sync getting throttled.
      err.projectionsNotPublished = true;
      throw err;
    }
    playersByPosition[position] = players;
  }
  return {
    ...buildProjectionIndex(playersByPosition),
    // Provenance, carried onto every power object so the page can say when
    // the ranks rest on preseason numbers during the season itself.
    //
    // This is phase-and-week rather than a date on purpose, and the probe is
    // why: unlike consensus-rankings, the *projections* endpoint carries no
    // `last_updated` at all (it came back absent for every week asked), so a
    // freshness check built on one would never fire and would look like a
    // working guard. The deterministic question is just as good and needs no
    // metadata: were we in season, and did we ask for the preseason slot?
    // That is exactly the dangerous combination, it is knowable here, and it
    // stops being true the moment the week argument changes — which is the
    // change the post-kickoff probe is meant to inform.
    meta: { basis: 'projections', season: String(season), week: String(week), inSeason: !!inSeason },
  };
}

// Fills a league's starting slots greedily from a franchise's best projected
// players: dedicated slots first, then flex slots from whoever remains, most
// constrained slot first so a flex never steals the last RB from an RB slot.
// Greedy is not provably optimal against adversarial slot shapes, but every
// franchise in a league is scored by the same greed, and the ordinal is the
// product. A slot nobody can fill scores zero and is counted in `filled`'s
// shortfall rather than erroring — a mid-rebuild roster is a low score, not
// a crash.
//
// `depth` is everything the lineup could not seat: the summed projected
// points of the players left over once the slots are filled. Bench value is
// a real part of a team's strength — it is what the starters score ignores
// on purpose — so it travels as its own number rather than being folded in,
// and the page ranks the two separately. A raw sum rewards a big roster,
// which is fine for the ordinal's purposes: roster limits are uniform
// within a league, and within a league is the only place these numbers
// compare.
//
// `byPosition` is the same score/depth split, one level deeper: which
// position each seated point actually came from. The greedy fill already
// knows this — `bestPos` is the real position of whichever player filled a
// slot, dedicated or flex, not the slot's own label — so this costs nothing
// beyond bookkeeping the fill already does. It is what the Team Needs card
// is built from: a flex point earned by a rostered RB counts as RB strength
// there, the same way it does here, rather than being invisible in a "flex"
// bucket nobody can compare across teams.
//
// `starters` is the same fill, one level deeper still: not just which
// position filled each slot, but which *player*. It costs nothing beyond
// keeping the name that was already sitting on `players[i]` — the greedy
// loop already holds a reference to the winning player at the moment it
// seats them, this just remembers it instead of discarding it for the bare
// point total. Order is seating order (dedicated slots first, most-
// constrained first, so a flex winner lands last), not alphabetical or
// score-sorted, since that's what tells a reader which one is the flex
// without a separate label. This is what the Power Rankings "Start" column
// popover reads (see computeLeaguePower / renderPowerRankCard).
export function computePowerScore(players, slots) {
  const byPosition = new Map();
  for (const p of players || []) {
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }
  for (const list of byPosition.values()) list.sort((a, b) => b.points - a.points);
  const cursor = new Map([...byPosition.keys()].map((pos) => [pos, 0]));
  const scoreByPosition = new Map([...byPosition.keys()].map((pos) => [pos, 0]));

  const ordered = [...(slots || [])].sort((a, b) => a.positions.length - b.positions.length);
  let score = 0;
  let filled = 0;
  let slotCount = 0;
  const starters = [];
  for (const slot of ordered) {
    for (let i = 0; i < slot.count; i++) {
      slotCount++;
      let bestPos = null;
      let bestPlayer = null;
      for (const pos of slot.positions) {
        const list = byPosition.get(pos);
        const at = cursor.get(pos) ?? 0;
        if (list && at < list.length && (bestPlayer === null || list[at].points > bestPlayer.points)) {
          bestPlayer = list[at];
          bestPos = pos;
        }
      }
      if (bestPos === null) continue;
      cursor.set(bestPos, (cursor.get(bestPos) ?? 0) + 1);
      scoreByPosition.set(bestPos, (scoreByPosition.get(bestPos) ?? 0) + bestPlayer.points);
      score += bestPlayer.points;
      filled++;
      starters.push({ name: bestPlayer.name, position: bestPos });
    }
  }
  const totalPoints = (players || []).reduce((sum, p) => sum + p.points, 0);
  const byPositionOut = {};
  for (const [pos, list] of byPosition) {
    const posTotal = list.reduce((sum, p) => sum + p.points, 0);
    const posScore = scoreByPosition.get(pos) ?? 0;
    byPositionOut[pos] = { score: posScore, depth: posTotal - posScore };
  }
  return { score, depth: totalPoints - score, filled, slotCount, byPosition: byPositionOut, starters };
}

// ---- The ECR fallback ---------------------------------------------------
// What the power score runs on when projections aren't available, which is
// not an edge case but a season: FantasyPros publishes projections for a
// season, and between the Super Bowl and whenever the next season's list
// goes up (`nflSeasonPhase` has already rolled the target year over by
// February) there is nothing to ask for. Every position comes back empty,
// fetchProjections throws, and without this the card would carry January's
// ranks forward through the entire offseason — against rosters that have
// since traded and drafted — with nothing on screen to say so, because a
// carried-forward power object still reports the phase and slot it was
// *originally* computed under.
//
// Rankings, unlike projections, exist year-round: that is the whole point of
// automaticRankingType, which serves DYNASTY/DRAFT in the offseason and ROS
// in season. The pools the sync already stores for the Top Available card
// are therefore a live valuation of every player, keyed by name, in exactly
// the window where projections are dark.
//
// The cost is that a rank is an ordinal, and ordinals cannot be summed —
// which is precisely why projections won the primary job. Converting one to
// a value needs a curve, and this is the honest version of that: consensus
// value falls off steeply at the top of a list and flattens through the
// middle, which a logarithm captures with no tuned constants, and it reaches
// exactly zero at the edge of the pool so a player who barely ranks
// contributes nothing rather than a floor. Only the *ordering* this produces
// is ever shown, so the curve has to be monotone and roughly the right
// shape rather than calibrated against real scoring.
//
// Two consequences worth stating rather than discovering. This curve is
// steeper than raw projected points (which carry a large baseline every
// startable player earns), so the two bases weight stars differently and can
// order the same teams differently — which is why the card says which basis
// it used, so a rank that moves in February is explainable. And the pool is
// RANKING_POOL_SIZE deep where projections cover every ranked player, so
// depth on this basis counts only pool players and is the shallower measure;
// every franchise in a league is measured the same way, so the ordinal
// holds, but a bench of unranked stashes reads as empty rather than thin.
export function ecrValue(rank, poolSize) {
  const r = Number(rank);
  const size = Number(poolSize);
  if (!(r > 0) || !(size > 0) || r > size) return 0;
  return Math.log(size / r);
}

// A ranking pool turned into the same shape fetchProjections returns, so
// computeLeaguePower consumes either without knowing which it has. byMflId
// is deliberately empty: pool entries carry no MFL id (they are the
// FantasyPros list, joined to rosters by name everywhere else too), and
// computeLeaguePower already falls through to the name index when the id
// lookup misses, so an MFL league joins by name here without a special case.
//
// The same tombstone rule as buildProjectionIndex, for the same reason: two
// pool players whose names normalize alike resolve to nobody.
export function buildEcrIndex(pool, { season, inSeason } = {}) {
  const players = pool?.players || [];
  if (players.length === 0) return null;
  // The pool's own depth rather than RANKING_POOL_SIZE: a pool that came
  // back short is still internally consistent, and the constant would hand
  // its last players a negative value. Measured as the deepest rank present
  // rather than the entry count, which are the same number for a pool as
  // stored (a contiguous top-N with the unranked already dropped) but come
  // apart the moment anything filters it — and the count is the one that
  // silently zeroes every player past it.
  const deepest = players.reduce((max, p) => Math.max(max, Number(p.rank) || 0), 0);
  const size = Math.max(players.length, deepest);
  const byName = new Map();
  for (const p of players) {
    if (!POWER_POSITIONS.includes(p.position)) continue;
    const key = normalizePlayerName(p.name);
    if (!key) continue;
    const value = ecrValue(p.rank, size);
    const entry = {
      name: p.name,
      position: p.position,
      // A pool is already scoring-specific — the scoring is part of its key
      // — so the three variants are one number here rather than three.
      points: { PPR: value, HALF: value, STD: value },
    };
    byName.set(key, byName.has(key) ? null : entry);
  }
  if (byName.size === 0) return null;
  return {
    byMflId: new Map(),
    byName,
    meta: {
      basis: 'ecr',
      season: String(season ?? ''),
      rankingType: pool?.type ?? null,
      scoring: pool?.scoring ?? null,
      inSeason: !!inSeason,
    },
  };
}

// Every franchise in one league, scored and sorted. `joinById` is true only
// for MFL, whose roster player ids are the same ids the projections carry —
// Sleeper's ids live in a different id space that happens to look identical
// (small numeric strings), so letting a Sleeper league near byMflId would
// quietly credit franchises with the wrong players. Everyone else joins by
// normalized name and inherits that join's known property: a collision
// resolves to nobody rather than to the wrong body.
// `values` is whichever player valuation this run has — fetchProjections'
// index, or buildEcrIndex's when projections are dark. They share a shape on
// purpose, so which one is in hand is the caller's problem and not this
// function's; the choice travels to the page in `source`.
export function computeLeaguePower({ franchises, slots, values, scoring, joinById, computedAt }) {
  const effectiveScoring = scoring || 'PPR';
  const teams = (franchises || []).map((f) => {
    const players = [];
    for (const p of f.players || []) {
      let entry = joinById ? values.byMflId.get(String(p.id)) : null;
      if (!entry) {
        const key = normalizePlayerName(p.name);
        entry = key ? values.byName.get(key) : null;
      }
      if (!entry) continue;
      const points = entry.points[effectiveScoring] ?? entry.points.PPR;
      if (!(points > 0)) continue;
      // The roster's own name, not the ranking list's — same convention as
      // every other name on the page (the team suffix, for instance, always
      // shows the provider's own spelling). Only ever read for display, in
      // the Power Rankings "Start" popover; the join above already happened
      // by id or normalized name, so this has no bearing on matching.
      players.push({ position: entry.position, points, name: p.name });
    }
    const { score, depth, filled, slotCount, byPosition, starters } = computePowerScore(players, slots);
    // Normalized to every POWER_POSITIONS entry, not just the ones this
    // roster happened to fill: a team with no rostered TE is genuinely
    // weakest there, and that has to show up as a real 0/0 rather than a
    // missing key, or the Team Needs card would have nothing to rank it
    // against at that position.
    const byPositionOut = {};
    for (const pos of POWER_POSITIONS) {
      const posEntry = byPosition[pos];
      byPositionOut[pos] = {
        score: Math.round((posEntry?.score ?? 0) * 10) / 10,
        depth: Math.round((posEntry?.depth ?? 0) * 10) / 10,
      };
    }
    return {
      franchiseId: String(f.franchiseId),
      score: Math.round(score * 10) / 10,
      depth: Math.round(depth * 10) / 10,
      filled,
      slotCount,
      byPosition: byPositionOut,
      // Every team gets its starters computed here — ranking one franchise
      // needs the greedy fill run for all of them regardless — but
      // fetch-rosters.mjs strips this back off every team except the one
      // matching the league's own franchiseId before writing the sync
      // output, since only "my" starters are ever shown on the page. Kept
      // general here rather than taking a "which franchise is mine"
      // parameter, so this function's output doesn't depend on who's asking.
      starters,
    };
  });
  teams.sort((a, b) => b.score - a.score);
  // Loud rather than quiet, the per-league half of fetchProjections' guard.
  // Not one franchise in the league seating a single player means the join
  // failed for this league — a slot shape that parsed to nothing usable, or
  // an id space that stopped lining up — and the output of that is a card
  // where every team ties at zero and so every team ranks first. Returning
  // null makes the caller skip the league, which leaves its previous power
  // object standing rather than overwriting it with a uniform lie.
  if (!teams.some((t) => t.filled > 0)) return null;
  return {
    computedAt: computedAt ?? null,
    scoring: effectiveScoring,
    // What these numbers were computed from — the projections slot and phase,
    // or the ranking list the ECR fallback used. Named for the question it
    // answers rather than for either basis, since it carries both.
    source: values?.meta ?? null,
    teams,
  };
}
