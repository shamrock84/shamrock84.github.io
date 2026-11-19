// Pins what backs fish.html (myFish): the trip validator and its seed data
// (api/_lib/fishtrips.mjs) and the fish resources on api/fam.js. What can drift
// silently:
//  - the seed no longer passing its own validator (the first Save from the Trips
//    tab would then be refused, with nothing wrong in what the user typed);
//  - a blank count turning into 0, or kept exceeding caught getting through;
//  - the fish Upstash keys colliding with another page's;
//  - who may do what: the trips and quick-links GETs are public, the tasks GET and
//    every POST need the login.
//
// Run: node scripts/test-fish.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import handler, { TASKS_KEY, QUICKLINKS_KEY, FISH_TASKS_KEY, FISH_QUICKLINKS_KEY, FISH_TRIPS_KEY, FISH_LURES_KEY, resetPhotosCache } from '../api/fam.js';
import { TASKS_KEY as VIKINGS_TASKS_KEY, QUICKLINKS_KEY as VIKINGS_QUICKLINKS_KEY } from '../api/vikings.js';
import { TASKS_KEY as BANGERS_TASKS_KEY, QUICKLINKS_KEY as BANGERS_QUICKLINKS_KEY } from '../api/bangers.js';
import { validateTrips, normalizeTrips, isRealDate, SEED_TRIPS } from '../api/_lib/fishtrips.mjs';
import { validateLures, normalizeLures, FISHING_TYPES } from '../api/_lib/fishlures.mjs';
import { createToken } from '../api/_lib/auth.mjs';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

check('the fish keys are their own, never another page\'s', () => {
  const fish = [FISH_TASKS_KEY, FISH_QUICKLINKS_KEY, FISH_TRIPS_KEY, FISH_LURES_KEY];
  const others = [TASKS_KEY, QUICKLINKS_KEY, VIKINGS_TASKS_KEY, VIKINGS_QUICKLINKS_KEY, BANGERS_TASKS_KEY, BANGERS_QUICKLINKS_KEY];
  for (const k of fish) assert.ok(!others.includes(k), `${k} is shared`);
  assert.equal(new Set(fish).size, fish.length);
});

check('the seed trips pass the validator and normalise to themselves', () => {
  assert.deepEqual(validateTrips({ trips: SEED_TRIPS }).errors, []);
  assert.deepEqual(normalizeTrips(SEED_TRIPS), SEED_TRIPS);
});

check('the seed matches the spreadsheet (2025: 100 caught, 31 kept; 2024: 102 / 28; 2022: 48 / 16)', () => {
  const totals = (t) => t.anglers.reduce((a, g) => g.days.reduce((b, d) => ({ caught: b.caught + (d.caught ?? 0), kept: b.kept + (d.kept ?? 0) }), a), { caught: 0, kept: 0 });
  const by = Object.fromEntries(SEED_TRIPS.map((t) => [t.year, totals(t)]));
  assert.deepEqual(by[2025], { caught: 100, kept: 31 });
  assert.deepEqual(by[2024], { caught: 102, kept: 28 });
  assert.deepEqual(by[2023], { caught: 50, kept: 24 });
  assert.deepEqual(by[2022], { caught: 48, kept: 16 });
  // 2026 is upcoming: every count blank (null), not 0.
  assert.ok(SEED_TRIPS[0].anglers.every((a) => a.days.every((d) => d.caught === null && d.kept === null)));
  // 2025's species counts add up to that day's fish kept.
  const t25 = SEED_TRIPS.find((t) => t.year === 2025);
  t25.days.forEach((d, j) => assert.equal(d.species.reduce((n, s) => n + s.count, 0), t25.anglers.reduce((n, a) => n + a.days[j].kept, 0)));
});

const one = () => JSON.parse(JSON.stringify(SEED_TRIPS.find((t) => t.year === 2025)));
const errorsFor = (mutate) => { const t = one(); mutate(t); return validateTrips({ trips: [t] }).errors; };

check('kept more than caught, a bad count, a missing day entry and a bad length are refused', () => {
  assert.equal(errorsFor((t) => { t.anglers[0].days[0].kept = 99; }).length, 1);
  assert.equal(errorsFor((t) => { t.anglers[0].days[0].caught = -1; }).length, 1);
  assert.equal(errorsFor((t) => { t.anglers[0].days[0].caught = 1.5; }).length, 1);
  assert.equal(errorsFor((t) => { t.anglers[0].days.pop(); }).length, 1);
  assert.equal(errorsFor((t) => { t.days[0].biggestInches = 0; }).length, 1);
  assert.equal(errorsFor((t) => { t.year = 25; }).length, 1);
});

check('blank counts stay null, and a name listed twice or an empty name is refused', () => {
  const t = one();
  t.anglers[0].days[0] = { caught: null, kept: null };
  assert.deepEqual(validateTrips({ trips: [t] }).errors, []);
  assert.deepEqual(normalizeTrips([t])[0].anglers[0].days[0], { caught: null, kept: null });
  assert.equal(errorsFor((x) => { x.anglers[1].name = ' braden '; }).length, 1);
  assert.equal(errorsFor((x) => { x.anglers[1].name = '  '; }).length, 1);
});

check('a trip date must be a real YYYY-MM-DD in the trip\'s year; blank or absent is fine', () => {
  assert.ok(isRealDate('2025-02-28') && isRealDate('2024-02-29'));
  for (const bad of ['2025-02-30', '2025-13-01', '2025-2-8', 'banana', '', null, 20250228]) assert.ok(!isRealDate(bad), String(bad));
  assert.deepEqual(errorsFor((t) => { t.date = '2025-02-28'; }), []);
  assert.deepEqual(errorsFor((t) => { t.date = ''; }), []);
  assert.deepEqual(errorsFor((t) => { t.date = null; }), []);
  assert.deepEqual(errorsFor((t) => { delete t.date; }), [], 'trips stored before dates existed still validate');
  assert.equal(errorsFor((t) => { t.date = '2025-02-30'; }).length, 1);
  assert.equal(errorsFor((t) => { t.date = '2026-02-28'; }).length, 1, 'a date in another year than the trip');
  assert.equal(normalizeTrips([Object.assign(one(), { date: '' })])[0].date, null);
  assert.equal(normalizeTrips([Object.assign(one(), { date: '2025-02-28' })])[0].date, '2025-02-28');
  const old = one(); delete old.date;
  assert.equal(normalizeTrips([old])[0].date, null, 'a stored trip without the field normalises to null');
  assert.ok(SEED_TRIPS.every((t) => t.date === null), 'the seed invents no dates');
});

check('duplicate or malformed ids and a non-array body are refused', () => {
  assert.equal(validateTrips({ trips: [one(), one()] }).errors.length, 1);
  assert.equal(errorsFor((t) => { t.id = 'bad id!'; }).length, 1);
  assert.ok(validateTrips({}).errors.length);
  assert.ok(validateTrips({ trips: 'x' }).errors.length);
});

check('normalizeTrips trims text and drops an empty species list', () => {
  const t = one();
  t.location = '  River   Bend ';
  t.days[0].species = [];
  const n = normalizeTrips([t])[0];
  assert.equal(n.location, 'River Bend');
  assert.ok(!('species' in n.days[0]));
});

check('fish.html carries the shared pieces (switcher tag, own endpoints, no other page\'s)', () => {
  const html = fs.readFileSync(new URL('../fish.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<script src="/site-switcher.js" data-site="fish"></script>'));
  for (const r of ['fishtrips', 'fishtasks', 'fishquicklinks', 'fishlures', 'fishphotos']) assert.ok(html.includes(`resource=${r}`) || html.includes(`resource: '${r}'`), r);
  assert.ok(!/resource=(tasks|quicklinks)\b/.test(html) && !/resource: '(tasks|quicklinks)'/.test(html), 'must not touch myFAM\'s resources');
});

const lure = (o = {}) => ({ id: 'l1', name: 'Jigging Rap', fishingType: 'Ice', lureType: 'Jigging spoon', waterBody: 'Lake of the Woods', location: 'Baudette, MN', notes: 'Tip with a minnow head', ...o });
const lureErrors = (o) => validateLures({ lures: [lure(o)] }).errors;

check('lures: a good one passes and normalises; only name and type of fishing are required', () => {
  assert.deepEqual(lureErrors(), []);
  const bare = { id: 'l2', name: '  Swedish   Pimple ', fishingType: 'Open water' };
  assert.deepEqual(validateLures({ lures: [bare] }).errors, []);
  assert.deepEqual(normalizeLures([bare])[0], { id: 'l2', name: 'Swedish Pimple', fishingType: 'Open water', lureType: '', waterBody: '', location: '', notes: '' });
  assert.deepEqual(validateLures({ lures: [] }).errors, []);
});

check('lures: a missing name, an unknown type of fishing, long text, a duplicate or bad id and a non-array body are refused', () => {
  assert.equal(lureErrors({ name: '  ' }).length, 1);
  assert.equal(lureErrors({ fishingType: 'Space' }).length, 1);
  assert.equal(lureErrors({ fishingType: undefined }).length, 1);
  assert.equal(lureErrors({ waterBody: 'x'.repeat(61) }).length, 1);
  assert.equal(lureErrors({ notes: 'x'.repeat(301) }).length, 1);
  assert.equal(lureErrors({ id: 'bad id!' }).length, 1);
  assert.equal(validateLures({ lures: [lure(), lure()] }).errors.length, 1);
  assert.ok(validateLures({}).errors.length);
  assert.ok(FISHING_TYPES.includes('Ice') && FISHING_TYPES.includes('Open water'));
});

// A tiny req/res pair. No store credentials are set, so a request that gets past
// the auth checks stops at "No store is configured" (500): 401 / 400 / 405 / 500
// tell the outcomes apart without any network.
async function call(method, { query, body, token } = {}) {
  const res = { code: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, end() { return this; } };
  res.json = function (b) { this.body = b; return this; };
  await handler({ method, query: query || {}, body: body || {}, headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
  return res.code;
}

const savedEnv = { ...process.env };
for (const k of Object.keys(process.env)) if (/^(UPSTASH|KV_|REDIS|STORAGE_)/.test(k)) delete process.env[k];
process.env.SESSION_SECRET = 'test-secret';
const good = createToken('test-secret');

for (const [name, run] of [
  ['the trips and quick-links GETs are public (reach the store check, not a 401)', async () => {
    assert.equal(await call('GET', { query: { resource: 'fishtrips' } }), 500);
    assert.equal(await call('GET', { query: { resource: 'fishquicklinks' } }), 500);
    assert.equal(await call('GET', { query: { resource: 'fishlures' } }), 500);
  }],
  ['the tasks GET needs a login', async () => {
    assert.equal(await call('GET', { query: { resource: 'fishtasks' } }), 401);
    assert.equal(await call('GET', { query: { resource: 'fishtasks' }, token: 'bogus' }), 401);
    assert.equal(await call('GET', { query: { resource: 'fishtasks' }, token: good }), 500);
  }],
  ['every POST needs a login', async () => {
    assert.equal(await call('POST', { body: { resource: 'fishtrips', trips: [] } }), 401);
    assert.equal(await call('POST', { body: { resource: 'fishquicklinks', links: [] } }), 401);
    assert.equal(await call('POST', { body: { resource: 'fishtasks', tasks: {} } }), 401);
    assert.equal(await call('POST', { body: { resource: 'fishlures', lures: [] } }), 401);
  }],
  ['the fish album is its own variable and cache: 503 without FISH_PHOTOS_ALBUM, even with myFAM\'s set', async () => {
    delete process.env.FISH_PHOTOS_ALBUM;
    process.env.FAM_PHOTOS_ALBUM = 'ABC123';
    resetPhotosCache();
    assert.equal(await call('GET', { query: { resource: 'fishphotos' } }), 503);
  }],
]) {
  try { await run(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}
for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
Object.assign(process.env, savedEnv);

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
