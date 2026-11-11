// Unit tests for api/bangers.js's pure parts: the validation that is the only
// guard on what reaches the store (and, through the public GET, every
// visitor), the normalisation that decides what is kept, and the stale-copy
// check that stops a second device from erasing the first one's edits.
//
// Run: node scripts/test-bangers.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler, { validateBangers, normalizeBangers, serialize, isStaleBase, TASKS_KEY, QUICKLINKS_KEY } from '../api/bangers.js';
import { TASKS_KEY as VIKINGS_TASKS_KEY, QUICKLINKS_KEY as VIKINGS_QUICKLINKS_KEY } from '../api/vikings.js';
import { createToken } from '../api/_lib/auth.mjs';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

const nominee = (over = {}) => ({ id: 'n1', title: 'Cruise', artist: 'Florida Georgia Line', by: 'Kevin', winner: true, ...over });
const year = (over = {}) => ({ id: 'y1', label: '2023', nominees: [nominee()], ...over });
const ok = (years) => validateBangers({ years }).errors.length === 0;

check('accepts a normal list', () => assert.ok(ok([year(), year({ id: 'y2', label: 'Grandfathered', nominees: [nominee({ id: 'n2' })] })])));
check('accepts an empty list and a year with no nominees', () => {
  assert.ok(ok([]));
  assert.ok(ok([year({ nominees: [] })]));
});
check('accepts several winners in one year', () => {
  assert.ok(ok([year({ nominees: [nominee(), nominee({ id: 'n2', title: 'Out Last Night' })] })]));
});
check('artist, by and winner may be left out', () => {
  assert.ok(ok([year({ nominees: [{ id: 'n1', title: 'Cruise' }] })]));
});
check('rejects a body that is not { years: [] }', () => {
  assert.ok(validateBangers(null).errors.length);
  assert.ok(validateBangers([]).errors.length);
  assert.ok(validateBangers({}).errors.length);
  assert.ok(validateBangers({ years: {} }).errors.length);
});
check('rejects a year with no name, or one that is too long', () => {
  assert.ok(!ok([year({ label: '   ' })]));
  assert.ok(!ok([year({ label: 'x'.repeat(41) })]));
});
check('rejects a nominee with no title', () => {
  assert.ok(!ok([year({ nominees: [nominee({ title: ' ' })] })]));
});
check('rejects over-long or mistyped fields', () => {
  assert.ok(!ok([year({ nominees: [nominee({ title: 'x'.repeat(121) })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ artist: 'x'.repeat(121) })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ by: 'x'.repeat(61) })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ artist: 5 })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ winner: 'yes' })] })]));
});
check('rejects bad or duplicate ids', () => {
  assert.ok(!ok([year({ id: 'a b' })]));
  assert.ok(!ok([year({ id: '' })]));
  assert.ok(!ok([year(), year()]), 'two years with one id');
  assert.ok(!ok([year({ nominees: [nominee(), nominee()] })]), 'two nominees with one id');
  assert.ok(!ok([year(), year({ id: 'y2' })]), 'a nominee id reused across years');
});
check('rejects non-objects and non-lists inside the list', () => {
  assert.ok(!ok([null]));
  assert.ok(!ok([year({ nominees: 'x' })]));
  assert.ok(!ok([year({ nominees: [null] })]));
});
check('caps the sizes', () => {
  assert.ok(!ok(Array.from({ length: 101 }, (_, i) => year({ id: `y${i}`, nominees: [] }))));
  assert.ok(!ok([year({ nominees: Array.from({ length: 41 }, (_, i) => nominee({ id: `n${i}` })) })]));
});
check('errors name the year, so the Admin tab can show them as written', () => {
  const { errors } = validateBangers({ years: [year({ nominees: [nominee({ title: '' })] })] });
  assert.match(errors[0], /"2023"/);
});

check('normalizeBangers trims, fills gaps and drops unknown fields', () => {
  const out = normalizeBangers([{ id: 'y1', label: ' 2023 ', extra: 1, nominees: [{ id: 'n1', title: ' Cruise ', winner: true, extra: 1 }] }]);
  assert.deepEqual(out, [{ id: 'y1', label: '2023', nominees: [{ id: 'n1', title: 'Cruise', artist: '', by: '', winner: true }] }]);
});
check('normalizeBangers keeps order and treats anything but true as not a winner', () => {
  const out = normalizeBangers([year({ id: 'b' }), year({ id: 'a', nominees: [nominee({ winner: undefined })] })]);
  assert.deepEqual(out.map((y) => y.id), ['b', 'a']);
  assert.equal(out[1].nominees[0].winner, false);
});

check('isStaleBase: only a well-formed, different sha is stale', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.equal(isStaleBase(a, a), false);
  assert.equal(isStaleBase(a, b), true);
  assert.equal(isStaleBase(undefined, b), false, 'not told is never stale');
  assert.equal(isStaleBase('nope', b), false, 'a malformed sha is not told either');
  assert.equal(isStaleBase(a, null), true, 'the file was deleted since the page loaded it');
});

check('serialize: one nominee per line, ends with a newline, round-trips', () => {
  const years = normalizeBangers([year(), year({ id: 'y2', label: 'Empty', nominees: [] }), year({ id: 'y3', label: 'Two', nominees: [nominee({ id: 'a' }), nominee({ id: 'b', title: "Lil' \"Bit\"" })] })]);
  const text = serialize(years);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), { years });
  assert.equal(text.split('\n').filter((l) => l.includes('"title"')).length, 3, 'a nominee is one line');
  assert.equal(serialize([]).trim().replace(/\s+/g, ''), '{"years":[]}');
});

check('data/bangers.json (committed) is valid and already normalized', () => {
  // Admin commits to main with no PR, but a hand edit can still land here;
  // the page renders whatever this file says.
  const text = readFileSync(new URL('../data/bangers.json', import.meta.url), 'utf8');
  const doc = JSON.parse(text);
  assert.deepEqual(validateBangers(doc).errors, []);
  assert.equal(text, serialize(normalizeBangers(doc.years)), 'differs from what the Admin tab would write');
});

// ---- Tasks and Quick Links: who may do what, and which keys they use --------
check('tasks and quick links use their own Upstash keys, never the Vikings page\'s', () => {
  assert.notEqual(TASKS_KEY, VIKINGS_TASKS_KEY);
  assert.notEqual(QUICKLINKS_KEY, VIKINGS_QUICKLINKS_KEY);
  assert.notEqual(TASKS_KEY, QUICKLINKS_KEY);
});

// A tiny req/res pair. No store credentials are set, so a request that gets
// past the auth checks stops at "No store is configured" (500) without any
// network: 401 / 405 / 500 therefore tell the three outcomes apart.
async function call(method, { query, body, token } = {}) {
  const res = { code: null, json: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, end() { return this; } };
  res.json = function (b) { this.body = b; return this; };
  await handler({ method, query: query || {}, body: body || {}, headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
  return res.code;
}

const savedEnv = { ...process.env };
for (const k of Object.keys(process.env)) if (/^(UPSTASH|KV_|REDIS|STORAGE_)/.test(k)) delete process.env[k];
process.env.SESSION_SECRET = 'test-secret';
const good = createToken('test-secret');

for (const [name, run] of [
  ['the quick-links GET is public (reaches the store check, not a 401)', async () => assert.equal(await call('GET', { query: { resource: 'quicklinks' } }), 500)],
  ['the tasks GET needs a login', async () => {
    assert.equal(await call('GET', { query: { resource: 'tasks' } }), 401);
    assert.equal(await call('GET', { query: { resource: 'tasks' }, token: 'bogus' }), 401);
    assert.equal(await call('GET', { query: { resource: 'tasks' }, token: good }), 500);
  }],
  ['every POST needs a login', async () => {
    assert.equal(await call('POST', { body: { resource: 'quicklinks', links: [] } }), 401);
    assert.equal(await call('POST', { body: { resource: 'tasks', tasks: {} } }), 401);
    assert.equal(await call('POST', { body: { years: [] } }), 401);
  }],
  ['a bare GET (the list has none) is a 405', async () => assert.equal(await call('GET'), 405)],
  ['other methods are a 405', async () => assert.equal(await call('DELETE'), 405)],
  ['the list POST needs the GitHub token, then validates before it commits', async () => {
    assert.equal(await call('POST', { token: good, body: { years: 'nope' } }), 500, 'GITHUB_CONTENTS_TOKEN not set');
    process.env.GITHUB_CONTENTS_TOKEN = 'x';
    assert.equal(await call('POST', { token: good, body: { years: 'nope' } }), 400);
  }],
]) {
  try { await run(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}
for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
Object.assign(process.env, savedEnv);

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
