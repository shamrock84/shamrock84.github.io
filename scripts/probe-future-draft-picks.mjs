// Asks MFL what it returns about a franchise's FUTURE (unmade) draft
// picks — the question behind a new "Draft Picks" section planned for
// Dynasty/Salary Cap Rosters cards. Nothing in this codebase has ever read
// this data before, so per this repo's own rule (see CLAUDE.md: "reaching
// for a new field on a provider response starts with a probe here, not with
// code that assumes the field is there") this exists to find out, rather
// than guess, what MFL calls the endpoint and what shape it returns.
//
// config/leagues.json confirms every current Dynasty/Salary Cap league is
// MFL-provider (no ESPN/Sleeper equivalent needed for the first version of
// this feature), so this probes MFL only.
//
// Two-pronged, since the endpoint name itself is unconfirmed:
//   1. MFL's own interactive API-info page (CCAT=export) lists every valid
//      TYPE value for the export endpoint — grepped for anything pick/draft
//      shaped, the same "ask the docs, don't guess" move
//      mflLoginForImport's own comment describes using for TYPE=lineup.
//   2. Each candidate TYPE is then hit for real, for one Dynasty and one
//      Salary Cap league, with and without FRANCHISE=<ours> to see whether
//      the endpoint is per-league (every franchise's picks) or needs
//      scoping to just our own.
//
// Read-only throughout. Run from the Actions tab (probe-future-draft-picks.yml).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const ROSTERS_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));

const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

let synced = new Map();
try {
  const prev = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
  synced = new Map((prev.leagues || []).map((l) => [l.id, l]));
} catch {
  console.log('No data/rosters.json — falling back to the calendar year.\n');
}
for (const league of leagues) {
  const season = synced.get(league.id)?.season;
  if (season && !league.season) league.season = String(season);
}

const dynasty = leagues.find((l) => l.type === 'dynasty' && (l.provider || 'mfl') === 'mfl' && l.franchiseId);
const salarycap = leagues.find((l) => l.type === 'salarycap' && (l.provider || 'mfl') === 'mfl' && l.franchiseId);
const sample = [dynasty, salarycap].filter(Boolean);

if (sample.length === 0) {
  console.log('No MFL Dynasty/Salary Cap league with a franchiseId found in config — nothing to probe.');
  process.exit(1);
}

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

console.log('='.repeat(72));
console.log('Step 1: MFL export API-info page, CCAT=export — looking for pick/draft-shaped TYPE values');
console.log('='.repeat(72));
for (const league of sample) {
  const season = seasonOf(league);
  const url = `https://api.myfantasyleague.com/${season}/api_info?STATE=test&CCAT=export`;
  try {
    const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
    const html = await res.text();
    console.log(`\n${league.name} season ${season}: HTTP ${res.status}, ${html.length} bytes`);
    // TYPE values appear as option value="..."> in the export-type dropdown.
    const optionRe = /<option\s+value="([^"]+)"/gi;
    const values = [];
    let m;
    while ((m = optionRe.exec(html))) values.push(m[1]);
    const pickish = values.filter((v) => /pick|draft/i.test(v));
    console.log(`  ${values.length} TYPE options total; pick/draft-shaped: ${pickish.join(', ') || '(none found)'}`);
  } catch (err) {
    console.log(`  api_info FAILED: ${err.message}`);
  }
}

console.log('\n' + '='.repeat(72));
console.log('Step 2: try each candidate TYPE for real');
console.log('='.repeat(72));

// Candidates worth trying regardless of what step 1 finds — MFL's docs
// dropdown doesn't always match the full set of TYPE values its export
// endpoint actually accepts.
const CANDIDATES = ['futureDraftPicks', 'draftPicks', 'assets', 'tradeBait'];

for (const league of sample) {
  const season = seasonOf(league);
  console.log(`\n--- ${league.name}  (L=${league.id}, franchise ${league.franchiseId}, season ${season}) ---`);
  for (const type of CANDIDATES) {
    for (const scoped of [false, true]) {
      const qs = scoped
        ? `TYPE=${type}&L=${league.id}&FRANCHISE=${league.franchiseId}&JSON=1`
        : `TYPE=${type}&L=${league.id}&JSON=1`;
      try {
        const data = await mflGet(`/export?${qs}`, cookie, season);
        const body = JSON.stringify(data);
        console.log(`  TYPE=${type}${scoped ? ' +FRANCHISE' : ''}: OK, ${body.length} bytes`);
        console.log(`    ${body.slice(0, 600)}`);
      } catch (err) {
        console.log(`  TYPE=${type}${scoped ? ' +FRANCHISE' : ''}: FAILED (${err.status ?? '?'}) ${err.message}`);
      }
    }
  }
}

console.log('\nDone. Look for: which candidate returned real pick data (not an error/empty');
console.log('shell), whether it needs FRANCHISE= to scope to us or returns every franchise');
console.log('at once, and the shape of one pick record (year, round, original owner if traded,');
console.log('any pick-number/slot field).');
