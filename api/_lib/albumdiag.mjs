// TEMPORARY diagnostic for myFish's album. Newer share links
// (photos.icloud.com/shared/album/055-xxxx) 404 on the sharedstreams API that
// sharedalbum.mjs uses, and Apple documents none of this. When every token form
// 404s, sharedalbum.mjs appends what this finds to the error, which the Photos tab
// shows: how Apple's own viewer page for the link loads its photos (the page, the
// hosts it names, and any API paths in its scripts). It runs from Vercel because
// the token lives only there and this sandbox cannot reach Apple. The token and
// its pieces are replaced by '…' in everything returned. Delete this file, and its
// call in sharedalbum.mjs, once the new format is understood.

const LIMIT = 1100;

export async function diagnoseNewLink(token, fetchFn = fetch) {
  const m = /^\d{3}-(.+)$/.exec(token);
  const pieces = [token, m && m[1]].filter(Boolean);
  const scrub = (t) => pieces.reduce((out, p) => out.split(p).join('…'), String(t));
  const get = async (url) => {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15', Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return { res, text: typeof res.text === 'function' ? await res.text() : '' };
  };
  const notes = [];
  try {
    const page = await get(`https://photos.icloud.com/shared/album/${token}`);
    notes.push(`viewer page HTTP ${page.res.status} ${(page.res.headers && page.res.headers.get && page.res.headers.get('content-type')) || ''}`.trim());
    const html = page.text;
    const title = /<title[^>]*>([^<]{0,80})/i.exec(html);
    if (title) notes.push(`title "${title[1].trim()}"`);
    const urls = [...new Set((html.match(/https?:\/\/[A-Za-z0-9.-]*(?:icloud|apple)[A-Za-z0-9.\-_/]{0,80}/g) || []).map(scrub))].slice(0, 8);
    if (urls.length) notes.push(`urls: ${urls.join(' ')}`);
    const scripts = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((x) => x[1]))].slice(0, 3);
    const found = new Set();
    for (const src of scripts) {
      try {
        const url = new URL(src, 'https://photos.icloud.com/').toString();
        if (!/\.(apple|icloud)(-content)?\.com\//.test(url)) continue;
        const js = (await get(url)).text;
        for (const hit of js.matchAll(/(.{0,50})(sharedstreams|webasseturls|webstream|ckdatabasews|shared\/album|sharedalbum)(.{0,60})/g)) {
          found.add(scrub(`${hit[1]}${hit[2]}${hit[3]}`).replace(/\s+/g, ' '));
          if (found.size >= 6) break;
        }
      } catch (e) { notes.push(`script ${scrub(src).slice(0, 60)}: ${scrub(e.message)}`); }
      if (found.size >= 6) break;
    }
    if (found.size) notes.push(`script hits: ${[...found].join(' ¦ ')}`);
  } catch (e) {
    notes.push(`viewer page failed: ${scrub(e && e.cause && e.cause.code ? e.cause.code : e && e.message)}`);
  }
  return scrub(notes.join(' | ')).slice(0, LIMIT);
}
