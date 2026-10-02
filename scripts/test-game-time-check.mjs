// Unit test for the game-time injury checker: api/_lib/gametime.mjs (the
// decisions) and api/game-time-check.js (auth, test mode, dry run), driven
// offline with fixtures shaped like what probe-inactives.mjs RUN 1 captured.
//
// Its failure that matters is a confident wrong answer on the manager's
// phone, so most of what's pinned here is about NOT saying "playing":
//
//   * a missing ESPN "Active" flag with no posted list is PENDING, never
//     playing (the Jalen Coker case from RUN 1);
//   * any single source saying Out/INACTIVE wins, whichever it is;
//   * a failed feed degrades to fewer signals, never to "playing";
//   * a same-named player on another team never lends his status;
//   * MFL's padded team codes (LVR) still find their game and posted list.
//
// And the notification rules: the first look at a slot always sends, even
// when everyone is playing (silence must mean "broken"); later polls send
// only on a change; a still-pending player near kickoff gets one final call.

import assert from 'node:assert/strict';
import {
  WATCH_LEAD_MINUTES,
  slotsInWindow,
  startersForSlot,
  parseEspnInjuries,
  parseEspnSummary,
  classify,
  watchedForSlot,
  planMessage,
} from '../api/_lib/gametime.mjs';

const NOW = new Date('2026-10-04T16:20:00Z'); // 12:20 PM ET
const EARLY = '2026-10-04T17:00:00Z'; // 40 minutes out
const LATE = '2026-10-04T20:25:00Z';

// fetchNflGames' shape: one entry per team, stored under every spelling.
function gamesMap(list) {
  const m = new Map();
  for (const g of list) {
    for (const [team, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      const entry = { id: g.id, team, opponent: opp, isHome: home, kickoff: g.kickoff, state: g.state || 'pre' };
      m.set(team, entry);
      for (const alias of g.aliases?.[team] || []) m.set(alias, entry);
    }
  }
  return m;
}
const GAMES = gamesMap([
  { id: '1', home: 'PHI', away: 'LAR', kickoff: EARLY },
  { id: '2', home: 'DEN', away: 'LV', kickoff: EARLY, aliases: { LV: ['LVR'] } },
  { id: '3', home: 'BUF', away: 'JAX', kickoff: EARLY },
  { id: '4', home: 'KC', away: 'BAL', kickoff: LATE },
]);

const player = (id, name, team, injuryStatus = null) => ({ id, name, team, injuryStatus, status: 'ROSTER' });
const SNAPSHOT = {
  year: '2026',
  leagues: [
    {
      id: '100', nickname: 'MNMx', type: 'dynasty', season: '2026', lineupWeek: 5,
      players: [
        player('p1', 'Saquon Barkley', 'PHI', 'Q'),
        player('p2', 'Brock Bowers', 'LVR', 'Q'),
        player('p3', 'Healthy Guy', 'PHI'),
        player('p4', 'Zay Flowers', 'BAL', 'Q'),
        player('p5', 'Bench Guy', 'PHI', 'Q'),
        player('p6', 'Josh Allen', 'JAX', 'Q'),
      ],
      starters: ['p1', 'p2', 'p3', 'p4', 'p6'],
    },
    {
      id: '200', provider: 'espn', displayName: 'NMLTLM', type: 'redraft', season: '2026', lineupWeek: 5,
      players: [player('9001', 'Saquon Barkley', 'PHI', 'Q')],
      starters: ['9001'],
    },
    { id: '300', type: 'draftonly', season: '2026', lineupWeek: 5, players: [player('x', 'Saquon Barkley', 'PHI', 'Q')], starters: ['x'] },
  ],
};

const plain = (x) => JSON.parse(JSON.stringify(x));
const feeds = ({ injuries = [], summary = [], mfl = {} } = {}) => ({
  espnInjuries: parseEspnInjuries({ injuries: [{ injuries: injuries.map(([name, status, team]) => ({ athlete: { displayName: name, team: { abbreviation: team } }, status })) }] }),
  summary: parseEspnSummary({
    injuries: [...new Set(summary.map((s) => s[2]))].map((team) => ({
      team: { abbreviation: team },
      injuries: summary.filter((s) => s[2] === team).map(([name, fantasy]) => ({ athlete: { displayName: name }, status: fantasy === 'INACTIVE' ? 'Out' : 'Questionable', details: { fantasyStatus: { abbreviation: fantasy } } })),
    })),
  }),
  mfl: new Map(Object.entries(mfl).map(([id, status]) => [id, { status }])),
});

// --- The window ---
{
  const slots = slotsInWindow(GAMES, NOW);
  assert.deepEqual([...slots.keys()], [EARLY], 'only kickoffs within the lead window');
  assert.deepEqual([...slots.get(EARLY)].sort(), ['1', '2', '3'], 'aliases do not duplicate a game');
  assert.equal(WATCH_LEAD_MINUTES, 45);
  const started = gamesMap([{ id: '9', home: 'NYG', away: 'DAL', kickoff: EARLY, state: 'in' }]);
  assert.equal(slotsInWindow(started, NOW).size, 0, 'a game under way is locked, not watched');
}

// --- Starters for a slot ---
const STARTERS = startersForSlot(SNAPSHOT, GAMES, EARLY);
{
  const names = [...STARTERS.values()].map((p) => p.name).sort();
  assert.deepEqual(names, ['Brock Bowers', 'Healthy Guy', 'Josh Allen', 'Saquon Barkley'], 'starters only, this kickoff only, no draftonly');
  const saquon = [...STARTERS.values()].find((p) => p.name === 'Saquon Barkley');
  assert.deepEqual(saquon.leagues, ['MNMx', 'NMLTLM'], 'one row per player across leagues');
  assert.deepEqual([...saquon.mflIds], ['p1'], 'only MFL-league ids join MFL\'s by-id feed');
  const bowers = [...STARTERS.values()].find((p) => p.name === 'Brock Bowers');
  assert.equal(bowers.team, 'LV', 'MFL\'s LVR resolves to the scoreboard team');
}
const get = (name) => [...STARTERS.values()].find((p) => p.name === name);

// --- Verdicts ---
// Nothing posted, nothing flagged: pending, never "playing" (the Coker case).
assert.equal(classify(get('Saquon Barkley'), feeds()).state, 'pending');
// Every feed missing entirely: still pending.
assert.equal(classify(get('Saquon Barkley'), { espnInjuries: null, summary: null, mfl: null }).state, 'pending');
// Any single source saying out wins.
assert.equal(classify(get('Saquon Barkley'), feeds({ injuries: [['Saquon Barkley', 'Out', 'PHI']] })).state, 'inactive');
assert.equal(classify(get('Saquon Barkley'), feeds({ summary: [['Saquon Barkley', 'INACTIVE', 'PHI']] })).state, 'inactive');
assert.equal(classify(get('Saquon Barkley'), feeds({ mfl: { p1: 'O' } })).state, 'inactive');
// Out beats a simultaneous Active elsewhere.
assert.equal(classify(get('Saquon Barkley'), feeds({ injuries: [['Saquon Barkley', 'Active', 'PHI']], mfl: { p1: 'O' } })).state, 'inactive');
// Playing: ESPN's Active flag, or the team's list posted without him.
assert.equal(classify(get('Saquon Barkley'), feeds({ injuries: [['Saquon Barkley', 'Active', 'PHI']] })).state, 'active');
assert.equal(classify(get('Saquon Barkley'), feeds({ summary: [['Some Scratch', 'INACTIVE', 'PHI']] })).state, 'active');
// Another team's posted list says nothing about him.
assert.equal(classify(get('Saquon Barkley'), feeds({ summary: [['Some Scratch', 'INACTIVE', 'LAR']] })).state, 'pending');
// A same-named player on another team never lends his status.
assert.equal(classify(get('Josh Allen'), feeds({ injuries: [['Josh Allen', 'Out', 'BUF']] })).state, 'pending');
// Aliased team: LV's posted list clears Bowers (MFL LVR).
assert.equal(classify(get('Brock Bowers'), feeds({ summary: [['Kwity Paye', 'INACTIVE', 'LV']] })).state, 'active');
// A settled designation needs no feed.
assert.equal(classify({ ...get('Saquon Barkley'), designation: 'IR' }, feeds()).state, 'inactive');

// --- Who a slot is about ---
{
  const w = watchedForSlot(STARTERS, feeds({ summary: [['Healthy Guy', 'INACTIVE', 'PHI']], injuries: [['Brock Bowers', 'Active', 'LV']] }));
  assert.deepEqual(plain(w.map((p) => [p.name, p.state])), [
    ['Healthy Guy', 'inactive'], // surprise scratch: undesignated, still reported
    ['Josh Allen', 'pending'],
    ['Brock Bowers', 'active'],
    ['Saquon Barkley', 'active'], // PHI's list is posted and he isn't on it
  ]);
  const quiet = watchedForSlot(STARTERS, feeds());
  assert.ok(!quiet.some((p) => p.name === 'Healthy Guy'), 'a healthy starter is not reported unless scratched');
}

// --- Notification rules ---
{
  const allPlaying = watchedForSlot(STARTERS, feeds({ summary: [['X', 'INACTIVE', 'PHI'], ['Y', 'INACTIVE', 'LV'], ['Z', 'INACTIVE', 'JAX']] }));
  const first = planMessage(allPlaying, null, 40, 'Sun 1:00 PM');
  assert.ok(first.message, 'the first look always sends, even when everyone plays');
  assert.equal(first.message.priority, 0);
  assert.match(first.message.title, /3 checked/);
  assert.match(first.message.body, /✅ Saquon Barkley PHI \(Q\): playing/);

  const again = planMessage(allPlaying, first.next, 35, 'Sun 1:00 PM');
  assert.equal(again.message, null, 'no change, no message');

  const pendingNow = watchedForSlot(STARTERS, feeds());
  const p1 = planMessage(pendingNow, null, 44, 'Sun 1:00 PM');
  assert.match(p1.message.body, /⏳ Saquon Barkley PHI \(Q\): not known yet/);
  const out = watchedForSlot(STARTERS, feeds({ mfl: { p1: 'O' } }));
  const p2 = planMessage(out, p1.next, 30, 'Sun 1:00 PM');
  assert.ok(p2.message, 'a change sends');
  assert.equal(p2.message.priority, 1, 'an inactive starter is high priority');
  assert.match(p2.message.body, /❌ Saquon Barkley PHI \(Q\): OUT — swap him — ruled out \(MFL\)\. MNMx, NMLTLM/);
  assert.ok(!/Brock Bowers/.test(p2.message.body), 'an update lists only what changed');

  const f1 = planMessage(out, p2.next, 9, 'Sun 1:00 PM');
  assert.ok(f1.message && /still no word on 2/.test(f1.message.title), 'final call for the still-pending');
  assert.equal(f1.message.priority, 1);
  assert.equal(planMessage(out, f1.next, 5, 'Sun 1:00 PM').message, null, 'the final call is sent once');

  assert.equal(planMessage([], null, 40, 'Sun 1:00 PM').message, null, 'nobody to watch, nothing to send');
}

// --- The endpoint: auth, test mode, dry run ---
{
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const u = String(url);
    if (u.includes('pushover')) return ok({ status: 1 });
    if (u.endsWith('/scoreboard')) {
      return ok({ events: [{ id: '1', competitions: [{ date: EARLY, status: { type: { state: 'pre' } }, competitors: [
        { homeAway: 'home', team: { abbreviation: 'PHI' } }, { homeAway: 'away', team: { abbreviation: 'LAR' } }] }] }] });
    }
    if (u.includes('rosters.json')) return ok(SNAPSHOT);
    if (u.endsWith('/injuries')) return ok({ injuries: [{ injuries: [{ athlete: { displayName: 'Saquon Barkley', team: { abbreviation: 'PHI' } }, status: 'Out' }] }] });
    if (u.includes('/summary')) return ok({ injuries: [] });
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  Object.assign(process.env, { GAMETIME_CHECK_SECRET: 's3cret', PUSHOVER_APP_TOKEN: 'app', PUSHOVER_USER_KEY: 'user' });
  delete process.env.MFL_USERNAME;
  const { default: handler } = await import('../api/game-time-check.js');
  const run = async (query, headers = {}) => {
    const out = {};
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    await handler({ query, headers }, res);
    return out;
  };

  assert.equal((await run({})).status, 401, 'no key, no check');
  assert.equal((await run({ key: 'wrong' })).status, 401);

  calls.length = 0;
  const test = await run({ key: 's3cret', test: '1' });
  assert.equal(test.status, 200);
  const push = calls.find((c) => c.url.includes('pushover'));
  assert.ok(push, 'test mode sends one notification');
  assert.equal(push.opts.body.get('token'), 'app');
  assert.equal(push.opts.body.get('user'), 'user');

  // Dry run with a real clock: pin "now" 40 minutes before kickoff.
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [NOW.getTime()])); }
    static now() { return NOW.getTime(); }
  };
  calls.length = 0;
  const dry = await run({ dryRun: '1' }, { authorization: 'Bearer s3cret' });
  globalThis.Date = RealDate;
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.ok(!calls.some((c) => c.url.includes('pushover')), 'a dry run never notifies');
  const slot = dry.body.slots[0];
  assert.equal(slot.kickoff, EARLY);
  assert.deepEqual(plain(slot.watched.find((p) => p.name === 'Saquon Barkley').state), 'inactive');
  assert.match(slot.message.title, /lineup change needed/);
}

console.log('Game-time check tests passed');
