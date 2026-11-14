// Unit tests for api/bangers.js's pure parts: the validation that is the only
// guard on what reaches the store (and, through the public GET, every
// visitor), the normalisation that decides what is kept, and the stale-copy
// check that stops a second device from erasing the first one's edits.
//
// Run: node scripts/test-bangers.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler, { validateBangers, normalizeBangers, serialize, isStaleBase, TASKS_KEY, QUICKLINKS_KEY, validateVotingOpen, voterKey, cleanVoterName, validateVote, VOTING_KEY, votesKey } from '../api/bangers.js';
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
check('link is optional, but must be a web address when given', () => {
  assert.ok(ok([year({ nominees: [nominee({ link: '' })] })]));
  assert.ok(ok([year({ nominees: [nominee({ link: ' https://music.apple.com/us/song/cruise/1 ' })] })]));
  assert.ok(ok([year({ nominees: [nominee({ link: 'http://example.com/x' })] })]));
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'music.apple.com/x', 'https://a b', 5, 'https://x.com/' + 'a'.repeat(500)]) {
    assert.ok(!ok([year({ nominees: [nominee({ link: bad })] })]), String(bad));
  }
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
check('normalizeBangers keeps a link, trimmed, and leaves the key out when blank', () => {
  const out = normalizeBangers([year({ nominees: [nominee({ id: 'a', link: ' https://x.test/s ' }), nominee({ id: 'b', link: '  ' })] })]);
  assert.equal(out[0].nominees[0].link, 'https://x.test/s');
  assert.ok(!('link' in out[0].nominees[1]));
  assert.deepEqual(JSON.parse(serialize(out)).years[0].nominees[0], out[0].nominees[0]);
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

// ---- Voting: pure parts ----------------------------------------------------
check('voterKey ignores case and spacing, so one name is one voter', () => {
  assert.equal(voterKey('  Kevin   Smith '), voterKey('kevin smith'));
  assert.notEqual(voterKey('Kevin'), voterKey('Kev'));
  assert.equal(cleanVoterName('a\u0000b\tc'), 'a b c');
  assert.equal(cleanVoterName(5), '');
});
check('validateVotingOpen wants a list of ids', () => {
  assert.equal(validateVotingOpen({ open: ['y1', 'y2'] }).errors.length, 0);
  assert.equal(validateVotingOpen({ open: [] }).errors.length, 0);
  for (const bad of [null, {}, { open: 'y1' }, { open: ['a b'] }, { open: [5] }, { open: Array.from({ length: 21 }, (_, i) => `y${i}`) }]) assert.ok(validateVotingOpen(bad).errors.length, JSON.stringify(bad));
});
check('validateVote needs a name, a year and a nominee', () => {
  assert.equal(validateVote({ name: 'Kevin', yearId: 'y1', nomineeId: 'n1' }).errors.length, 0);
  assert.ok(validateVote({ name: '  ', yearId: 'y1', nomineeId: 'n1' }).errors.length);
  assert.ok(validateVote({ name: 'x'.repeat(41), yearId: 'y1', nomineeId: 'n1' }).errors.length);
  assert.ok(validateVote({ name: 'K', yearId: 'a b', nomineeId: 'n1' }).errors.length);
  assert.ok(validateVote({ name: 'K', yearId: 'y1' }).errors.length);
});

// ---- Voting: the whole flow against an in-memory Upstash and GitHub --------
function installFakeServices(list) {
  const kv = new Map();      // key -> string
  const hashes = new Map();  // key -> Map(field -> string)
  const run = (cmd) => {
    const [op, key, ...rest] = cmd;
    if (op === 'SET') { kv.set(key, rest[0]); return 'OK'; }
    if (op === 'GET') return kv.has(key) ? kv.get(key) : null;
    if (op === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    if (op === 'DEL') { kv.delete(key); return 1; }
    if (op === 'HSETNX') {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const h = hashes.get(key);
      if (h.has(rest[0])) return 0;
      h.set(rest[0], rest[1]);
      return 1;
    }
    if (op === 'HGETALL') return [...(hashes.get(key) || new Map())].flat();
    throw new Error(`fake store: ${op}`);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.startsWith('https://fake-kv.test')) {
      const path = u.slice('https://fake-kv.test'.length);
      if (path.startsWith('/get/')) return json({ result: run(['GET', decodeURIComponent(path.slice(5))]) });
      if (path === '/pipeline') return json(JSON.parse(init.body).map((c) => ({ result: run(c) })));
      return json({ result: run(JSON.parse(init.body)) });
    }
    if (u.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ years: list }), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  };
  return () => { globalThis.fetch = realFetch; };
}
async function callFull(method, { query, body, token, ip = '1.1.1.1' } = {}) {
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method, query: query || {}, body: body || {}, headers: { 'x-real-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res);
  return res;
}

const voteSaved = { ...process.env };
Object.assign(process.env, { KV_REST_API_URL: 'https://fake-kv.test', KV_REST_API_TOKEN: 't', SESSION_SECRET: 'test-secret', GITHUB_CONTENTS_TOKEN: 'g', BANGERS_VOTE_PASSWORD: 'hootowl' });
const restoreFetch = installFakeServices([{ id: 'y1', label: '2027', nominees: [{ id: 'na', title: 'A' }, { id: 'nb', title: 'B' }] }, { id: 'y2', label: '2028', nominees: [{ id: 'nc', title: 'C' }] }]);
const vote = (over = {}, ip) => callFull('POST', { ip, body: { resource: 'vote', name: 'Kevin', password: 'hootowl', yearId: 'y1', nomineeId: 'na', ...over } });
for (const [name, run] of [
  ['open years: public GET, login-gated POST', async () => {
    assert.deepEqual((await callFull('GET', { query: { resource: 'voting' } })).body, { open: [] });
    assert.equal((await callFull('POST', { body: { resource: 'voting', open: ['y1'] } })).code, 401);
    assert.equal((await callFull('POST', { token: good, body: { resource: 'voting', open: ['y1'] } })).code, 200);
    assert.deepEqual((await callFull('GET', { query: { resource: 'voting' } })).body, { open: ['y1'] });
    assert.equal((await callFull('POST', { token: good, body: { resource: 'voting', open: 'y1' } })).code, 400);
  }],
  ['a vote needs the password, and wrong guesses are counted then locked out', async () => {
    assert.equal((await vote({ password: 'nope' }, '9.9.9.9')).code, 401);
    assert.equal((await vote({ password: undefined }, '9.9.9.9')).code, 401);
    for (let i = 0; i < 8; i++) await vote({ password: 'nope' }, '9.9.9.9');
    assert.equal((await vote({ password: 'hootowl' }, '9.9.9.9')).code, 429, 'locked out even with the right password');
    assert.equal((await vote({ name: 'Locked Check' }, '2.2.2.2')).code, 200, 'another IP is unaffected');
  }],
  ['a vote lands once per name per year, whatever the case or spacing', async () => {
    assert.equal((await vote()).code, 200);
    const again = await vote({ name: '  kevin ', nomineeId: 'nb' });
    assert.equal(again.code, 409);
    assert.match(again.body.error, /already voted/);
    assert.equal((await vote({ name: 'Kevin', yearId: 'y1', nomineeId: 'na' })).code, 409);
  }],
  ['the same name may vote in another open year', async () => {
    assert.equal((await vote({ yearId: 'y2', nomineeId: 'nc' })).code, 403, 'y2 is not open yet');
    await callFull('POST', { token: good, body: { resource: 'voting', open: ['y1', 'y2'] } });
    assert.equal((await vote({ yearId: 'y2', nomineeId: 'nc' })).code, 200);
  }],
  ['a closed year, an unknown year, or another year\'s nominee is refused', async () => {
    assert.equal((await vote({ name: 'Zed', yearId: 'y9', nomineeId: 'na' })).code, 403);
    assert.equal((await vote({ name: 'Zed', yearId: 'y1', nomineeId: 'nc' })).code, 400);
    assert.equal((await vote({ name: '', yearId: 'y1', nomineeId: 'na' })).code, 400);
  }],
  ['ballots are login-gated and list who voted for what', async () => {
    assert.equal((await callFull('GET', { query: { resource: 'votes', years: 'y1' } })).code, 401);
    const r = await callFull('GET', { token: good, query: { resource: 'votes', years: 'y1,y2' } });
    assert.equal(r.code, 200);
    assert.deepEqual(r.body.votes.y1.map((v) => [v.name, v.nomineeId]).sort(), [['Kevin', 'na'], ['Locked Check', 'na']]);
    assert.deepEqual(r.body.votes.y2.map((v) => v.name), ['Kevin']);
    assert.equal((await callFull('GET', { token: good, query: { resource: 'votes', years: 'a b' } })).code, 400);
  }],
  ['a vote with no BANGERS_VOTE_PASSWORD configured is a 500, never open', async () => {
    delete process.env.BANGERS_VOTE_PASSWORD;
    assert.equal((await vote({ password: '' })).code, 500);
    process.env.BANGERS_VOTE_PASSWORD = 'hootowl';
  }],
  ['GET on the vote resource and POST on votes are a 405', async () => {
    assert.equal((await callFull('GET', { query: { resource: 'vote' } })).code, 405);
    assert.equal((await callFull('POST', { token: good, body: { resource: 'votes' } })).code, 405);
  }],
]) {
  try { await run(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}
restoreFetch();
for (const k of Object.keys(process.env)) if (!(k in voteSaved)) delete process.env[k];
Object.assign(process.env, voteSaved);
check('votes live in their own keys', () => { assert.equal(VOTING_KEY, 'bangers:voting'); assert.equal(votesKey('y1'), 'bangers:votes:y1'); });

for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
Object.assign(process.env, savedEnv);

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
