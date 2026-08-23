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
// bottom half, commonly each with its own 2-team "Consolation" decider for
// the placement tier just below the main bracket's final. Bracket NAMES are
// commissioner-chosen free text — seen in the wild: "Fantasy Bowl", "Sole
// Survivor", "Championship Bracket", and "Champions Bracket" all mean the
// same top bracket across different leagues in this config, while "Toilet
// Bowl" always means the bottom one — so classification is by keyword, not
// an exhaustive name list: anything containing "toilet" is the bottom
// family, everything else defaults to the top family, and "consolation" in
// the name marks a bracket as that family's second-tier decider rather than
// its main bracket. The two families are treated identically otherwise: in
// both, the main bracket's final winner takes the family's best open rank
// and the loser the next, exactly mirroring how the top family's
// "champion" and "runner-up" work for the bottom family's "escaped last"
// and "confirmed last" — a Toilet Bowl is not scored backwards.
//
// Within one family, exactly two finals settle up to four placements: the
// main bracket's (winner/loser take the family's first two open ranks) and
// its consolation's (winner/loser take the next two). Any team who played
// in the main bracket but reached neither final — a bye-less team
// eliminated in an early round, with no consolation game to catch it —
// gets its rank by elimination when there is exactly one such team (the
// common case: a 5-team bracket with one consolation game accounts for 4 of
// the 5, leaving the fifth determined by there being nothing else left to
// assign, not a guess). Two or more such leftovers, or a family with no
// bracket at all, is a genuine gap bracket data can't resolve on its own —
// those teams are ordered by regular-season standing instead and flagged
// `guessed: true`, so the UI can show them differently (in red) rather than
// presenting a guess as settled fact.

const TOILET_BOWL_RE = /toilet/i;
const CONSOLATION_RE = /consolation/i;

export function bracketFamily(name) {
  return TOILET_BOWL_RE.test(name || '') ? 'bottom' : 'top';
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
  for (const b of brackets || []) groups[bracketFamily(b.name)].push(b);
  return groups;
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
    const main = familyBrackets.find((b) => !isConsolationBracket(b.name));
    if (!main) continue;
    const consolation = familyBrackets.find((b) => isConsolationBracket(b.name));
    const size = Number(main.teamsInvolved) || null;

    const mainData = bracketDataById.get(String(main.id)) || null;
    const familyMembers = mainData ? franchisesInBracket(mainData) : new Set();
    let lo = nextLo;

    const mainResult = mainData ? resolveGame(finalGame(mainData)) : null;
    if (mainResult) {
      rankOf.set(mainResult.winnerId, lo);
      rankOf.set(mainResult.loserId, lo + 1);
      lo += 2;
    }

    if (consolation) {
      const cData = bracketDataById.get(String(consolation.id)) || null;
      const cResult = cData ? resolveGame(finalGame(cData)) : null;
      if (cResult) {
        rankOf.set(cResult.winnerId, lo);
        rankOf.set(cResult.loserId, lo + 1);
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
