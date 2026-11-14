// Pins api/_lib/sharedalbum.mjs and the public `?resource=photos` route of
// api/fam.js (the Photos card on index.html). What can drift silently:
//  - the partition host derived from the token (a wrong host is a 404 that
//    looks like "no photos");
//  - the join of Apple's two responses: image URLs are keyed by derivative
//    checksum, and a photo with no URL must be dropped, not rendered broken;
//  - the album token leaking into an error the page shows;
//  - a failed read turning into an empty album;
//  - the cache lifetime: Apple's signed image URLs die at their `url_expiry`
//    (~20 minutes after issue), so the route reuses a response only while the
//    links have a margin left, taken from the links themselves; a fixed
//    multi-hour cache would serve dead image links;
//  - `&refresh=1` skipping the cache, and needing a login before Apple is asked.
// Apple's real endpoint is undocumented and unreachable from CI, so Apple is
// faked here; it was probed once by hand.
//
// Run: node scripts/test-shared-album.mjs

import assert from 'node:assert/strict';
import { albumHost, isValidAlbumToken, buildAlbum, fetchSharedAlbum } from '../api/_lib/sharedalbum.mjs';
import handler, { resetPhotosCache, photoCacheMs } from '../api/fam.js';
import { createToken } from '../api/_lib/auth.mjs';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

const TOKEN = 'D2Qv3FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE_fake';

const stream = {
  streamName: 'Family',
  photos: [
    { photoGuid: 'old', dateCreated: '2026-01-01T00:00:00Z', contributorFirstName: 'A', width: '100', height: '100', derivatives: { 342: { checksum: 'o1', width: '342', height: '257' }, 2048: { checksum: 'o2', width: '2048', height: '1536' } } },
    { photoGuid: 'new', caption: 'Hi', dateCreated: '2026-07-17T00:00:00Z', contributorFirstName: 'B', derivatives: { 342: { checksum: 'n1', width: '342', height: '257' }, 2048: { checksum: 'n2', width: '2048', height: '1536' } } },
    { photoGuid: 'nourl', dateCreated: '2026-08-01T00:00:00Z', derivatives: { 342: { checksum: 'x1', width: '342', height: '257' } } },
  ],
};
const assets = {
  items: {
    o1: { url_location: 'cvws.icloud-content.com', url_path: '/o1', url_expiry: '2026-11-14T12:30:00Z' },
    o2: { url_location: 'cvws.icloud-content.com', url_path: '/o2', url_expiry: '2026-11-14T12:30:00Z' },
    n1: { url_location: 'cvws.icloud-content.com', url_path: '/n1', url_expiry: '2026-11-14T12:25:00Z' },
    n2: { url_location: 'cvws.icloud-content.com', url_path: '/n2', url_expiry: '2026-11-14T12:20:00Z' },
  },
};

await check('partition host comes from the token (D2Q -> 2*62+26 = 150; A-prefixed uses one char)', () => {
  assert.equal(albumHost(TOKEN), 'p150-sharedstreams.icloud.com');
  assert.equal(albumHost('A5' + 'x'.repeat(30)), 'p05-sharedstreams.icloud.com');
});
await check('malformed tokens are refused', () => {
  assert.ok(isValidAlbumToken(TOKEN));
  for (const bad of [undefined, '', 'short', 'has space/../x' + 'a'.repeat(20), 'a'.repeat(300)]) assert.ok(!isValidAlbumToken(bad));
});
await check('buildAlbum joins by checksum, sorts newest first, drops photos with no URL', () => {
  const a = buildAlbum(stream, assets);
  assert.deepEqual(a.photos.map((p) => p.id), ['new', 'old']);
  assert.equal(a.photos[0].thumb, 'https://cvws.icloud-content.com/n1');
  assert.equal(a.photos[0].full, 'https://cvws.icloud-content.com/n2');
  assert.equal(a.photos[0].caption, 'Hi');
  assert.equal(a.name, 'Family');
  assert.equal(a.expires, '2026-11-14T12:20:00.000Z', 'the earliest expiry of the links returned');
});
await check('no expiry from Apple means expires is null, not a guess', () => {
  const noExp = { items: { o1: { url_location: 'h', url_path: '/o1' }, o2: { url_location: 'h', url_path: '/o2' }, n1: { url_location: 'h', url_path: '/n1' }, n2: { url_location: 'h', url_path: '/n2' } } };
  assert.equal(buildAlbum(stream, noExp).expires, null);
});

function fakeApple({ failWith, assetsBody = assets, streamBody = stream } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (failWith) return { ok: false, status: failWith, headers: new Map(), json: async () => ({}) };
    const body = url.endsWith('/webstream') ? streamBody : assetsBody;
    return { ok: true, status: 200, headers: new Map(), json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

await check('fetchSharedAlbum makes the two calls, the second with every photo guid', async () => {
  const f = fakeApple();
  const a = await fetchSharedAlbum(TOKEN, f);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].url.startsWith('https://p150-sharedstreams.icloud.com/'));
  assert.deepEqual(f.calls[1].body.photoGuids, ['old', 'new', 'nourl']);
  assert.equal(a.photos.length, 2);
});
await check('an empty album skips the second call and is a real empty list', async () => {
  const f = fakeApple({ streamBody: { streamName: 'E', photos: [] } });
  const a = await fetchSharedAlbum(TOKEN, f);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(a.photos, []);
});
await check('an Apple HTTP error throws, never an empty album', async () => {
  await assert.rejects(fetchSharedAlbum(TOKEN, fakeApple({ failWith: 404 })), /HTTP 404/);
});

async function call(fetchFn, { refresh, token } = {}) {
  const res = { code: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, end() { return this; } };
  res.json = function (b) { this.body = b; return this; };
  const query = { resource: 'photos', ...(refresh ? { refresh: '1' } : {}) };
  await handler({ method: 'GET', query, body: {}, headers: token ? { authorization: `Bearer ${token}` } : {} }, res, fetchFn);
  return res;
}
// Runs `fn` with Date.now() pinned to a settable clock.
async function withClock(startMs, fn) {
  const real = Date.now;
  let t = startMs;
  Date.now = () => t;
  try { await fn((ms) => { t = startMs + ms; }); } finally { Date.now = real; }
}
const MIN = 60 * 1000, HOUR = 60 * MIN;
const endpointsOf = (f) => f.calls.map((c) => c.url.split('/').pop());
const savedAlbum = process.env.FAM_PHOTOS_ALBUM;

await check('the photos route is public, 503 when the token is not configured', async () => {
  delete process.env.FAM_PHOTOS_ALBUM; resetPhotosCache();
  assert.equal((await call(fakeApple())).code, 503);
});
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0); // Apple issues links at 12:00 that expire at 12:20 in these tests
const appleWithExpiry = (expiry) => fakeApple({ assetsBody: { items: Object.fromEntries(Object.entries(assets.items).map(([k, v]) => [k, { ...v, url_expiry: expiry }])) } });

await check('photoCacheMs: served until 10 minutes before the earliest expiry, within a floor and a ceiling', () => {
  assert.equal(photoCacheMs('2026-11-14T12:20:00Z', T0), 10 * MIN, '20 minutes of life, 10 minute margin');
  assert.equal(photoCacheMs('2026-11-14T12:12:00Z', T0), 2 * MIN, '12 minutes of life, 10 minute margin');
  assert.equal(photoCacheMs('2026-11-14T12:08:00Z', T0), MIN, 'a short expiry still caches for the floor, not zero');
  assert.equal(photoCacheMs('2026-11-14T11:00:00Z', T0), MIN, 'already expired: the floor');
  assert.equal(photoCacheMs('2026-11-20T12:00:00Z', T0), 12 * HOUR, 'a very long expiry is capped');
  assert.equal(photoCacheMs(null, T0), 5 * MIN, 'no expiry: the fallback');
  assert.equal(photoCacheMs('garbage', T0), 5 * MIN);
});
await check('the photos route serves the album, expiry included', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; resetPhotosCache();
  const f = fakeApple();
  await withClock(T0, async () => {
    const r = await call(f);
    assert.equal(r.code, 200);
    assert.equal(r.body.photos.length, 2);
    assert.equal(r.body.expires, '2026-11-14T12:20:00.000Z');
    assert.deepEqual(endpointsOf(f), ['webstream', 'webasseturls']);
  });
});
await check('reused while the links have their margin, re-read once they do not', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; resetPhotosCache();
  const f = appleWithExpiry('2026-11-14T12:20:00Z');
  await withClock(T0, async (at) => {
    await call(f); at(9 * MIN); await call(f);
    assert.equal(f.calls.length, 2, 'at 9 minutes the links still have 11 left: cached');
    at(10 * MIN + 1000); await call(f);
    assert.equal(f.calls.length, 4, 'past the 10 minute mark both calls are made again');
  });
});
await check('follows Apple: a shorter expiry shortens the cache, a missing one falls back to 5 minutes', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; resetPhotosCache();
  await withClock(T0, async (at) => {
    const f = appleWithExpiry('2026-11-14T12:03:00Z'); // only 3 minutes of life
    await call(f); at(30 * 1000); await call(f);
    assert.equal(f.calls.length, 2, 'inside the 1 minute floor');
    at(90 * 1000); await call(f);
    assert.equal(f.calls.length, 4, 'after the floor it is re-read, although the links had time left');
  });
  resetPhotosCache();
  await withClock(T0, async (at) => {
    const f = fakeApple({ assetsBody: { items: Object.fromEntries(Object.entries(assets.items).map(([k, v]) => [k, { url_location: v.url_location, url_path: v.url_path }])) } });
    await call(f); at(4 * MIN); await call(f);
    assert.equal(f.calls.length, 2);
    at(5 * MIN + 1000); await call(f);
    assert.equal(f.calls.length, 4);
  });
});
await check('refresh needs a login and asks Apple nothing without one', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; process.env.SESSION_SECRET = 'test-secret'; resetPhotosCache();
  const f = fakeApple();
  assert.equal((await call(f, { refresh: true })).code, 401);
  assert.equal((await call(f, { refresh: true, token: 'bogus' })).code, 401);
  assert.equal(f.calls.length, 0);
  delete process.env.SESSION_SECRET;
  assert.equal((await call(f, { refresh: true, token: 'x' })).code, 500);
  assert.equal(f.calls.length, 0);
});
await check('a logged-in refresh skips the cache and replaces it', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; process.env.SESSION_SECRET = 'test-secret'; resetPhotosCache();
  const good = createToken('test-secret');
  const f = appleWithExpiry('2026-11-14T12:20:00Z');
  await withClock(T0, async (at) => {
    await call(f); at(2 * MIN);
    const r = await call(f, { refresh: true, token: good });
    assert.equal(r.code, 200);
    assert.deepEqual(endpointsOf(f), ['webstream', 'webasseturls', 'webstream', 'webasseturls']);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    at(3 * MIN);
    await call(f);
    assert.equal(f.calls.length, 4, 'an ordinary read after a refresh uses the refreshed cache');
  });
  delete process.env.SESSION_SECRET;
});
await check('a failed refresh leaves the earlier cache in place', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; process.env.SESSION_SECRET = 'test-secret'; resetPhotosCache();
  const good = createToken('test-secret');
  await withClock(T0, async (at) => {
    const f = appleWithExpiry('2026-11-14T12:20:00Z');
    await call(f); at(MIN);
    const bad = await call(fakeApple({ failWith: 500 }), { refresh: true, token: good });
    assert.equal(bad.code, 502);
    const f2 = fakeApple();
    const still = await call(f2);
    assert.equal(still.code, 200);
    assert.equal(f2.calls.length, 0, 'the earlier response is still cached');
  });
  delete process.env.SESSION_SECRET;
});
await check('a failed read is a 502 and the error never contains the token', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; resetPhotosCache();
  const f = async () => { throw new Error(`boom ${TOKEN}`); };
  const r = await call(f);
  assert.equal(r.code, 502);
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
});

if (savedAlbum === undefined) delete process.env.FAM_PHOTOS_ALBUM; else process.env.FAM_PHOTOS_ALBUM = savedAlbum;
if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
