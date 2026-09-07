// Diagnoses a live production symptom: api/live-scoring.js reports
// "No live scoring available yet" for most MFL leagues right now, even
// though probe-live-scoring-matchup.yml (a single fresh login, single
// request) gets a full liveScoring.matchup[] back for the same league at
// the same moment. The one thing genuinely different between those two call
// sites is repetition: the Vercel function reuses one cached login cookie
// across ~30s polls for as long as the Scoring tab stays open, so by now
// that cookie has made many dozens of TYPE=liveScoring requests across many
// leagues. This probe logs in ONCE and then repeats TYPE=liveScoring for the
// same league several times back-to-back on that one session, to see
// whether repetition itself is what makes the matchup array go empty.
//
// Read-only. Run from the Actions tab (probe-live-scoring-empty.yml).
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const LEAGUE_IDS = (process.env.PROBE_MFL_LEAGUE_IDS || '26696').split(',').map((s) => s.trim());
const REPEATS = Number(process.env.PROBE_REPEATS || '8');
const DELAY_MS = Number(process.env.PROBE_DELAY_MS || '2000');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Logging in once, then hitting TYPE=liveScoring ${REPEATS} times per league, ${DELAY_MS}ms apart.`);
const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
console.log('Login OK.\n');

for (const leagueId of LEAGUE_IDS) {
  const league = { id: leagueId };
  const year = seasonOf(league);
  console.log(`=== league ${leagueId}, season ${year} ===`);
  for (let i = 1; i <= REPEATS; i++) {
    const started = Date.now();
    try {
      const data = await mflGet(`/export?TYPE=liveScoring&L=${leagueId}&JSON=1`, cookie, year);
      const matchup = data?.liveScoring?.matchup;
      const matchupCount = Array.isArray(matchup) ? matchup.length : matchup ? 1 : 0;
      const topKeys = Object.keys(data?.liveScoring || {});
      console.log(`  [${i}/${REPEATS}] +${Date.now() - started}ms matchupCount=${matchupCount} topKeys=${topKeys.join(',')}`);
      if (matchupCount === 0) {
        console.log(`      FULL EMPTY BODY: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      console.log(`  [${i}/${REPEATS}] +${Date.now() - started}ms FAILED: ${err.message}`);
    }
    if (i < REPEATS) await sleep(DELAY_MS);
  }
  console.log('');
}

console.log('=== done ===');
