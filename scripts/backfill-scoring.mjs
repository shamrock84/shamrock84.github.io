#!/usr/bin/env node
// One-off, on-demand companion to fetch-rosters.mjs's backfillLeagueScoringRecords
// pass (see that function's own comment for the derivation and budget shape) —
// runs ONLY that pass, with a cookie and MFL rate-limit window of its own.
// Unlike backfillLeagueHistory, this pass is never invoked from the regular
// 4-hourly sync at all: a season's weekly totals cost roughly one MFL request
// PER week fetched (there is no bulk endpoint) — a fixed weeks 1-18 window
// rather than the league's own regular season, since these payouts run
// through a league's own playoff bracket too, and a weekly-high award can
// land on week 18 even though a season-total award never counts it past
// week 17 (see backfillLeagueScoringRecords's own comment) — up to 18
// requests for a typical season, expensive enough that folding it into a
// sync that already brushes MFL's rate limit fetching
// rosters/standings/scoring/lineups would risk the same 429 cascade
// documented on backfillLeagueHistory in fetch-rosters.mjs. This script is
// the only way it ever runs.
//
// Deliberately reads and writes data/rosters.json directly rather than
// re-deriving anything from config/leagues.json — mirrors backfill-history.mjs
// exactly, for the same reasons (every league object already on that file
// carries what's needed, and touching only `results[].scoring` is what keeps
// this from clobbering roster data a concurrently-running scheduled sync
// might be writing; the other half of that guarantee is this workflow
// sharing sync-fantasy-rosters.yml's concurrency group).
//
// LEAGUE_ID (optional, comma-separated) restricts the run to just those
// league ids — the direct answer to "backfill THIS league's high scores now"
// rather than waiting for its turn in iteration order (see
// SCORING_MFL_PER_LEAGUE_BUDGET's own comment for why a turn can be a long
// wait: a single season alone can approach the per-league budget).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin } from './lib/providers.mjs';
import { backfillLeagueScoringRecords } from './fetch-rosters.mjs';

const USERNAME = process.env.MFL_USERNAME;
const PASSWORD = process.env.MFL_PASSWORD;
const OUTPUT_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));

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
  // Independent copies — backfillLeagueScoringRecords mutates `results` on
  // these in place, and every other field on a league must pass through
  // untouched.
  const allLeagues = previous.leagues.map((l) => ({ ...l }));
  const leagues = targetLeagueIds.length
    ? allLeagues.filter((l) => targetLeagueIds.includes(String(l.id)))
    : allLeagues;
  if (targetLeagueIds.length) {
    console.log(`Restricting to league id(s): ${targetLeagueIds.join(', ')} (${leagues.length} matched)`);
  }

  const cookie = await mflLogin(USERNAME, PASSWORD);

  await backfillLeagueScoringRecords(leagues, previousById, cookie);

  // Write allLeagues, not the (possibly LEAGUE_ID-filtered) `leagues` — a
  // filtered league object is the SAME reference held in allLeagues, so
  // backfillLeagueScoringRecords' mutations are already visible there;
  // writing `leagues` instead would silently drop every league LEAGUE_ID
  // excluded from data/rosters.json entirely.
  const output = { ...previous, generatedAt: new Date().toISOString(), leagues: allLeagues };
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
