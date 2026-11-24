// Asks the two places a future myBooks page could read reading data from
// what they actually return. Neither has a public API: Goodreads stopped
// issuing developer keys in December 2020, and Libby (OverDrive) has never
// offered a patron-data API. What remains:
//   - Goodreads: the undocumented per-shelf RSS feed,
//     https://www.goodreads.com/review/list_rss/<user id>?shelf=<shelf>.
//     It needs a public profile, and nothing promises it will keep working.
//   - Libby: the Timeline export's "Data (json)" share link,
//     https://share.libbyapp.com/data/<uuid>/libbytimeline-all-loans.json.
// Neither host is reachable from the sandbox this repo is edited from (the
// egress proxy rejects both), which is why this is a probe and not code.
// No credentials, read-only GETs. Either half is skipped when its input is unset.
//
// Inputs (env): GOODREADS_USER_ID (the number in your profile URL; a
// "12345-name" slug is accepted) and LIBBY_TIMELINE_URL (the share link).
// The Libby link is a capability URL (anyone who has it can read your loan
// history), so the workflow passes it as a secret, not a dispatch input.
//
// The questions it answers, which decide how myBooks gets its data:
//   Goodreads
//   1. Does the feed answer at all, for this profile, per shelf (read,
//      currently-reading, to-read, and the all-shelves default)?
//   2. What fields does an <item> carry? We hope for: title, author, isbn,
//      user_rating, user_read_at, user_date_added, user_shelves, cover,
//      num_pages.
//   3. How big is a page, does `per_page` raise it, and does `page=2`
//      return the next books? This decides how the sync walks a long shelf.
//   Libby
//   4. Does the share link answer without a session, and what's its shape:
//      top-level keys, entry count, the field names of an entry?
//   5. How current is it? The newest entry's timestamp plus the caching
//      headers (Last-Modified / ETag / Cache-Control). Compare the newest
//      entry with your last borrow: if the link lags behind, it's a frozen
//      snapshot and needs a re-export to refresh, not a live feed.
//   6. Do .csv / .html siblings exist at the same path?
//
// Output goes to the Actions log. If the repository is public, so is the
// log. The probe prints counts, field names and two sample entries, so
// those two titles are visible to anyone who opens the run.
//
// RUN 1 (2026-11-24): Goodreads skipped. GOODREADS_USER_ID was set but
// didn't start with digits (the parser now also takes a profile URL).
// Libby answered:
//   - HTTP 200 with no session, application/json, 841 bytes. ETag present,
//     no Last-Modified, `Cache-Control: max-age=0, private,
//     must-revalidate`: served fresh per request, not a static file on a CDN.
//     That suggests, but doesn't prove, that the link tracks new activity.
//   - Shape: { version: 1, timeline: [entry] }, 1 entry. Entry fields:
//     cover {contentType, url} (od-cdn.com image), title {text, url,
//     titleId}, author, publisher, isbn, timestamp (epoch ms), activity
//     ("Borrowed"), details (" 21 days ", padded: trim it), library {text,
//     url, key}.
//   - Newest entry 2026-11-22T21:52:18Z.
//   - .csv (text/csv) and .html (text/html) siblings both answer 200.
//   Still open: does the same link show a borrow or return made after the
//   export without re-exporting? Re-run after one and compare entry counts.

const UA = 'Mozilla/5.0 (compatible; personal-site-probe/1.0)';
// Accepts the bare id, a "12345-name" slug, or a whole profile URL
// (goodreads.com/user/show/12345-name). RUN 1 skipped Goodreads because
// the secret held something this didn't recognise as an id.
const goodreadsRaw = (process.env.GOODREADS_USER_ID || '').trim();
const goodreadsId = goodreadsRaw.match(/user\/show\/(\d+)/)?.[1] || goodreadsRaw.match(/^\d+/)?.[0] || '';
const libbyUrl = (process.env.LIBBY_TIMELINE_URL || '').trim();

async function get(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    const body = await res.text();
    return { res, body };
  } catch (err) {
    return { error: err.cause?.message || err.message };
  }
}

function headerSummary(res) {
  const keys = ['content-type', 'last-modified', 'etag', 'cache-control', 'age', 'expires'];
  return keys.map(k => `${k}: ${res.headers.get(k) ?? '-'}`).join(' | ');
}

const truncate = (s, n = 100) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str && str.length > n ? `${str.slice(0, n)}…` : str;
};

// ---------- Goodreads ----------

// Minimal RSS reader: one <item> per book. Only leaf elements are read
// (text or a single CDATA), so a wrapper such as <book id="…"><num_pages>
// yields its children rather than hiding them. Regexes are enough for a probe.
function rssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const fields = {};
    for (const f of m[1].matchAll(/<([a-zA-Z_:]+)(?:\s[^>]*)?>(<!\[CDATA\[[\s\S]*?\]\]>|[^<]*)<\/\1>/g)) {
      fields[f[1]] = f[2].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
    }
    return fields;
  });
}

async function probeGoodreads() {
  console.log('\n######## Goodreads RSS ########');
  if (!goodreadsId) {
    // Say which: unset, or set to something without a numeric id (a
    // username alone isn't enough; the feed URL needs the number).
    console.log(goodreadsRaw
      ? `GOODREADS_USER_ID is set (${goodreadsRaw.length} chars, ${/^https?:/.test(goodreadsRaw) ? 'a URL' : 'not a URL'}) but holds no numeric id; skipped. Use the number from goodreads.com/user/show/<number>-name.`
      : 'GOODREADS_USER_ID not set; skipped.');
    return;
  }
  const base = `https://www.goodreads.com/review/list_rss/${goodreadsId}`;

  // 1 + 2: each shelf, first page.
  for (const shelf of ['read', 'currently-reading', 'to-read', null]) {
    const url = shelf ? `${base}?shelf=${shelf}` : base;
    console.log(`\n=== ${shelf ?? '(no shelf param)'}: ${url}`);
    const r = await get(url);
    if (r.error) { console.log(`fetch failed: ${r.error}`); continue; }
    console.log(`HTTP ${r.res.status}  final URL ${r.res.url}`);
    console.log(headerSummary(r.res));
    const items = rssItems(r.body);
    if (!items.length) {
      console.log(`no <item>s. Body starts: ${truncate(r.body.replace(/\s+/g, ' '), 600)}`);
      continue;
    }
    const channelTitle = r.body.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1];
    console.log(`channel title: ${truncate(channelTitle?.replace(/<!\[CDATA\[|\]\]>/g, ''))}`);
    console.log(`items on page 1: ${items.length}`);
    if (shelf === 'read') {
      const allKeys = [...new Set(items.flatMap(Object.keys))];
      console.log(`item fields (${allKeys.length}): ${allKeys.join(', ')}`);
      const empty = allKeys.filter(k => items.every(i => !i[k]));
      console.log(`fields empty on every item: ${empty.join(', ') || '(none)'}`);
      for (const item of items.slice(0, 2)) {
        console.log('sample item:');
        for (const [k, v] of Object.entries(item)) console.log(`  ${k}: ${truncate(v)}`);
      }
    }
  }

  // 3: page size and pagination on the read shelf.
  console.log('\n=== pagination (shelf=read)');
  const titlesOf = body => rssItems(body).map(i => i.title);
  const p1 = await get(`${base}?shelf=read&page=1`);
  const p2 = await get(`${base}?shelf=read&page=2`);
  const big = await get(`${base}?shelf=read&per_page=200`);
  if (p1.error || p2.error || big.error) {
    console.log(`fetch failed: ${p1.error || p2.error || big.error}`);
    return;
  }
  const t1 = titlesOf(p1.body), t2 = titlesOf(p2.body), tb = titlesOf(big.body);
  const overlap = t2.filter(t => t1.includes(t)).length;
  console.log(`page=1: ${t1.length} items | page=2: ${t2.length} items, ${overlap} also on page 1`);
  console.log(`per_page=200: ${tb.length} items (${tb.length > t1.length ? 'per_page raises the page size' : 'per_page has no effect'})`);
  if (t2.length && overlap === t2.length) console.log('page=2 repeats page 1: `page` is ignored.');
}

// ---------- Libby ----------

// Finds the biggest array of objects anywhere in the document: that's the
// timeline, whatever the top-level key turns out to be called.
function largestObjectArray(node, path = '$', best = { path: null, arr: [] }) {
  if (Array.isArray(node)) {
    if (node.length > best.arr.length && node.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      best = { path, arr: node };
    }
    node.forEach((x, i) => { if (i < 3) best = largestObjectArray(x, `${path}[${i}]`, best); });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) best = largestObjectArray(v, `${path}.${k}`, best);
  }
  return best;
}

// A value that could be a time: epoch ms, epoch s, or an ISO-like string.
function asDate(v) {
  if (typeof v === 'number') {
    if (v > 1e12 && v < 4e12) return new Date(v);
    if (v > 1e9 && v < 4e9) return new Date(v * 1000);
    return null;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function describeFields(entries) {
  const stats = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e)) {
      const s = (stats[k] ||= { count: 0, types: new Set() });
      s.count++;
      s.types.add(Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    }
  }
  return Object.entries(stats)
    .map(([k, s]) => `  ${k}: ${[...s.types].join('|')} (on ${s.count}/${entries.length})`)
    .join('\n');
}

async function probeLibby() {
  console.log('\n######## Libby timeline export ########');
  if (!libbyUrl) {
    console.log('LIBBY_TIMELINE_URL not set; skipped.');
    return;
  }
  let parsed;
  try {
    parsed = new URL(libbyUrl);
  } catch {
    console.log('LIBBY_TIMELINE_URL is not a URL; skipped.');
    return;
  }
  // Don't echo the uuid: it's the secret part of the link.
  console.log(`host ${parsed.host}, file ${parsed.pathname.split('/').pop()}`);

  const r = await get(libbyUrl);
  if (r.error) { console.log(`fetch failed: ${r.error}`); return; }
  console.log(`HTTP ${r.res.status}, ${r.body.length} bytes`);
  console.log(headerSummary(r.res));

  let data;
  try {
    data = JSON.parse(r.body);
  } catch {
    console.log(`not JSON. Body starts: ${truncate(r.body.replace(/\s+/g, ' '), 600)}`);
    return;
  }
  console.log(`top-level: ${Array.isArray(data) ? `array of ${data.length}` : `keys ${Object.keys(data).join(', ')}`}`);
  if (!Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (!Array.isArray(v) && typeof v !== 'object') console.log(`  ${k}: ${truncate(v)}`);
    }
  }

  const { path, arr } = largestObjectArray(data);
  if (!arr.length) { console.log('no array of entries found.'); return; }
  console.log(`\nentries: ${arr.length} at ${path}`);
  console.log(`entry fields:\n${describeFields(arr)}`);

  // Which fields look like times, and the span of each.
  const timeKeys = [...new Set(arr.flatMap(e => Object.keys(e).filter(k => asDate(e[k]))))];
  for (const k of timeKeys) {
    const ds = arr.map(e => asDate(e[k])).filter(Boolean).sort((a, b) => a - b);
    console.log(`time field ${k}: ${ds[0].toISOString()} -> ${ds.at(-1).toISOString()} (${ds.length} entries)`);
  }
  if (timeKeys.length) console.log('Compare the newest date with your most recent Libby borrow: older means the link is a snapshot.');

  // Values of fields that look like a category (activity type etc.).
  for (const k of Object.keys(arr[0])) {
    const vals = arr.map(e => e[k]).filter(v => typeof v === 'string');
    const distinct = new Set(vals);
    if (vals.length === arr.length && distinct.size > 1 && distinct.size <= 8) {
      const counts = [...distinct].map(v => `${v}=${vals.filter(x => x === v).length}`).join(', ');
      console.log(`category-like field ${k}: ${counts}`);
    }
  }

  for (const e of arr.slice(0, 2)) {
    console.log('sample entry:');
    for (const [k, v] of Object.entries(e)) console.log(`  ${k}: ${truncate(v)}`);
  }

  // 6: siblings at the same path.
  for (const ext of ['csv', 'html']) {
    const sib = libbyUrl.replace(/\.json(\?.*)?$/, `.${ext}$1`);
    if (sib === libbyUrl) break;
    const s = await get(sib);
    console.log(`.${ext} sibling: ${s.error ? `fetch failed: ${s.error}` : `HTTP ${s.res.status}, ${s.res.headers.get('content-type')}, ${s.body.length} bytes`}`);
  }
}

await probeGoodreads();
await probeLibby();
