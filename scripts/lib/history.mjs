// Derives a league's final placement for a completed season — the History
// tab's Results card needs a 1..N finish per year, and neither provider's
// live/regular-season standings reflect who actually won the playoffs.
// Confirmed against the real APIs via probe-league-history.yml
// (scripts/probe-league-history.mjs): MFL's TYPE=leagueStandings order is
// regular-season seeding only (its top row's games-played exactly matched
// lastRegularSeasonWeek), and the team with the best regular-season record
// (26696/2025's franchise 0010) was NOT the champion — 0001 won the
// bracket final 111.5-90.3 after entering as the 3-seed. ESPN, by contrast,
// already computes and exposes the real answer directly on the team object.
//
// MFL runs one or more independent single-elimination brackets per season
// (TYPE=playoffBrackets lists them), each covering a contiguous slice of the
// standings — a "Fantasy Bowl" for the top half, a "Toilet Bowl" for the
// bottom half, commonly each with one or more smaller decider brackets for
// the placement tiers just below the main bracket's final (a "3rd place
// game" for the two semifinal losers, sometimes another for the two
// first-round losers, and so on). Bracket NAMES are commissioner-chosen free
// text — seen in the wild: "Fantasy Bowl", "Sole Survivor", "Championship
// Bracket", and "Champions Bracket" all mean the same top bracket across
// different leagues in this config, while "Toilet Bowl" always means the
// bottom one — so which FAMILY a bracket belongs to is still classified by
// keyword: anything containing "toilet" is the bottom family, everything
// else defaults to the top family.
//
// Which bracket within a family is the MAIN one, and which are its
// secondary deciders, is deliberately NOT decided by name — a bracket named
// "Consolation" is one real convention, but a real league (Iron Bank, 2020)
// instead named its two secondary brackets "3rd Place Game" and "7/8
// position," neither containing that word, and would have had both
// misclassified as ungrouped "top family, non-consolation" brackets under a
// keyword rule (with the bug this caused: a real 3rd-place finish — the
// user's own team, confirmed against MFL's site — computed as a guess, the
// four unresolved teams from ALL its secondary brackets combined dumped into
// one regular-season-order fallback instead of split by their actual
// results). Instead: the main bracket is the one with the most
// `teamsInvolved` in its family, and any OTHER bracket in that family whose
// own participants are entirely a subset of the main bracket's is a
// secondary decider for it, whatever it's named — true of a
// "Consolation"-named bracket too, so this supersedes name matching rather
// than needing it alongside it (`isConsolationBracket` is kept as a
// narrower, name-only utility below since it's still meaningful on its own,
// just no longer how the main algorithm classifies anything). The two
// families are treated identically otherwise: in both, the main bracket's
// final winner takes the family's best open rank and the loser the next,
// exactly mirroring how the top family's "champion" and "runner-up" work
// for the bottom family's "escaped last" and "confirmed last" — a Toilet
// Bowl is not scored backwards.
//
// A family can run more than one secondary bracket — Iron Bank's 2020
// "Fantasy Bowl" ran both the 3rd-place game (the two semifinal losers) and
// the 7/8 game (the two first-round losers). Multiple secondaries are
// processed best-seeded-first, using each participant's own seed as
// recorded in the MAIN bracket (a secondary's own game entries carry no
// seed, only `winner_of_game`/`loser_of_game` — see fetchMflSeasonBracketData's
// own game shape), so "who plays for 3rd" resolves before "who plays for
// 7th": each secondary's final settles the next two open ranks in that
// order, generalizing the old single-consolation slot to as many tiers as a
// league actually ran, still within that family's own contiguous rank
// block (nextLo) rather than interleaved with the other family's — Iron
// Bank's "7/8 position" title reads like an absolute rank shared across
// both families, but nothing here has strong enough evidence to abandon the
// existing per-family-block model on the strength of one league's naming,
// so its winner/loser still land at ranks 5/6 within the top family's own
// six, not the bottom family's 7/8.
//
// Any team who played in the main bracket but reached no final at all — a
// bye-less team eliminated in an early round, with no secondary bracket to
// catch it — gets its rank by elimination when there is exactly one such
// team (the common case: a 5-team bracket with one secondary bracket
// accounts for 4 of the 5, leaving the fifth determined by there being
// nothing else left to assign, not a guess). Two or more such leftovers, or
// a family with no bracket at all, is a genuine gap bracket data can't
// resolve on its own — those teams are ordered by regular-season standing
// instead and flagged `guessed: true`, so the UI can show them differently
// (in red) rather than presenting a guess as settled fact.

const TOILET_BOWL_RE = /toilet/i;
const CONSOLATION_RE = /consolation/i;

// winnerTitle is optional and checked alongside name — a real season (MNMx
// 2006) ran a second bracket named "MNMx Dynasty Losers Bracket" with no
// "toilet" in the name at all, so it was misclassified as 'top': lumped into
// the same family as the winners bracket, then dropped entirely once its
// five franchises (a disjoint set, not a subset of the winners bracket's
// own) failed the secondary-bracket subset test in groupBracketsByFamily's
// caller. Its own bracketWinnerTitle — "Toilet Bowl Champion" — says exactly
// what name doesn't, and MFL provides it on every bracket alongside name.
export function bracketFamily(name, winnerTitle) {
  return TOILET_BOWL_RE.test(name || '') || TOILET_BOWL_RE.test(winnerTitle || '') ? 'bottom' : 'top';
}

export function isConsolationBracket(name) {
  return CONSOLATION_RE.test(name || '');
}

// A bracket's rounds arrive keyed by week but not necessarily in week order
// — sort before treating "the last one" as the final.
function roundsInOrder(playoffBracket) {
  const rounds = playoffBracket?.playoffRound;
  const list = Array.isArray(rounds) ? rounds : rounds ? [rounds] : [];
  return [...list].sort((a, b) => Number(a.week) - Number(b.week));
}

function gamesOf(round) {
  const games = round?.playoffGame;
  return Array.isArray(games) ? games : games ? [games] : [];
}

// Every franchise id that appears anywhere in the bracket, home or away, any
// round — including one-and-done first-round losers a consolation bracket
// never picks up.
export function franchisesInBracket(playoffBracket) {
  const ids = new Set();
  for (const round of roundsInOrder(playoffBracket)) {
    for (const game of gamesOf(round)) {
      if (game.home?.franchise_id) ids.add(game.home.franchise_id);
      if (game.away?.franchise_id) ids.add(game.away.franchise_id);
    }
  }
  return ids;
}

// The bracket's own final: the last round by week. A single-elimination
// bracket's final round is always exactly one game — the whole tree funnels
// to it — so more than one game there is treated as an unrecognised shape
// rather than guessed at.
function finalGame(playoffBracket) {
  const rounds = roundsInOrder(playoffBracket);
  if (rounds.length === 0) return null;
  const games = gamesOf(rounds[rounds.length - 1]);
  return games.length === 1 ? games[0] : null;
}

function resolveGame(game) {
  const homeId = game?.home?.franchise_id;
  const awayId = game?.away?.franchise_id;
  const homePts = Number(game?.home?.points);
  const awayPts = Number(game?.away?.points);
  if (!homeId || !awayId || !Number.isFinite(homePts) || !Number.isFinite(awayPts) || homePts === awayPts) {
    return null;
  }
  return homePts > awayPts
    ? { winnerId: homeId, loserId: awayId }
    : { winnerId: awayId, loserId: homeId };
}

function groupBracketsByFamily(brackets) {
  const groups = { top: [], bottom: [] };
  for (const b of brackets || []) groups[bracketFamily(b.name, b.bracketWinnerTitle)].push(b);
  return groups;
}

// The bracket with the most teamsInvolved in its family — robust across
// every naming convention seen so far, since a secondary bracket (however
// named) always covers a strict subset of the main bracket's own
// participants and so is smaller. Ties keep whichever sorts first.
function pickMainBracket(familyBrackets) {
  let best = null;
  for (const b of familyBrackets) {
    if (!best || (Number(b.teamsInvolved) || 0) > (Number(best.teamsInvolved) || 0)) best = b;
  }
  return best;
}

// A franchise's seed within a bracket, read off wherever it enters directly
// (a bye or a first-round starter carries `seed`; a team that advanced by
// winning a prior game carries `winner_of_game` instead, with no seed
// repeated there). Used only to order multiple secondary brackets within one
// family relative to each other — see computeMflSeasonPlacements — never to
// resolve a game result.
function seedsInBracket(playoffBracket) {
  const seeds = new Map();
  for (const round of roundsInOrder(playoffBracket)) {
    for (const game of gamesOf(round)) {
      for (const side of [game.home, game.away]) {
        if (side?.franchise_id && side.seed != null && !seeds.has(side.franchise_id)) {
          seeds.set(side.franchise_id, Number(side.seed));
        }
      }
    }
  }
  return seeds;
}

// leagueFranchiseIds: every franchise in the league this season (drives the
// total N and the final gap-filling pass).
// brackets: [{id, name, teamsInvolved}], from TYPE=playoffBrackets.
// bracketDataById: Map(String(id) -> that bracket's TYPE=playoffBracket
//   .playoffBracket body).
// regularSeasonOrder: franchise ids, best-to-worst, from TYPE=leagueStandings
//   — the fallback for anyone bracket data leaves unplaced, in either
//   family's gap or because a family has no bracket at all.
//
// Returns one entry per league franchise: { franchiseId, rank, total,
// guessed }. `rank` is null only if regularSeasonOrder itself didn't cover a
// franchise (a sync inconsistency) — same missing-value convention as the
// rest of the page, rendered rather than fabricated.
export function computeMflSeasonPlacements({ leagueFranchiseIds, brackets, bracketDataById, regularSeasonOrder }) {
  const n = leagueFranchiseIds.length;
  const rankOf = new Map();
  const guessed = new Set();
  const groups = groupBracketsByFamily(brackets);

  let nextLo = 1;
  for (const key of ['top', 'bottom']) {
    const familyBrackets = groups[key];
    if (familyBrackets.length === 0) continue;
    const main = pickMainBracket(familyBrackets);
    if (!main) continue;
    const size = Number(main.teamsInvolved) || null;

    const mainData = bracketDataById.get(String(main.id)) || null;
    const familyMembers = mainData ? franchisesInBracket(mainData) : new Set();
    const seeds = mainData ? seedsInBracket(mainData) : new Map();
    let lo = nextLo;

    const mainResult = mainData ? resolveGame(finalGame(mainData)) : null;
    if (mainResult) {
      rankOf.set(mainResult.winnerId, lo);
      rankOf.set(mainResult.loserId, lo + 1);
      lo += 2;
    }

    // Any other bracket in this family whose own participants are entirely
    // among the main bracket's — structural, not name-based, so "3rd Place
    // Game" and "7/8 position" both qualify exactly like a "Consolation"-
    // named bracket would. Ordered best-seeded-first so the higher tier
    // resolves before the lower one when a family runs more than one.
    const secondaries = familyBrackets
      .filter((b) => String(b.id) !== String(main.id))
      .map((b) => {
        const data = bracketDataById.get(String(b.id)) || null;
        const members = data ? franchisesInBracket(data) : new Set();
        const bestSeed = members.size
          ? Math.min(...[...members].map((id) => seeds.get(id) ?? Infinity))
          : Infinity;
        return { data, members, bestSeed };
      })
      .filter(({ members }) => members.size > 0 && [...members].every((id) => familyMembers.has(id)))
      .sort((a, b) => a.bestSeed - b.bestSeed);

    for (const { data } of secondaries) {
      const result = data ? resolveGame(finalGame(data)) : null;
      if (result) {
        rankOf.set(result.winnerId, lo);
        rankOf.set(result.loserId, lo + 1);
        lo += 2;
      }
    }

    const leftover = [...familyMembers].filter((id) => !rankOf.has(id));
    if (leftover.length === 1) {
      rankOf.set(leftover[0], lo);
      lo += 1;
    } else if (leftover.length > 1) {
      const ordered = (regularSeasonOrder || []).filter((id) => leftover.includes(id));
      for (const id of ordered) {
        rankOf.set(id, lo);
        guessed.add(id);
        lo += 1;
      }
    }

    nextLo = size ? nextLo + size : lo;
  }

  // Anyone in the league not covered by any bracket at all (no Toilet Bowl
  // run this year, or a family this function couldn't parse) fills the
  // remaining open ranks in regular-season order — also a guess.
  const unplaced = leagueFranchiseIds.filter((id) => !rankOf.has(id));
  if (unplaced.length) {
    const usedRanks = new Set(rankOf.values());
    const openRanks = [];
    for (let r = 1; r <= n; r++) if (!usedRanks.has(r)) openRanks.push(r);
    const ordered = (regularSeasonOrder || []).filter((id) => unplaced.includes(id));
    ordered.forEach((id, i) => {
      if (i < openRanks.length) {
        rankOf.set(id, openRanks[i]);
        guessed.add(id);
      }
    });
  }

  return leagueFranchiseIds.map((id) => ({
    franchiseId: id,
    rank: rankOf.get(id) ?? null,
    total: n,
    guessed: guessed.has(id),
  }));
}

// ---- Weekly/season high-score payouts ---------------------------------------
// Given every fetched week's per-franchise point totals for one season
// (weeklyScoresByWeek: Map(week -> [{franchiseId, points}]) — a fixed weeks
// 1-18 window chosen by the caller, not the league's own regular season; see
// backfillLeagueScoringRecords in fetch-rosters.mjs), the facts a high-score
// payout needs. These are two DIFFERENT kinds of award, not two versions of
// the same one (confirmed directly with the user after an earlier version of
// this got it wrong): the weekly-high prize is awarded fresh EVERY week —
// week 1's highest scorer wins it, then week 2's highest scorer wins it
// again independently, and so on through week 18, so a single season can pay
// it out up to 18 times, possibly all to different franchises, possibly
// several to the same one. `weeklyHighs` is therefore one entry per week
// fetched, not a single "best week of the season" record — an earlier
// version of this function computed exactly that single record, which is
// the bug this shape replaces. The season-total prize, by contrast, really
// is a single once-a-season award — highest summed total wins it once — but
// only counts weeks 1-`seasonWeekLimit` (17): week 18 has its own weekly
// winner but never contributes to the season sum. `seasonWeekLimit` defaults
// to Infinity (every fetched week counts) only so a caller with no reason to
// exclude anything doesn't have to pass it; the real caller always passes
// 17. Unlike computeMflSeasonPlacements above, nothing here is ever a
// guess — every number is a hard sum/max over data actually fetched, with no
// gap-filling fallback, so a caller that couldn't fetch every week should
// not call this at all rather than get a number computed from a partial
// season (see backfillLeagueScoringRecords in fetch-rosters.mjs).
// A tie keeps whichever franchise the provider listed first that week —
// arbitrary but deterministic, same convention pickMainBracket above uses.
export function computeSeasonScoringRecords(weeklyScoresByWeek, nameById, seasonWeekLimit = Infinity) {
  const seasonTotals = new Map();
  const weeklyHighs = [];
  const weeks = [...weeklyScoresByWeek.keys()].sort((a, b) => Number(a) - Number(b));
  for (const week of weeks) {
    const totals = weeklyScoresByWeek.get(week);
    let best = null;
    for (const { franchiseId, points } of totals) {
      if (Number(week) <= seasonWeekLimit) {
        seasonTotals.set(franchiseId, (seasonTotals.get(franchiseId) || 0) + points);
      }
      if (!best || points > best.points) {
        best = { franchiseId, week, points };
      }
    }
    if (best) weeklyHighs.push(best);
  }
  let seasonHigh = null;
  for (const [franchiseId, points] of seasonTotals.entries()) {
    if (!seasonHigh || points > seasonHigh.points) {
      seasonHigh = { franchiseId, points };
    }
  }
  const withName = (rec) => (rec ? { ...rec, teamName: (nameById && nameById.get(rec.franchiseId)) || rec.franchiseId } : null);
  return { weeklyHighs: weeklyHighs.map(withName), seasonHigh: withName(seasonHigh) };
}

// ESPN's own computed final standing — confirmed against real data as a
// clean 1..N permutation across every team, independent of playoffSeed (a
// team can enter the playoffs 9th-seeded and finish 2nd overall). Never a
// guess: this is a value ESPN itself computes, not something derived here
// from partial data the way the MFL bracket walk is.
export function espnSeasonPlacement(team, totalTeams) {
  const rank = Number(team?.rankCalculatedFinal);
  if (!Number.isFinite(rank) || rank < 1) return null;
  return { rank, total: totalTeams, guessed: false };
}
