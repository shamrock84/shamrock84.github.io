// Asks ESPN's PUBLIC site API — not the fantasy-league API this project
// already talks to — whether it exposes an NFL team's depth chart
// (starter/backup ordering per position), now that probe-fantasypros-
// depth-charts.mjs confirmed the FantasyPros partner API doesn't have this
// at all (every candidate 403'd with "Missing Authentication Token", the
// unwired-route answer, against the same key that succeeds on
// consensus-rankings).
//
// This is a DIFFERENT ESPN surface from providers.mjs' espnGet: that one
// hits lm-api-reads.fantasy.espn.com, is cookie-authenticated (espn_s2/SWID)
// and scoped to one fantasy league. This probe hits the public,
// no-authentication site.api.espn.com / sports.core.api.espn.com hosts that
// serve espn.com's own team pages — commonly reverse-engineered elsewhere,
// never touched by this project before, and untested here. Every candidate
// below might 404, might require a different host or team identifier than
// guessed, or might come back shaped nothing like expected.
//
// This exists because none of these hosts are reachable from the sandbox
// this repo is normally edited from (confirmed: a direct curl from that
// sandbox to site.api.espn.com was rejected by the egress proxy) — same
// reason every other probe here exists. No API key, no cookies: read-only
// GETs against a public API.
//
// What it reports:
//   - a control request (the team-list endpoint, expected to need no
//     special resource path) — if THIS 404s or errors, the host itself is
//     unreachable or renamed, and every candidate below means nothing;
//   - each depth-chart candidate: HTTP status, content type, and the first
//     chunk of body, tried against both a team abbreviation (kc) and,
//     where the shape calls for it, ESPN's numeric team id (12, Chiefs) —
//     since ESPN's "core" API cluster identifies teams numerically, unlike
//     the site API's team pages;
//   - if any candidate hits, a dump of what a real team's depth chart
//     entry actually looks like, since the shape is the real deliverable —
//     just knowing "200" doesn't say whether it's usable.

const SITE_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const SAMPLE_TEAM_ABBR = 'kc';
const SAMPLE_TEAM_ID = 12; // Kansas City Chiefs, ESPN's numeric team id
const SEASON = new Date().getUTCFullYear();

async function probe(label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  try {
    const res = await fetch(url);
    const body = await res.text();
    console.log(`HTTP ${res.status}  content-type: ${res.headers.get('content-type') ?? '—'}  bytes: ${body.length}`);
    console.log(body.slice(0, 500).replace(/\s+/g, ' '));
    return { status: res.status, body };
  } catch (err) {
    console.log(`request failed: ${err.message}`);
    return { status: null, body: '' };
  }
}

// The control: a well-established public ESPN endpoint (the full NFL team
// list) that needs no team-specific guessing. Everything after this is
// interpreted relative to it — a candidate 404ing only means "wrong path"
// if the control itself came back clean.
const control = await probe('control: NFL team list (site API)', `${SITE_BASE}/teams`);
if (control.status !== 200) {
  console.error('\nControl request failed — site.api.espn.com is unreachable or renamed, so the candidate results below mean nothing.');
  process.exit(1);
}

const candidates = [
  ['team detail (site API, abbr)', `${SITE_BASE}/teams/${SAMPLE_TEAM_ABBR}`],
  ['roster (site API, abbr — depth order may just be array order, no explicit rank)', `${SITE_BASE}/teams/${SAMPLE_TEAM_ABBR}/roster`],
  ['depthchart sub-resource (site API, abbr)', `${SITE_BASE}/teams/${SAMPLE_TEAM_ABBR}/depthchart`],
  ['team detail with depthchart enabled (site API, abbr)', `${SITE_BASE}/teams/${SAMPLE_TEAM_ABBR}?enable=depthchart`],
  ['core API: team by numeric id', `${CORE_BASE}/teams/${SAMPLE_TEAM_ID}`],
  ['core API: depthcharts sub-resource, unscoped', `${CORE_BASE}/teams/${SAMPLE_TEAM_ID}/depthcharts`],
  ['core API: depthcharts sub-resource, season-scoped', `${CORE_BASE}/seasons/${SEASON}/teams/${SAMPLE_TEAM_ID}/depthcharts`],
];

let hit = null;
for (const [label, url] of candidates) {
  const result = await probe(`candidate: ${label}`, url);
  if (result.status === 200 && !hit) hit = { label, url, body: result.body };
}

if (hit) {
  console.log(`\n=== HIT: "${hit.label}" answered 200 — dumping its shape ===`);
  try {
    const data = JSON.parse(hit.body);
    console.log(`top-level keys: ${JSON.stringify(Object.keys(data))}`);
    console.log(JSON.stringify(data, null, 2).slice(0, 3000));
  } catch (err) {
    console.log(`(not JSON, or truncated) — ${err.message}`);
    console.log(hit.body.slice(0, 2000));
  }
} else {
  console.log('\n=== No candidate answered 200. The control host works, but none of the guessed depth-chart paths do. ===');
}
