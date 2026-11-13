// Pins api/_lib/sharedalbum.mjs and the public `?resource=photos` route of
// api/fam.js (the Photos card on index.html). What can drift silently:
//  - the partition host derived from the token (a wrong host is a 404 that
//    looks like "no photos");
//  - the join of Apple's two responses: image URLs are keyed by derivative
//    checksum, and a photo with no URL must be dropped, not rendered broken;
//  - the album token leaking into an error the page shows;
//  - a failed read turning into an empty album.
// Apple's real endpoint is undocumented and unreachable from CI, so Apple is
// faked here; it was probed once by hand.
//
// Run: node scripts/test-shared-album.mjs

import assert from 'node:assert/strict';
import { albumHost, isValidAlbumToken, buildAlbum, fetchSharedAlbum } from '../api/_lib/sharedalbum.mjs';
import handler, { resetPhotosCache } from '../api/fam.js';

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
    o1: { url_location: 'cvws.icloud-content.com', url_path: '/o1' },
    o2: { url_location: 'cvws.icloud-content.com', url_path: '/o2' },
    n1: { url_location: 'cvws.icloud-content.com', url_path: '/n1' },
    n2: { url_location: 'cvws.icloud-content.com', url_path: '/n2' },
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

async function call(fetchFn) {
  const res = { code: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, end() { return this; } };
  res.json = function (b) { this.body = b; return this; };
  await handler({ method: 'GET', query: { resource: 'photos' }, body: {}, headers: {} }, res, fetchFn);
  return res;
}
const savedAlbum = process.env.FAM_PHOTOS_ALBUM;

await check('the photos route is public, 503 when the token is not configured', async () => {
  delete process.env.FAM_PHOTOS_ALBUM; resetPhotosCache();
  assert.equal((await call(fakeApple())).code, 503);
});
await check('the photos route serves the album and caches it', async () => {
  process.env.FAM_PHOTOS_ALBUM = TOKEN; resetPhotosCache();
  const f = fakeApple();
  const r1 = await call(f); const r2 = await call(f);
  assert.equal(r1.code, 200);
  assert.equal(r1.body.photos.length, 2);
  assert.equal(r2.code, 200);
  assert.equal(f.calls.length, 2, 'second request should come from the cache');
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
