// Keeps the "Dev" Quick Links group the same on every page.
//
// The source of truth is myFFL's: the entries with `group: 'Dev'` in
// config/leagues.json's `quickLinks` (edited in myFFL's Admin tab). The other
// four sites keep their Quick Links in Upstash behind api/vikings.js,
// api/bangers.js and api/fam.js (myFAM and myFish), which this script reaches
// over HTTP, so it has to run where Vercel is reachable (sync-dev-quicklinks.yml).
//
// By default it only REPORTS, per site, whether the Dev group matches. With
// APPLY_SITES (comma-separated, from vikings, bangers, fam, fish) it also
// rewrites the Dev group on those sites, and nothing else: their other links
// are kept as they are, and the Dev group is placed where the old one was (or
// at the end if there was none). Writing needs SITE_PASSWORD, the same login
// as the Admin tabs.
//
// Usage:
//   node scripts/sync-dev-quicklinks.mjs                        # report only
//   SITE_PASSWORD=... APPLY_SITES=fish node scripts/sync-dev-quicklinks.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';
const DEV_GROUP = 'dev';

// Where each site's list lives. `resource` is the quick-links resource name on
// its endpoint (myFish rides api/fam.js under its own name).
export const SITES = {
  vikings: { api: 'vikings', resource: 'quicklinks' },
  bangers: { api: 'bangers', resource: 'quicklinks' },
  fam: { api: 'fam', resource: 'quicklinks' },
  fish: { api: 'fam', resource: 'fishquicklinks' },
};

const isDev = (l) => !!l && typeof l.group === 'string' && l.group.trim().toLowerCase() === DEV_GROUP;

// The fields the sites store, in a fixed order, so two lists compare by value.
export function canonical(l) {
  const out = { url: l.url, nickname: l.nickname };
  for (const k of ['style', 'visibility', 'group']) if (l[k]) out[k] = l[k];
  return out;
}

// myFFL's Dev entries (the League Links placeholder has no url, so it never matches).
export function devLinksFrom(quickLinks) {
  return (quickLinks || []).filter((l) => isDev(l) && l.url && l.nickname).map(canonical);
}

export function sameDev(links, dev) {
  return JSON.stringify((links || []).filter(isDev).map(canonical)) === JSON.stringify(dev);
}

// `links` with its Dev group replaced by `dev`; everything else untouched and
// in order. The group goes where the first old Dev entry was, else at the end.
export function withDevGroup(links, dev) {
  const out = [];
  let placed = false;
  for (const l of links || []) {
    if (isDev(l)) {
      if (!placed) { out.push(...dev); placed = true; }
      continue;
    }
    out.push(l);
  }
  if (!placed) out.push(...dev);
  return out;
}

async function main() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'leagues.json'), 'utf8'));
  const dev = devLinksFrom(config.quickLinks);
  if (!dev.length) {
    console.error('No Dev group found in config/leagues.json quickLinks.');
    process.exitCode = 1;
    return;
  }
  console.log(`Source (myFFL): ${dev.map((l) => l.nickname).join(', ')}`);

  const apply = (process.env.APPLY_SITES || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of apply) {
    if (!SITES[s]) { console.error(`Unknown site "${s}" in APPLY_SITES (use ${Object.keys(SITES).join(', ')}).`); process.exitCode = 1; return; }
  }

  let token = null;
  if (apply.length) {
    const password = process.env.SITE_PASSWORD;
    if (!password) { console.error('SITE_PASSWORD is not set in the environment.'); process.exitCode = 1; return; }
    const res = await fetch(`${API_BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`Login failed (${res.status}): ${body.error || 'unknown error'}`); process.exitCode = 1; return; }
    token = body.token;
  }

  for (const [site, { api, resource }] of Object.entries(SITES)) {
    const url = `${API_BASE}/api/${api}?resource=${resource}`;
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`${site}: read failed (${res.status}): ${body.error || 'unknown error'}`); process.exitCode = 1; continue; }
    const links = Array.isArray(body.links) ? body.links : [];
    const have = links.filter(isDev).map((l) => l.nickname);
    const same = sameDev(links, dev);
    console.log(`${site}: ${links.length} links; Dev group ${same ? 'MATCHES' : `DIFFERS (has: ${have.length ? have.join(', ') : 'none'})`}`);
    if (!apply.includes(site)) continue;
    if (same) { console.log(`${site}: already in step, nothing written.`); continue; }
    const next = withDevGroup(links, dev);
    const post = await fetch(`${API_BASE}/api/${api}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ resource, links: next }),
    });
    const postBody = await post.json().catch(() => ({}));
    if (!post.ok) { console.error(`${site}: save failed (${post.status}): ${(postBody.details && postBody.details.join('; ')) || postBody.error || 'unknown error'}`); process.exitCode = 1; continue; }
    console.log(`${site}: saved (${next.length} links, Dev group: ${next.filter(isDev).map((l) => l.nickname).join(', ')}).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
