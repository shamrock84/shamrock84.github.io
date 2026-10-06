// Asks ESPN's PUBLIC endpoints whether they serve the NFL Football Power
// Index (FPI) — the model behind espn.com/nfl/fpi — and in what shape, so the
// NFL tab's Power Rankings card can be written against a real response
// instead of a guessed one. site.api.espn.com and friends are unreachable
// from the sandbox this repo is edited from (the egress proxy 403s them),
// same reason every other probe here exists. No key, no cookies, read-only
// GETs.
//
// For each candidate URL it reports: HTTP status, content type, top-level
// keys, a depth-limited outline of the JSON (array lengths, first element),
// and a trimmed head of the body. For the core API's `$ref` lists it also
// follows the first ref one level. Candidates are guesses from the commonly
// reverse-engineered ESPN surface; a 404 on one is information, not failure.
//
// RUN 1: (fill in after the first dispatch)

const season = process.env.SEASON || String(new Date().getFullYear());
const HEAD_CHARS = Number(process.env.HEAD_CHARS || 1800);

const CANDIDATES = [
  `https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en`,
  `https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en&season=${season}`,
  `https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en&season=${season}&seasontype=2`,
  `https://site.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex`,
  `https://site.web.api.espn.com/apis/v2/sports/football/nfl/powerindex`,
  `https://site.api.espn.com/apis/v2/sports/football/nfl/powerindex`,
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/powerindex/leaders`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/teams/12/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/teams/12/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/teams/12/ranks`,
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/12`,
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams`,
];

function outline(value, depth, maxDepth, indent = '  ') {
  if (Array.isArray(value)) {
    const first = value.length ? outline(value[0], depth + 1, maxDepth, indent) : '';
    return `[${value.length}]${first ? ` of ${first}` : ''}`;
  }
  if (value && typeof value === 'object') {
    if (depth >= maxDepth) return `{${Object.keys(value).slice(0, 12).join(',')}}`;
    const pad = indent.repeat(depth + 1);
    const lines = Object.entries(value).slice(0, 25).map(([k, v]) => `${pad}${k}: ${outline(v, depth + 1, maxDepth, indent)}`);
    return `{\n${lines.join('\n')}\n${indent.repeat(depth)}}`;
  }
  return typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : String(value);
}

async function get(url) {
  console.log(`\n=== ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    console.log(`  transport error: ${err.message}`);
    return null;
  }
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  console.log(`  HTTP ${res.status}  ${type}  ${text.length} bytes`);
  if (!res.ok) {
    console.log(`  body: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`  not JSON; head: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    return null;
  }
  console.log(`  outline:\n${outline(json, 0, 4, '    ')}`);
  console.log(`  head: ${text.slice(0, HEAD_CHARS)}`);
  return json;
}

// Mentions of power-index-ish names anywhere in a body, so a hit buried in an
// unrelated response (e.g. a team record's `ranks`) still gets noticed.
function mentionsFpi(json) {
  return /powerindex|fpi|"ranks"|powerrank/i.test(JSON.stringify(json));
}

for (const url of CANDIDATES) {
  const json = await get(url);
  if (!json) continue;
  console.log(`  mentions power index / ranks: ${mentionsFpi(json)}`);
  const ref = json.items?.[0]?.$ref;
  if (ref) await get(ref.replace(/^http:/, 'https:'));
}
