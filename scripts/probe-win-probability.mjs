// Answers whether MFL's win-probability / minutes-remaining metrics (visible
// on MFL's own live-scoring web page) are backed by a fetchable API field, or
// whether they're computed client-side in the page's own JS from data we
// already have.
//
// TYPE=liveScoring (what fetchScoring already reads — see
// scripts/probe-live-scoring-matchup.mjs) carries no "probability" field
// anywhere in its response, confirmed by grepping a full raw dump captured
// against a real in-progress week. gameSecondsRemaining IS already present
// there, both per-franchise (a total) and per-player, so "minutes remaining"
// needs no new source — it's franchise.gameSecondsRemaining / 60. Win
// probability is the open question this probe exists to answer.
//
// TYPE=league carries a `baseURL` field — the per-league website host, which
// export API responses don't otherwise expose. This probe uses it to fetch
// the actual live-scoring HTML page (logged in with the same session cookie
// mflLogin already produces) and searches the raw markup/JS for a
// probability figure or the endpoint that supplies one, since myfantasyleague.com
// is unreachable from anywhere except a GitHub Actions runner.
//
// Read-only. Run from the Actions tab (probe-win-probability.yml).
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const MFL_LEAGUE_ID = process.env.PROBE_MFL_LEAGUE_ID;
const WEEK = process.env.PROBE_WEEK || '1';

if (!MFL_LEAGUE_ID) {
  console.log('PROBE_MFL_LEAGUE_ID is required.');
  process.exit(1);
}

const league = { id: MFL_LEAGUE_ID };
const year = seasonOf(league);
console.log(`\n=== MFL league ${MFL_LEAGUE_ID}, season ${year}, week ${WEEK} ===\n`);

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

const leagueData = await mflGet(`/export?TYPE=league&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, year);
const rawBaseURL = leagueData?.league?.baseURL;
console.log(`baseURL from TYPE=league: ${rawBaseURL}`);

if (!rawBaseURL) {
  console.log('No baseURL on the league object — cannot locate the website host.');
  process.exit(0);
}

// baseURL already carries a scheme (https://www43.myfantasyleague.com) —
// prepending https:// again produces an invalid "https://https://..." URL
// that fails outright, which is exactly what happened the first time this
// probe ran.
const baseURL = rawBaseURL.replace(/^https?:\/\//, '');

const candidatePaths = [
  `/${year}/live?L=${MFL_LEAGUE_ID}`,
  `/${year}/livescoring?L=${MFL_LEAGUE_ID}`,
  `/${year}/scoring?L=${MFL_LEAGUE_ID}&W=${WEEK}`,
  `/${year}/options?L=${MFL_LEAGUE_ID}&O=14`,
  `/${year}/home/${MFL_LEAGUE_ID}`,
];

const KEYWORDS = ['winProb', 'win_prob', 'WinProbability', 'Win Probability', 'probability', 'minutesRemaining', 'minutes remaining', 'Minutes Remaining', 'timeRemaining'];

// Round 1 (26696/week1) found every guessed path either 404s or 500s except
// /home/{id}, which loads (200) but contains none of the keywords above —
// meaning the real "Live Scoring" page is linked from somewhere on this site
// under a path not guessed here. Rather than keep guessing, pull every link
// off the home page itself and follow the ones that look scoring/live-shaped
// — that's how a human actually finds this page.
const discoveredLinks = new Set();

for (const path of candidatePaths) {
  const url = `https://${baseURL}${path}`;
  console.log(`\n--- ${url} ---`);
  try {
    const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'follow' });
    console.log(`  status: ${res.status}, final url: ${res.url}`);
    if (!res.ok) continue;
    const body = await res.text();
    console.log(`  body length: ${body.length}`);

    // Any script src referencing something scoring/live/probability-shaped.
    const scriptSrcs = [...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((src) => /live|scor|prob/i.test(src));
    if (scriptSrcs.length) {
      console.log(`  relevant <script src> candidates:\n    ${scriptSrcs.join('\n    ')}`);
    }

    for (const kw of KEYWORDS) {
      const idx = body.toLowerCase().indexOf(kw.toLowerCase());
      if (idx === -1) continue;
      const start = Math.max(0, idx - 150);
      const end = Math.min(body.length, idx + 150);
      console.log(`  FOUND "${kw}" at offset ${idx}:\n    ...${body.slice(start, end).replace(/\s+/g, ' ')}...`);
    }

    // Any inline fetch()/XHR/ajax URL literals that look data-ish.
    const ajaxUrls = [...body.matchAll(/["'](\/[a-zA-Z0-9_\-./?=&]*(?:export|ajax|api|live|json)[a-zA-Z0-9_\-./?=&]*)["']/gi)]
      .map((m) => m[1]);
    const uniqueAjax = [...new Set(ajaxUrls)].slice(0, 20);
    if (uniqueAjax.length) {
      console.log(`  candidate ajax/data URLs referenced in the page:\n    ${uniqueAjax.join('\n    ')}`);
    }

    // Every <a href> whose text or URL looks scoring/live-shaped — this is
    // the actual site navigation, so it's the real way to find the page a
    // human clicks to rather than guessing more path literals.
    const anchorRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of body.matchAll(anchorRe)) {
      const [, href, text] = m;
      const plainText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (/live|scor|prob/i.test(href) || /live|scor|prob/i.test(plainText)) {
        discoveredLinks.add(`${href}  —  "${plainText}"`);
      }
    }
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }
}

if (discoveredLinks.size) {
  console.log(`\n--- links discovered on the fetched pages, matching live/scor/prob ---`);
  console.log(`  ${[...discoveredLinks].join('\n  ')}`);
} else {
  console.log(`\nNo live/scoring-shaped links found on any fetched page.`);
}

console.log('\n=== done ===');
