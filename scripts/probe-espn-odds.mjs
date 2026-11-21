// Asks ESPN's PUBLIC endpoints whether they serve point spreads / totals /
// moneylines for NFL games, and in what shape, ahead of an NFL-tab spread
// column and a possible betting card. site.api.espn.com and friends are
// unreachable from the sandbox this repo is edited from (the egress proxy
// 403s them), same reason every other probe here exists. No key, no cookies,
// read-only GETs.
//
// What it checks, in order:
//   1. The scoreboard the app already reads: does `competitions[0].odds[]`
//      exist, for which provider, with which fields (details, spread,
//      overUnder, home/awayTeamOdds, open/close lines)? Reported for the
//      upcoming week AND the previous week, so we learn whether finished
//      games keep or lose their lines.
//   2. One game's `summary?event=ID`: `pickcenter[]` and `odds` (the richer
//      read: moneyline, spread odds, line movement).
//   3. The core API's per-event odds (`.../events/ID/competitions/ID/odds`),
//      which lists every provider rather than just the default one.
//   4. Sign convention: for each game with odds, prints home/away, the
//      `spread` number, the `details` string and which side is `favorite`,
//      so the sign of `spread` (home-relative or favorite-relative) is read
//      off real data instead of assumed.
//
// Candidates are guesses from the commonly reverse-engineered ESPN surface; a
// 404 on one is information, not failure. Record findings in a RUN 1 block
// here once it has been run, as the other probes do.
//
// Env: SEASON (default current year), WEEK (default: ESPN's current week),
// HEAD_CHARS (default 1800).

const season = process.env.SEASON || String(new Date().getFullYear());
const HEAD_CHARS = Number(process.env.HEAD_CHARS || 1800);
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';

function outline(value, depth, maxDepth, indent = '  ') {
  if (Array.isArray(value)) {
    const first = value.length ? outline(value[0], depth + 1, maxDepth, indent) : '';
    return `[${value.length}]${first ? ` of ${first}` : ''}`;
  }
  if (value && typeof value === 'object') {
    if (depth >= maxDepth) return `{${Object.keys(value).slice(0, 12).join(',')}}`;
    const pad = indent.repeat(depth + 1);
    const lines = Object.entries(value).slice(0, 30).map(([k, v]) => `${pad}${k}: ${outline(v, depth + 1, maxDepth, indent)}`);
    return `{\n${lines.join('\n')}\n${indent.repeat(depth)}}`;
  }
  return typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : String(value);
}

async function get(url, { show = true } = {}) {
  console.log(`\n=== ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    console.log(`  transport error: ${err.message}`);
    return null;
  }
  const text = await res.text();
  console.log(`  HTTP ${res.status}  ${res.headers.get('content-type') || ''}  ${text.length} bytes`);
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
  if (show) console.log(`  outline:\n${outline(json, 0, 4, '    ')}`);
  return json;
}

function printOdds(label, odds) {
  console.log(`  ${label}: ${Array.isArray(odds) ? `${odds.length} entries` : typeof odds}`);
  if (Array.isArray(odds)) for (const o of odds) console.log(`    ${JSON.stringify(o).slice(0, HEAD_CHARS)}`);
}

// ---- 1. Scoreboard: current week, then the week before ----
const current = await get(`${SITE}/scoreboard`, { show: false });
const currentWeek = Number(process.env.WEEK || current?.week?.number);
console.log(`\nESPN's current week: ${current?.week?.number} (season ${current?.season?.year}, type ${current?.season?.type})`);

const weeks = [currentWeek, currentWeek - 1].filter((w) => w >= 1);
let sampleEventId = null;
for (const week of weeks) {
  const url = `${SITE}/scoreboard?dates=${season}&seasontype=2&week=${week}`;
  const sb = await get(url, { show: week === currentWeek });
  const events = sb?.events ?? [];
  console.log(`\n--- week ${week}: ${events.length} events`);
  let withOdds = 0;
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === 'home')?.team?.abbreviation;
    const away = comp?.competitors?.find((c) => c.homeAway === 'away')?.team?.abbreviation;
    const odds = comp?.odds;
    const state = ev.status?.type?.state; // pre | in | post
    if (Array.isArray(odds) && odds.length) {
      withOdds++;
      sampleEventId ??= { id: ev.id, compId: comp.id, state };
      const o = odds[0];
      console.log(
        `  ${away} @ ${home} [${state}] provider=${o.provider?.name} details=${JSON.stringify(o.details)} spread=${o.spread} overUnder=${o.overUnder}` +
          ` homeFav=${o.homeTeamOdds?.favorite} awayFav=${o.awayTeamOdds?.favorite} homeML=${o.homeTeamOdds?.moneyLine} awayML=${o.awayTeamOdds?.moneyLine}`
      );
    } else {
      console.log(`  ${away} @ ${home} [${state}] NO odds (odds=${JSON.stringify(odds)?.slice(0, 80)})`);
    }
  }
  console.log(`  games with odds: ${withOdds}/${events.length}`);
  const first = events.find((e) => e.competitions?.[0]?.odds?.length);
  if (first) {
    console.log(`\n  FULL odds[] of ${first.shortName} (every field, every provider):`);
    printOdds('odds', first.competitions[0].odds);
  }
}

// ---- 2. Summary: pickcenter + odds for one game ----
if (sampleEventId) {
  console.log(`\n\n##### SUMMARY for event ${sampleEventId.id} (${sampleEventId.state}) #####`);
  const sum = await get(`${SITE}/summary?event=${sampleEventId.id}`, { show: false });
  if (sum) {
    console.log(`  top-level keys: ${Object.keys(sum).join(', ')}`);
    printOdds('pickcenter', sum.pickcenter);
    console.log(`  odds (top-level): ${JSON.stringify(sum.odds)?.slice(0, HEAD_CHARS)}`);
    console.log(`  againstTheSpread: ${JSON.stringify(sum.againstTheSpread)?.slice(0, HEAD_CHARS)}`);
  }

  // ---- 3. Core API: every provider, plus line movement ----
  console.log('\n\n##### CORE API odds #####');
  const coreOdds = await get(`${CORE}/events/${sampleEventId.id}/competitions/${sampleEventId.compId}/odds`);
  if (coreOdds) {
    console.log(`  count=${coreOdds.count} items=${coreOdds.items?.length}`);
    for (const it of coreOdds.items ?? []) console.log(`    ${JSON.stringify(it).slice(0, HEAD_CHARS)}`);
    const providerId = coreOdds.items?.[0]?.provider?.id;
    if (providerId) {
      await get(`${CORE}/events/${sampleEventId.id}/competitions/${sampleEventId.compId}/odds/${providerId}/history/0/movement`);
    }
  }
  await get(`${CORE}/events/${sampleEventId.id}/competitions/${sampleEventId.compId}/predictor`, { show: false });
} else {
  console.log('\nNo game in the sampled weeks carried odds; nothing further to follow. Try WEEK=<n> for an upcoming week.');
}

// ---- 4. Season-level ATS, the other betting-shaped surface ----
console.log('\n\n##### Team records against the spread #####');
await get(`${CORE}/seasons/${season}/types/2/teams/12/ats`);
