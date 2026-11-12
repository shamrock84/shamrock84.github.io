// Pins api/fam.js, the endpoint behind index.html's Admin tab (Tasks and Quick
// Links). What can drift silently:
//  - the Upstash keys: if they collided with the Vikings or Bangers pages' (or
//    each other), one page would show another's tasks and toolbar;
//  - who may do what: the quick-links GET is public (logged-out visitors see
//    the toolbar), everything else needs the login;
//  - an unknown resource slipping through to the store.
// The validators are vikings.js's own and are tested by test-vikings.mjs.
//
// Run: node scripts/test-fam.mjs

import assert from 'node:assert/strict';
import handler, { TASKS_KEY, QUICKLINKS_KEY } from '../api/fam.js';
import { TASKS_KEY as VIKINGS_TASKS_KEY, QUICKLINKS_KEY as VIKINGS_QUICKLINKS_KEY } from '../api/vikings.js';
import { TASKS_KEY as BANGERS_TASKS_KEY, QUICKLINKS_KEY as BANGERS_QUICKLINKS_KEY } from '../api/bangers.js';
import { createToken } from '../api/_lib/auth.mjs';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

check('tasks and quick links use their own Upstash keys, never another page\'s', () => {
  const others = [VIKINGS_TASKS_KEY, VIKINGS_QUICKLINKS_KEY, BANGERS_TASKS_KEY, BANGERS_QUICKLINKS_KEY];
  for (const k of [TASKS_KEY, QUICKLINKS_KEY]) assert.ok(!others.includes(k), `${k} is shared`);
  assert.notEqual(TASKS_KEY, QUICKLINKS_KEY);
});

// A tiny req/res pair. No store credentials are set, so a request that gets
// past the auth checks stops at "No store is configured" (500) without any
// network: 401 / 400 / 405 / 500 therefore tell the outcomes apart.
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
  ['the quick-links GET is public (reaches the store check, not a 401)', async () => assert.equal(await call('GET', { query: { resource: 'quicklinks' } }), 500)],
  ['the tasks GET needs a login', async () => {
    assert.equal(await call('GET', { query: { resource: 'tasks' } }), 401);
    assert.equal(await call('GET', { query: { resource: 'tasks' }, token: 'bogus' }), 401);
    assert.equal(await call('GET', { query: { resource: 'tasks' }, token: good }), 500);
  }],
  ['every POST needs a login', async () => {
    assert.equal(await call('POST', { body: { resource: 'quicklinks', links: [] } }), 401);
    assert.equal(await call('POST', { body: { resource: 'tasks', tasks: {} } }), 401);
  }],
  ['a bare GET or an unknown resource is refused, never sent to the store', async () => {
    assert.equal(await call('GET'), 405);
    assert.equal(await call('GET', { query: { resource: 'plans' }, token: good }), 405);
    assert.equal(await call('POST', { token: good, body: { resource: 'plans' } }), 400);
    assert.equal(await call('POST', { token: good, body: { years: [] } }), 400);
  }],
  ['other methods are a 405', async () => assert.equal(await call('DELETE'), 405)],
]) {
  try { await run(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}
for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
Object.assign(process.env, savedEnv);

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
