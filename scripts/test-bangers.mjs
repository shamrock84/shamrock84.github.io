// Unit tests for api/bangers.js's pure parts: the validation that is the only
// guard on what reaches the store (and, through the public GET, every
// visitor), the normalisation that decides what is kept, and the stale-copy
// check that stops a second device from erasing the first one's edits.
//
// Run: node scripts/test-bangers.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import handler, { validateBangers, normalizeBangers, serialize, isStaleBase, TASKS_KEY, QUICKLINKS_KEY, validateVotingOpen, voterKey, cleanVoterName, validateVote, isOwnNomination, validateBallotEdit, validateNomination, VOTING_KEY, NOMINATING_KEY, votesKey } from '../api/bangers.js';
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
check('isOwnNomination: loose on case, punctuation and surname, silent with no nominator', () => {
  for (const [name, by] of [['Jeff', 'Jeff'], ['  jeff ', 'Jeff'], ['Jeff Smith', 'Jeff'], ['J.eff', 'Jeff'], ['Jeff', 'Jeff Smith'], ['DAD', 'Dad']]) assert.ok(isOwnNomination(name, by), `${name} / ${by}`);
  for (const [name, by] of [['Kevin', 'Jeff'], ['Jeffrey', 'Jeff'], ['Kevin', ''], ['Kevin', undefined], ['', 'Jeff'], ['Jeff', '   ']]) assert.ok(!isOwnNomination(name, by), `${name} / ${by}`);
});
check('validateBallotEdit: set needs a nominee, delete does not', () => {
  assert.equal(validateBallotEdit({ action: 'set', name: 'Al', yearId: 'y1', nomineeId: 'na' }).errors.length, 0);
  assert.equal(validateBallotEdit({ action: 'delete', name: 'Al', yearId: 'y1' }).errors.length, 0);
  for (const bad of [null, { action: 'set', name: 'Al', yearId: 'y1' }, { action: 'nope', name: 'Al', yearId: 'y1' }, { action: 'delete', name: ' ', yearId: 'y1' }, { action: 'delete', name: 'Al', yearId: 'a b' }]) assert.ok(validateBallotEdit(bad).errors.length, JSON.stringify(bad));
});
check('validateNomination needs name, year, song and artist', () => {
  assert.equal(validateNomination({ name: 'Zoe', yearId: 'y1', title: 'S', artist: 'A' }).errors.length, 0);
  for (const bad of [null, { yearId: 'y1', title: 'S', artist: 'A' }, { name: 'Z', title: 'S', artist: 'A' }, { name: 'Z', yearId: 'y1', artist: 'A' }, { name: 'Z', yearId: 'y1', title: 'S' }, { name: 'Z', yearId: 'y1', title: 'x'.repeat(121), artist: 'A' }, { name: 'Z', yearId: 'y1', title: 'S', artist: 'x'.repeat(121) }, { name: 'x'.repeat(41), yearId: 'y1', title: 'S', artist: 'A' }]) assert.ok(validateNomination(bad).errors.length, JSON.stringify(bad));
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
  // GitHub: the list file with a content-derived sha, so a PUT made from an old
  // sha is refused like the real thing. `gh.conflictNext` makes the next PUT
  // lose a race (409) after another writer "changed" the file.
  const gh = { years: list, puts: 0, conflictNext: 0, onConflict: null };
  const fileText = () => JSON.stringify({ years: gh.years });
  const shaOf = (t) => createHash('sha1').update(t).digest('hex');
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
    if (op === 'HSET') {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const had = hashes.get(key).has(rest[0]);
      hashes.get(key).set(rest[0], rest[1]);
      return had ? 0 : 1;
    }
    if (op === 'HDEL') return hashes.has(key) && hashes.get(key).delete(rest[0]) ? 1 : 0;
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
    if (u.startsWith('https://api.github.com/')) {
      if ((init.method || 'GET') === 'PUT') {
        const put = JSON.parse(init.body);
        if (gh.conflictNext > 0) { gh.conflictNext--; if (gh.onConflict) gh.onConflict(); return json({ message: 'conflict' }, 409); }
        if (put.sha !== shaOf(fileText())) return json({ message: 'sha mismatch' }, 409);
        gh.years = JSON.parse(Buffer.from(put.content, 'base64').toString('utf8')).years;
        gh.puts++;
        return json({ content: { sha: shaOf(fileText()) } });
      }
      if (String(init.headers && init.headers.Accept).includes('raw')) return new Response(fileText(), { status: 200 });
      return json({ sha: shaOf(fileText()), content: Buffer.from(fileText()).toString('base64') });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const restore = () => { globalThis.fetch = realFetch; };
  restore.gh = gh;
  return restore;
}
async function callFull(method, { query, body, token, ip = '1.1.1.1' } = {}) {
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method, query: query || {}, body: body || {}, headers: { 'x-real-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res);
  return res;
}

const voteSaved = { ...process.env };
Object.assign(process.env, { KV_REST_API_URL: 'https://fake-kv.test', KV_REST_API_TOKEN: 't', SESSION_SECRET: 'test-secret', GITHUB_CONTENTS_TOKEN: 'g', BANGERS_VOTE_PASSWORD: 'hootowl' });
const restoreFetch = installFakeServices([{ id: 'y1', label: '2027', nominees: [{ id: 'na', title: 'A', by: 'Jeff' }, { id: 'nb', title: 'B', by: 'Dad' }, { id: 'nd', title: 'D' }] }, { id: 'y2', label: '2028', nominees: [{ id: 'nc', title: 'C', by: 'Kris' }] }]);
const vote = (over = {}, ip) => callFull('POST', { ip, body: { resource: 'vote', name: 'Kevin', password: 'hootowl', yearId: 'y1', nomineeId: 'na', ...over } });
for (const [name, run] of [
  ['open years: public GET, login-gated POST', async () => {
    assert.deepEqual((await callFull('GET', { query: { resource: 'voting' } })).body, { open: [], nominating: [] });
    assert.equal((await callFull('POST', { body: { resource: 'voting', open: ['y1'] } })).code, 401);
    assert.equal((await callFull('POST', { token: good, body: { resource: 'voting', open: ['y1'] } })).code, 200);
    assert.deepEqual((await callFull('GET', { query: { resource: 'voting' } })).body, { open: ['y1'], nominating: [] });
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
  ['nobody may vote for their own nomination, and nothing is recorded when refused', async () => {
    for (const name of ['Jeff', 'jeff smith']) {
      const r = await vote({ name, nomineeId: 'na' });
      assert.equal(r.code, 403, name);
      assert.match(r.body.error, /own nomination/);
    }
    assert.equal((await vote({ name: 'Dad', nomineeId: 'nb' })).code, 403);
    assert.equal((await vote({ name: 'Jeff', nomineeId: 'nb' })).code, 200, 'another nominee is fine');
    assert.equal((await vote({ name: 'Mom', nomineeId: 'nd' })).code, 200, 'a nominee with no nominator is open to all');
    const r = await callFull('GET', { token: good, query: { resource: 'votes', years: 'y1' } });
    assert.ok(!r.body.votes.y1.some((v) => v.name === 'Dad'));
  }],
  ['Admin can change, add and delete a ballot, login required', async () => {
    const edit = (body, token = good) => callFull('POST', { token, body: { resource: 'ballot', yearId: 'y1', ...body } });
    assert.equal((await edit({ action: 'delete', name: 'Mom' }, null)).code, 401);
    assert.equal((await edit({ action: 'delete', name: 'Mom' }, 'bogus')).code, 401);
    let r = await edit({ action: 'set', name: 'mom', nomineeId: 'nb' });
    assert.equal(r.code, 200);
    assert.equal(r.body.votes.find((v) => v.name.toLowerCase() === 'mom').nomineeId, 'nb', 'same voter, changed song, not a second ballot');
    r = await edit({ action: 'set', name: 'Jeff Added', nomineeId: 'na' });
    assert.equal(r.code, 200, 'an Admin edit skips the self-vote rule');
    assert.equal((await edit({ action: 'set', name: 'Zed', nomineeId: 'nc' })).code, 400, 'nominee from another year');
    assert.equal((await edit({ action: 'set', name: 'Zed', nomineeId: 'na', yearId: 'y9' })).code, 400);
    r = await edit({ action: 'delete', name: 'MOM' });
    assert.ok(!r.body.votes.some((v) => v.name.toLowerCase() === 'mom'));
    assert.equal((await vote({ name: 'Mom', nomineeId: 'nd' })).code, 200, 'a deleted voter may vote again');
    assert.equal((await callFull('GET', { query: { resource: 'ballot' } })).code, 405);
  }],
  ['the tally is public, counts only, no names', async () => {
    const r = await callFull('GET', { query: { resource: 'tally', years: 'y1,y2' } });
    assert.equal(r.code, 200);
    assert.ok(r.body.counts.na >= 1 && r.body.counts.nb >= 1 && r.body.counts.nc === 1, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).match(/Kevin|Jeff|Mom|name/), 'no voter names');
    assert.equal((await callFull('GET', { query: { resource: 'tally', years: 'a b' } })).code, 400);
    assert.equal((await callFull('GET', { query: { resource: 'tally' } })).body.counts && Object.keys((await callFull('GET', { query: { resource: 'tally' } })).body.counts).length, 0);
    assert.equal((await callFull('POST', { body: { resource: 'tally' } })).code, 405);
  }],
  ['nominations: year list is public, set by login only', async () => {
    assert.deepEqual((await callFull('GET', { query: { resource: 'voting' } })).body.nominating, []);
    assert.equal((await callFull('POST', { body: { resource: 'nominating', open: ['y2'] } })).code, 401);
    assert.equal((await callFull('POST', { token: good, body: { resource: 'nominating', open: 'y2' } })).code, 400);
    assert.equal((await callFull('POST', { token: good, body: { resource: 'nominating', open: ['y2'] } })).code, 200);
    assert.deepEqual((await callFull('GET', { query: { resource: 'voting' } })).body.nominating, ['y2']);
    assert.equal((await callFull('GET', { query: { resource: 'nominating' } })).code, 405);
  }],
  ['a nomination needs the password, an open year and a full form', async () => {
    const nom = (over = {}, ip) => callFull('POST', { ip, body: { resource: 'nominate', name: 'Zoe', password: 'hootowl', yearId: 'y2', title: 'New Song', artist: 'New Artist', ...over } });
    assert.equal((await nom({ password: 'nope' }, '7.7.7.7')).code, 401);
    assert.equal((await nom({ yearId: 'y1' })).code, 403, 'y1 is not accepting nominations');
    assert.equal((await nom({ title: ' ' })).code, 400);
    assert.equal((await nom({ artist: '' })).code, 400);
    assert.equal(restoreFetch.gh.puts, 0, 'nothing committed by refused requests');
    const ok = await nom();
    assert.equal(ok.code, 200);
    const y2 = restoreFetch.gh.years.find((y) => y.id === 'y2');
    const added = y2.nominees.find((n) => n.title === 'New Song');
    assert.deepEqual({ ...added, id: undefined }, { id: undefined, title: 'New Song', artist: 'New Artist', by: 'Zoe', winner: false });
    assert.match(added.id, /^[A-Za-z0-9]+$/);
    assert.equal(restoreFetch.gh.puts, 1);
    assert.deepEqual(validateBangers({ years: restoreFetch.gh.years }).errors, [], 'the file stays valid');
    // The Admin tab's Years card sees it as a plain nominee, so the winner can be ticked there.
    const dup = await nom({ name: 'Yan', title: ' new  SONG ', artist: 'new artist' });
    assert.equal(dup.code, 409);
    assert.match(dup.body.error, /already nominated/);
    const again = await nom({ name: 'zoe smith', title: 'Another', artist: 'X' });
    assert.equal(again.code, 409, 'one nomination per person per year');
    assert.match(again.body.error, /already nominated a song/);
    assert.equal((await nom({ name: 'Kris', title: 'Z', artist: 'Z' })).code, 409, 'Kris already has a nominee in y2');
    assert.equal(restoreFetch.gh.puts, 1);
  }],
  ['a nomination that loses a race to another writer is retried against the fresh list', async () => {
    const gh = restoreFetch.gh;
    gh.conflictNext = 1;
    gh.onConflict = () => { gh.years.find((y) => y.id === 'y2').nominees.push({ id: 'nrace', title: 'Raced', artist: 'R', by: 'Pat', winner: false }); gh.onConflict = null; };
    const r = await callFull('POST', { body: { resource: 'nominate', name: 'Quinn', password: 'hootowl', yearId: 'y2', title: 'Late Song', artist: 'L' } });
    assert.equal(r.code, 200);
    const titles = gh.years.find((y) => y.id === 'y2').nominees.map((n) => n.title);
    assert.ok(titles.includes('Raced') && titles.includes('Late Song'), 'neither write was lost');
    // …and a race that makes it a duplicate is caught on the retry.
    gh.conflictNext = 1;
    gh.onConflict = () => { gh.years.find((y) => y.id === 'y2').nominees.push({ id: 'nrace2', title: 'Same Song', artist: 'Same', by: 'Rae', winner: false }); gh.onConflict = null; };
    const dup = await callFull('POST', { body: { resource: 'nominate', name: 'Sam', password: 'hootowl', yearId: 'y2', title: 'Same Song', artist: 'Same' } });
    assert.equal(dup.code, 409);
  }],
  ['a full year takes no more nominations', async () => {
    const gh = restoreFetch.gh;
    const y2 = gh.years.find((y) => y.id === 'y2');
    for (let i = y2.nominees.length; i < 40; i++) y2.nominees.push({ id: `nfill${i}`, title: `Fill ${i}`, artist: 'F', by: `Filler${i}`, winner: false });
    const r = await callFull('POST', { body: { resource: 'nominate', name: 'Tess', password: 'hootowl', yearId: 'y2', title: 'One Too Many', artist: 'T' } });
    assert.equal(r.code, 409);
    assert.match(r.body.error, /maximum/);
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
check('votes live in their own keys', () => { assert.equal(VOTING_KEY, 'bangers:voting'); assert.equal(NOMINATING_KEY, 'bangers:nominating'); assert.equal(votesKey('y1'), 'bangers:votes:y1'); });

for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
Object.assign(process.env, savedEnv);

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
