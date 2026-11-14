// Reads a public iCloud Shared Album for index.html's Photos card.
//
// Apple has no documented API or embed for shared albums and refuses iframes.
// This uses the same two undocumented JSON calls Apple's own web viewer makes,
// which need no login, only the album token (the part of the share link after
// `#`). Probed once from a sandbox; Apple can change it without notice, so every
// failure surfaces as an error to the page, never as "no photos".
//
//   1. POST https://p<N>-sharedstreams.icloud.com/<token>/sharedstreams/webstream
//        {streamCtag: null} -> { streamName, photos: [{ photoGuid, caption,
//        dateCreated, contributorFirstName, derivatives: { <width>: { checksum,
//        width, height } } }] }. No image URLs.
//   2. POST .../webasseturls  {photoGuids: [...]}
//        -> { locations, items: { <checksum>: { url_location, url_path,
//        url_expiry } } }. The URL is https://<url_location><url_path>, signed
//        and valid for about 20 minutes, so the page can't store it.
//
// The partition <N> is encoded in the token's leading characters: base-62
// (0-9A-Za-z) of token[1] when token[0] is 'A', else of token[1]*62 + token[2].
// Apple may also answer 330 with `X-Apple-MMe-Host` to say the album lives on
// another host; that is followed once.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Album tokens are url-safe base64-ish; anything else is refused before it can
// reach a URL.
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

export function isValidAlbumToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

export function albumHost(token) {
  const idx = (c) => BASE62.indexOf(c);
  const n = token[0] === 'A' ? idx(token[1]) : idx(token[1]) * 62 + idx(token[2]);
  if (!Number.isInteger(n) || n < 0) throw new Error('Unrecognised album token');
  return `p${String(n).padStart(2, '0')}-sharedstreams.icloud.com`;
}

async function postJson(fetchFn, host, token, path, body) {
  const url = `https://${host}/${token}/sharedstreams/${path}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  if (res.status === 330) {
    // Moved: Apple names the right host in the body or a header.
    let moved = null;
    try { moved = (await res.json())['X-Apple-MMe-Host']; } catch (e) { /* fall through */ }
    return { moved: moved || res.headers.get('x-apple-mme-host') };
  }
  if (!res.ok) throw new Error(`Apple answered HTTP ${res.status}`);
  return { json: await res.json() };
}

async function callAlbum(fetchFn, token, path, body, startHost) {
  let host = startHost || albumHost(token);
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await postJson(fetchFn, host, token, path, body);
    if (out.json) return { json: out.json, host };
    if (!out.moved || !/^p\d+-sharedstreams\.icloud\.com$/.test(out.moved)) throw new Error('Apple redirected somewhere unexpected');
    host = out.moved;
  }
  throw new Error('Apple redirected twice');
}

// Newest first by when the photo was taken, then by when it was added.
const sortKey = (p) => `${p.dateCreated || ''}|${p.batchDateCreated || ''}`;

// Picks the smallest derivative at least `want` px wide, else the largest.
function pickDerivative(derivatives, want) {
  const sizes = Object.entries(derivatives || {}).map(([k, d]) => ({ checksum: d.checksum, width: Number(d.width) || Number(k) || 0, height: Number(d.height) || 0 }));
  if (!sizes.length) return null;
  sizes.sort((a, b) => a.width - b.width);
  return sizes.find((s) => s.width >= want) || sizes[sizes.length - 1];
}

// Pure: joins the two responses. Exported for the test.
// `expires` is the earliest `url_expiry` among the URLs actually returned (ISO,
// or null if Apple gave none): the signed links die then, so a caller must not
// hand them out for long after it. The route caches against it.
export function buildAlbum(stream, assets) {
  const items = (assets && assets.items) || {};
  let earliest = Infinity;
  const urlFor = (checksum) => {
    const it = items[checksum];
    if (!it || !it.url_location || !it.url_path) return null;
    const exp = Date.parse(it.url_expiry);
    if (Number.isFinite(exp) && exp < earliest) earliest = exp;
    return `https://${it.url_location}${it.url_path}`;
  };
  const photos = [];
  for (const p of [...(stream.photos || [])].sort((a, b) => sortKey(b).localeCompare(sortKey(a)))) {
    const thumb = pickDerivative(p.derivatives, 300);
    const full = pickDerivative(p.derivatives, 1600);
    const thumbUrl = thumb && urlFor(thumb.checksum);
    const fullUrl = full && urlFor(full.checksum);
    // A photo Apple gave no URL for is left out rather than shown broken.
    if (!thumbUrl && !fullUrl) continue;
    photos.push({
      id: p.photoGuid,
      caption: p.caption || '',
      date: p.dateCreated || null,
      by: p.contributorFirstName || '',
      width: Number(p.width) || (full && full.width) || null,
      height: Number(p.height) || (full && full.height) || null,
      thumb: thumbUrl || fullUrl,
      full: fullUrl || thumbUrl,
    });
  }
  return { name: stream.streamName || '', photos, expires: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null };
}

export async function fetchSharedAlbum(token, fetchFn = fetch) {
  if (!isValidAlbumToken(token)) throw new Error('Album token is not configured or is malformed');
  const { json: stream, host } = await callAlbum(fetchFn, token, 'webstream', { streamCtag: null });
  const guids = (stream.photos || []).map((p) => p.photoGuid).filter(Boolean);
  if (!guids.length) return { name: stream.streamName || '', photos: [], expires: null };
  const { json: assets } = await callAlbum(fetchFn, token, 'webasseturls', { photoGuids: guids }, host);
  return buildAlbum(stream, assets);
}
