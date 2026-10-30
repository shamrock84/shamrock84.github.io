// Pins the league-meta cache (scripts/lib/league-meta.mjs) and how the sync uses
// it, plus the draft-only scoring skip that shipped with it.
//
// The cache answers "which franchise has which name, owner and division" from
// the last sync instead of asking MFL again, because those reads were about a
// fifth of every sync's MFL requests and the answers change a few times a year.
// Each case below is a way the cache would be wrong *silently*: a stale owner
// pinned for good, a failed fetch stored as "this league has no owners", a
// renamed team never refreshing, or the cache leaking into the file every
// visitor downloads.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LEAGUE_META_MAX_AGE_MS,
  leagueMetaMatches,
  leagueMetaIsFresh,
  packLeagueMeta,
  unpackLeagueMeta,
  resolveMflLeagueInfo,
  serializeLeagueMeta,
  parseLeagueMeta,
} from './lib/league-meta.mjs';

const NOW = new Date('2026-10-30T22:00:00Z');
const HOUR = 3600 * 1000;
const hoursAgo = (h) => new Date(NOW.getTime() - h * HOUR);
const league = (over = {}) => ({ id: '1', season: '2026', type: 'draftonly', ...over });

const maps = (over = {}) => ({
  nameById: new Map([['0001', 'Team One'], ['0002', 'Team Two']]),
  ownerById: new Map([['0001', 'Alex'], ['0002', null]]),
  divisionById: new Map([['0001', { id: '1', name: 'East' }]]),
  ...over,
});
const entryAt = (hours, over = {}, lg = league()) => ({ ...packLeagueMeta(maps(over), lg, hoursAgo(hours)) });

// ---- freshness ---------------------------------------------------------------
{
  assert.equal(LEAGUE_META_MAX_AGE_MS, 20 * HOUR, 'the same 20h rule as the free-agent pass');
  assert.equal(leagueMetaIsFresh(entryAt(1), league(), NOW), true, 'an hour old is fresh');
  assert.equal(leagueMetaIsFresh(entryAt(19.9), league(), NOW), true, 'just under 20h is fresh');
  assert.equal(leagueMetaIsFresh(entryAt(20), league(), NOW), false, '20h is due');
  assert.equal(leagueMetaIsFresh(entryAt(1), league(), NOW, true), false, 'a forced refresh ignores the cache');
  assert.equal(leagueMetaIsFresh(undefined, league(), NOW), false, 'no entry');
  assert.equal(leagueMetaIsFresh({ ...entryAt(1), fetchedAt: 'nonsense' }, league(), NOW), false, 'an unreadable timestamp');
  assert.equal(leagueMetaIsFresh({ ...entryAt(1), fetchedAt: new Date(NOW.getTime() + HOUR).toISOString() }, league(), NOW), false,
    'a timestamp in the future is not fresh forever');
  assert.equal(leagueMetaIsFresh(entryAt(1), league({ season: '2027' }), NOW), false, 'a season rollover invalidates it');
  assert.equal(leagueMetaIsFresh(entryAt(1), league({ type: 'dynasty' }), NOW), false, 'so does a type change');
  assert.equal(leagueMetaMatches(entryAt(100), league()), true, 'but an old entry still matches its own season and type');
}

// ---- Maps survive the trip through JSON --------------------------------------
{
  const original = maps();
  const back = unpackLeagueMeta(JSON.parse(JSON.stringify(packLeagueMeta(original, league(), NOW))));
  assert.deepEqual([...back.nameById], [...original.nameById]);
  assert.deepEqual([...back.ownerById], [...original.ownerById], 'a null owner stays null');
  assert.deepEqual([...back.divisionById], [...original.divisionById]);
  assert.deepEqual(unpackLeagueMeta(undefined), { nameById: new Map(), ownerById: new Map(), divisionById: new Map() }, 'a missing entry unpacks to empty maps');
}

// ---- resolveMflLeagueInfo: what is asked of MFL ------------------------------
function stubs({ ownersFail = false, leagueFail = false } = {}) {
  const calls = { league: 0, owners: 0 };
  const fresh = { nameById: new Map([['0001', 'Renamed Team'], ['0002', 'Team Two']]), divisionById: new Map() };
  return {
    calls,
    deps: {
      fetchLeagueData: async () => { calls.league++; if (leagueFail) throw new Error('boom'); return { marker: 'leagueData' }; },
      fetchOwners: async () => { calls.owners++; return ownersFail ? new Map() : new Map([['0001', 'Fresh Owner']]); },
      franchiseNames: () => fresh.nameById,
      franchiseDivisions: () => fresh.divisionById,
    },
  };
}
const resolve = (over, s) => resolveMflLeagueInfo({ league: league(), now: NOW, frozen: false, ...over, ...s.deps });

{
  // Frozen league with a fresh entry: no request at all.
  const s = stubs();
  const r = await resolve({ entry: entryAt(1), frozen: true }, s);
  assert.deepEqual(s.calls, { league: 0, owners: 0 }, 'a frozen league with a fresh entry costs nothing');
  assert.equal(r.leagueData, null, 'and there is no league data (it has no roster to build)');
  assert.equal(r.info.nameById.get('0001'), 'Team One', 'names come from the cache');
  assert.equal(r.info.ownerById.get('0001'), 'Alex', 'owners come from the cache');
  assert.equal(r.record, null, 'nothing to store');
  assert.equal(r.requestsSaved, 2);
}
{
  // A live league with a fresh entry: the generic read still happens (the roster
  // needs it), so names are current; only the regional owner read is skipped.
  const s = stubs();
  const r = await resolve({ entry: entryAt(1, {}, league({ type: 'dynasty' })), league: league({ type: 'dynasty' }), frozen: false }, s);
  assert.deepEqual(s.calls, { league: 1, owners: 0 }, 'only the owner read is saved');
  assert.deepEqual(r.leagueData, { marker: 'leagueData' }, 'the roster pass still gets its league data');
  assert.equal(r.info.nameById.get('0001'), 'Renamed Team', 'names are read live, never from the cache');
  assert.equal(r.info.ownerById.get('0001'), 'Alex', 'owners come from the cache');
  assert.equal(r.requestsSaved, 1);
}
{
  // Due, or nothing recorded yet: asked as before, and the answer is stored.
  for (const [label, entry] of [['expired', entryAt(21)], ['absent', undefined]]) {
    for (const frozen of [true, false]) {
      const s = stubs();
      const r = await resolve({ entry, frozen }, s);
      assert.deepEqual(s.calls, { league: 1, owners: 1 }, `${label}, frozen=${frozen}: both reads happen`);
      assert.equal(r.info.ownerById.get('0001'), 'Fresh Owner');
      assert.equal(r.record.fetchedAt, NOW.toISOString(), `${label}: the refresh is stamped`);
      assert.equal(r.record.nameById['0001'], 'Renamed Team', 'and carries the names it just read');
      assert.equal(r.requestsSaved, 0);
    }
  }
  const s = stubs();
  await resolve({ entry: entryAt(1), frozen: true, force: true }, s);
  assert.deepEqual(s.calls, { league: 1, owners: 1 }, 'a forced refresh reads everything, frozen or not');
}
{
  // The regional read swallows its own errors into an empty map. That must never
  // be stored as "this league has no owners".
  const s = stubs({ ownersFail: true });
  const none = await resolve({ entry: undefined }, s);
  assert.equal(none.info.ownerById.size, 0, 'with nothing to fall back on, owners are empty as before');
  assert.equal(none.record, null, 'and the empty answer is not stored');

  const s2 = stubs({ ownersFail: true });
  const stale = await resolve({ entry: entryAt(500) }, s2);
  assert.equal(stale.info.ownerById.get('0001'), 'Alex', 'a failed refresh keeps the old owners, however old');
  assert.equal(stale.record, null, 'and does not restamp the old entry as fresh');
  assert.equal(stale.info.nameById.get('0001'), 'Renamed Team', 'names are still current');

  const s3 = stubs({ ownersFail: true });
  const wrongSeason = await resolve({ entry: entryAt(500), league: league({ season: '2027' }) }, s3);
  assert.equal(wrongSeason.info.ownerById.size, 0, "a stale entry from another season is not used as a fallback");

  const s4 = stubs({ leagueFail: true });
  await assert.rejects(resolve({ entry: undefined }, s4), /boom/, 'a failed league read still fails the league, as it always did');
}

// ---- the file ----------------------------------------------------------------
{
  const entries = {
    '1': packLeagueMeta(maps(), league(), NOW),
    '2': packLeagueMeta(maps(), league({ id: '2' }), NOW),
    '3': packLeagueMeta(maps(), league({ id: '3' }), NOW),
  };
  const text = serializeLeagueMeta(entries, ['1', '3']);
  assert.ok(text.endsWith('\n'), 'ends with a newline');
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed.leagues), ['1', '3'], 'a league that left the config leaves the file');
  assert.equal(text.split('\n').filter((l) => l.startsWith('"1":') || l.startsWith('"3":')).length, 2, 'one league per line, for readable diffs');
  assert.deepEqual(parseLeagueMeta(text), parsed.leagues, 'parse is the inverse');
  assert.deepEqual(parseLeagueMeta(''), {}, 'a missing file starts empty');
  assert.deepEqual(parseLeagueMeta('{not json'), {}, 'a corrupt file starts empty');
  assert.deepEqual(parseLeagueMeta('{"version":99,"leagues":{"1":{}}}'), {}, 'a format this code does not know starts empty');
  assert.equal(serializeLeagueMeta(entries, ['1', '3']), serializeLeagueMeta(entries, ['1', '3']), 'stable output, so an unchanged cache is no diff');
}

// ---- how the sync wires it ---------------------------------------------------
{
  const src = readFileSync(new URL('./fetch-rosters.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function main()'));

  assert.ok(/LEAGUE_META_PATH\s*=\s*fileURLToPath\(new URL\('\.\.\/data\/mfl-league-meta\.json'/.test(src), 'the cache is its own file');
  assert.notEqual(src.match(/OUTPUT_PATH\s*=[^;]+;/)?.[0], src.match(/LEAGUE_META_PATH\s*=[^;]+;/)?.[0], 'and not the snapshot');

  // Never a field of what every visitor downloads.
  const outputAt = body.indexOf('const output = {');
  const outputEnd = body.indexOf('};', outputAt);
  assert.ok(outputAt > 0 && outputEnd > outputAt, 'found the snapshot object');
  assert.ok(!/leagueMeta|nameById|ownerById/.test(body.slice(outputAt, outputEnd)), 'the cache is not part of the snapshot');

  // Decided before the league data is read, and the frozen flag is what lets the reads be skipped.
  assert.ok(
    body.indexOf('const frozen = draftonlyRosterIsSettled') < body.indexOf('resolveMflLeagueInfo({'),
    'the freeze is decided before the league reads'
  );
  assert.ok(/frozen,\s*\n\s*now,/.test(body), 'and handed to the resolver');

  // Draft-only scoring is skipped by type, standings never are.
  const scoringLoop = body.lastIndexOf('for (const league of LEAGUES)', body.indexOf('fetchScoring(league, cookie'));
  const scoringGuard = body.slice(scoringLoop, body.indexOf('fetchScoring(league, cookie'));
  assert.ok(/league\.type === 'draftonly'/.test(scoringGuard), 'scoring skips draft-only leagues by type');
  assert.ok(!/frozen|draftonlyRosterIsSettled/.test(scoringGuard), 'and not by the roster freeze');
  const standingsLoop = body.lastIndexOf('for (const league of LEAGUES)', body.indexOf('fetchStandings(league, cookie'));
  assert.ok(!/draftonly/.test(body.slice(standingsLoop, body.indexOf('fetchStandings(league, cookie'))), 'standings still run for draft-only leagues');
}

console.log('test-league-meta: ok');
