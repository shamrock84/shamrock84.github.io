#!/usr/bin/env node
// Asks a provider what it actually says about a league in a season that may not
// exist yet, and prints the raw answer.
//
// Why this exists: resolveSeason in fetch-rosters.mjs decides whether a league
// has rolled over by asking whether it exists in the target season. That answer
// is only as good as the detection, and neither provider documents what a
// missing league-year looks like. This is how that gets confirmed against the
// real API rather than assumed — the sandbox this repo is usually edited from
// can't reach myfantasyleague.com, ESPN, or Sleeper at all.
//
// Run it from the Actions tab (probe-league-season.yml) with one season the
// league is definitely in and one it cannot possibly be — the useful result is
// the two side by side.
//
// Both confirmed 2026-08. MFL (league 26696): a season the league is in returns
// {encoding, league, version}; one it isn't in returns HTTP 404. ESPN (league
// 1966972): a season it's in returns a body with id/seasonId/settings; one it
// isn't in returns HTTP 404 with a JSON GENERAL_NOT_FOUND payload.
//
// ESPN has a wrinkle MFL doesn't, and it's the main reason to run this: expired
// or missing espn_s2/SWID cookies make every request fail, which reads as "the
// season doesn't exist" for BOTH seasons. That's safe (the league just stays
// where it is) but it would mean an ESPN league silently never rolls over. So
// the check that matters is the control season coming back true — if it doesn't,
// the answer says nothing about seasons and everything about the cookies.
//
// Sleeper is deliberately absent. Its league endpoint has no season dimension
// (/v1/league/{id}, no year), a new season is a whole new league id, and the old
// id answers forever — so there is no question to ask. See resolveSeason.
//
// Read-only throughout: TYPE=league and view=mSettings. Nothing is written.

import {
  mflLogin,
  mflGet,
  mflLeagueExists,
  espnGet,
  espnLeagueExists,
  YEAR,
} from './lib/providers.mjs';

const MFL_LEAGUE_ID = process.env.PROBE_MFL_LEAGUE_ID;
const ESPN_LEAGUE_ID = process.env.PROBE_ESPN_LEAGUE_ID;
const SEASONS = (process.env.PROBE_SEASONS || `${YEAR},${Number(YEAR) + 1}`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!MFL_LEAGUE_ID && !ESPN_LEAGUE_ID) {
  console.error('Set PROBE_MFL_LEAGUE_ID and/or PROBE_ESPN_LEAGUE_ID (ids from config/leagues.json).');
  process.exit(1);
}

// The first season given is the control: the league is expected to be in it.
// Every other season is the real question.
const [control] = SEASONS;
const verdicts = [];

if (MFL_LEAGUE_ID) {
  console.log(`=== MFL league ${MFL_LEAGUE_ID} — seasons ${SEASONS.join(', ')} ===\n`);
  const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

  for (const season of SEASONS) {
    console.log(`--- ${season} ---`);
    // Raw first, so the actual response shape is visible whatever it turns out
    // to be. This is the part that can't be guessed from a sandbox.
    try {
      const raw = await mflGet(`/export?TYPE=league&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, season);
      console.log(`  raw: resolved, top-level keys: ${JSON.stringify(Object.keys(raw || {}))}`);
      if (raw?.error) console.log(`  raw: carries an "error" field: ${JSON.stringify(raw.error)}`);
      if (raw?.league) console.log(`  raw: league.id=${JSON.stringify(raw.league.id)} name=${JSON.stringify(raw.league.name)}`);
      console.log(`  body (first 300 chars): ${JSON.stringify(raw).slice(0, 300)}`);
    } catch (err) {
      console.log(`  raw: threw — ${err.message}`);
    }
    const verdict = await mflLeagueExists({ id: MFL_LEAGUE_ID }, cookie, season);
    console.log(`  mflLeagueExists -> ${verdict}\n`);
    verdicts.push({ provider: 'MFL', season, verdict });
  }
}

if (ESPN_LEAGUE_ID) {
  console.log(`=== ESPN league ${ESPN_LEAGUE_ID} — seasons ${SEASONS.join(', ')} ===\n`);
  // Said out loud, because without these every season below reads as "missing"
  // and the run would otherwise look like a clean set of negative answers.
  const haveCookies = Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID);
  console.log(`  espn_s2/SWID present: ${haveCookies}`);
  if (!haveCookies) {
    console.log('  Without them every answer below is false regardless of season.\n');
  }

  for (const season of SEASONS) {
    console.log(`--- ${season} ---`);
    try {
      const raw = await espnGet({ id: ESPN_LEAGUE_ID, provider: 'espn', season }, 'view=mSettings');
      console.log(`  raw: resolved, top-level keys: ${JSON.stringify(Object.keys(raw || {}))}`);
      console.log(`  raw: id=${JSON.stringify(raw?.id)} name=${JSON.stringify(raw?.settings?.name)}`);
      console.log(`  body (first 300 chars): ${JSON.stringify(raw).slice(0, 300)}`);
    } catch (err) {
      // The status code is the thing to read here: a 404 means the season
      // genuinely isn't there, a 401 means the cookies are stale. Both
      // currently resolve to false, which is why they have to be told apart
      // by eye rather than by the return value.
      console.log(`  raw: threw — ${err.message}`);
    }
    const verdict = await espnLeagueExists({ id: ESPN_LEAGUE_ID, provider: 'espn' }, season);
    console.log(`  espnLeagueExists -> ${verdict}\n`);
    verdicts.push({ provider: 'ESPN', season, verdict });
  }
}

// ---- what the run means ----
console.log('=== summary ===');
for (const v of verdicts) console.log(`  ${v.provider} ${v.season} -> ${v.verdict}`);

let bad = 0;
for (const provider of [...new Set(verdicts.map((v) => v.provider))]) {
  const rows = verdicts.filter((v) => v.provider === provider);
  const controlRow = rows.find((v) => v.season === control);
  const others = rows.filter((v) => v.season !== control);

  if (controlRow && !controlRow.verdict) {
    console.log(`\n  ${provider}: FAIL — the control season ${control} came back false.`);
    console.log('    The league should exist there, so this is a credentials or connectivity');
    console.log('    problem, not a season one. Detection cannot be trusted until it passes.');
    bad++;
  }
  const wrong = others.filter((v) => v.verdict);
  if (wrong.length) {
    console.log(`\n  ${provider}: FAIL — season(s) ${wrong.map((v) => v.season).join(', ')} came back true.`);
    console.log('    A season the league is not in must read as false, or resolveSeason will');
    console.log(`    roll it forward into an empty season. ${provider === 'MFL' ? 'mflLeagueExists' : 'espnLeagueExists'} needs to`);
    console.log('    account for whatever shape the body above actually has.');
    bad++;
  }
  if (controlRow?.verdict && !wrong.length) {
    console.log(`\n  ${provider}: OK — present season true, absent season(s) false.`);
  }
}

// Exit non-zero on a bad result so the run goes red in the Actions list rather
// than sitting there green with a failure buried in the log.
process.exit(bad === 0 ? 0 : 1);
