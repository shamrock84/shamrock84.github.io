#!/usr/bin/env node
// One-off, on-demand companion to fetch-rosters.mjs's own History backfill
// pass (see backfillLeagueHistory there for the derivation and the budget
// shape) — runs ONLY that pass, with a cookie and MFL rate-limit window of
// its own, and none of the roster/standings/scoring/lineup requests the
// regular sync spends first. That main sync already brushes MFL's rate
// limit before the backfill even starts, which is what corrupted real data
// once (see CLAUDE.md's History section): a bracket fetch 429ing mid-year
// used to look identical to "this bracket doesn't exist." Dispatching this
// script on its own, via backfill-history.yml, gives the backfill an
// essentially uncontested budget instead of MFL's leftover scraps.
//
// Deliberately reads and writes data/rosters.json directly rather than
// re-deriving anything from config/leagues.json: every league object
// already on that file carries exactly what backfillLeagueHistory needs
// (id, name, type, provider, franchiseId, season), and touching only
// `results` / `historyBoundaryYear` on top of it is what keeps this from
// clobbering roster data a concurrently-running scheduled sync might be
// writing — the other half of that guarantee is backfill-history.yml and
// sync-mfl-rosters.yml sharing one concurrency group, so GitHub Actions
// queues them instead of letting both commit to the same file at once.
//
// One consequence worth knowing: this trusts whatever `season` a league is
// already recorded against rather than re-resolving it (resolveSeason needs
// the full previous-sync context this script doesn't load). A league that
// has just rolled over but hasn't been picked up by a regular sync yet
// won't have its newly-completed season backfilled here until that catches
// up — a bounded, self-correcting gap, not a wrong answer, and the regular
// sync still runs every 4 hours regardless of this script.
//
// LEAGUE_ID (optional, comma-separated) restricts the run to just those
// league ids. This exists because HISTORY_MFL_PER_LEAGUE_BUDGET caps but
// doesn't eliminate one league crowding out another's turn in a given run —
// a league with a long-enough tail of guessed years can still occupy every
// per-league slot the budget affords before an unlucky later league is
// reached. Naming a league id sidesteps the queue entirely: the whole
// budget goes to that league alone, which is the direct answer to "backfill
// THIS league now" rather than waiting for its turn in iteration order.
const targetLeagueIds = (process.env.LEAGUE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

async function main() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('MFL_USERNAME and MFL_PASSWORD environment variables are required.');
  }

  const previous = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
  const previousById = new Map(previous.leagues.map((l) => [l.id, l]));
  // Independent copies — backfillLeagueHistory mutates `results` /
  // `historyBoundaryYear` on these in place, and every other field on a
  // league (rosters, standings, scoring, lineups, power, ...) must pass
  // through untouched.
  const allLeagues = previous.leagues.map((l) => ({ ...l }));
  const leagues = targetLeagueIds.length
    ? allLeagues.filter((l) => targetLeagueIds.includes(String(l.id)))
    : allLeagues;
  if (targetLeagueIds.length) {
    console.log(`Restricting to league id(s): ${targetLeagueIds.join(', ')} (${leagues.length} matched)`);
  }

  const cookie = await mflLogin(USERNAME, PASSWORD);

  await backfillLeagueHistory(leagues, previousById, cookie);

  // Write allLeagues, not the (possibly LEAGUE_ID-filtered) `leagues` — a
  // filtered league object is the SAME reference held in allLeagues (filter
  // doesn't clone elements), so backfillLeagueHistory's mutations are
  // already visible there; writing `leagues` instead would silently drop
  // every league LEAGUE_ID excluded from data/rosters.json entirely.
  const output = { ...previous, generatedAt: new Date().toISOString(), leagues: allLeagues };
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
