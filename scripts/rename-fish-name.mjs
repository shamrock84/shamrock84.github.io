// Renames a fisherman across the saved myFish trips (the trip log in Upstash,
// behind api/fam.js `?resource=fishtrips`), which a sandbox can't reach, so this
// runs in rename-fish-name.yml. It changes three things and nothing else: a
// fisherman's row name, and a day's "first fish" and "biggest fish" credits,
// wherever the whole value is the old name (ignoring case and spacing).
//
// Reports by default. With APPLY=1 it logs in (SITE_PASSWORD, the same login as
// the Admin tabs) and saves the whole list back, exactly as the Trips card's Save
// does. If a trip already has a fisherman called the new name, the rename would
// list him twice, so it stops and changes nothing.
//
// Usage:
//   FROM=Grandpa TO=Gary node scripts/rename-fish-name.mjs            # report only
//   SITE_PASSWORD=... APPLY=1 FROM=Grandpa TO=Gary node scripts/rename-fish-name.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

const norm = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');

// Pure: returns { trips, changes, conflicts } without touching the input.
// `changes` counts each kind of rename; `conflicts` names trips where `to` is
// already a fisherman (the rename is then refused as a whole by the caller).
export function renameInTrips(trips, from, to) {
  const out = JSON.parse(JSON.stringify(trips));
  const changes = { anglers: 0, first: 0, biggest: 0 };
  const conflicts = [];
  for (const t of out) {
    const hasFrom = t.anglers.some((a) => norm(a.name) === norm(from));
    if (hasFrom && t.anglers.some((a) => norm(a.name) === norm(to))) conflicts.push(`${t.year}${t.location ? ` (${t.location})` : ''}`);
    for (const a of t.anglers) if (norm(a.name) === norm(from)) { a.name = to; changes.anglers++; }
    for (const d of t.days) {
      if (norm(d.first) === norm(from)) { d.first = to; changes.first++; }
      if (norm(d.biggest) === norm(from)) { d.biggest = to; changes.biggest++; }
    }
  }
  return { trips: out, changes, conflicts };
}

async function main() {
  const from = (process.env.FROM || '').trim();
  const to = (process.env.TO || '').trim();
  if (!from || !to || norm(from) === norm(to)) {
    console.error('Set FROM and TO to two different names.');
    process.exitCode = 1;
    return;
  }
  const res = await fetch(`${API_BASE}/api/fam?resource=fishtrips`, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body.trips)) {
    console.error(`Reading the trips failed (${res.status}): ${body.error || 'unexpected response'}`);
    process.exitCode = 1;
    return;
  }
  const { trips, changes, conflicts } = renameInTrips(body.trips, from, to);
  const total = changes.anglers + changes.first + changes.biggest;
  console.log(`${body.trips.length} trips${body.seeded ? ' (the built-in seed: nothing has been saved yet)' : ''}. "${from}" -> "${to}": ${changes.anglers} fisherman row(s), ${changes.first} first-fish credit(s), ${changes.biggest} biggest-fish credit(s).`);
  if (conflicts.length) {
    console.error(`Stopped: ${to} is already a fisherman on ${conflicts.join(', ')}; renaming would list him twice. Nothing changed.`);
    process.exitCode = 1;
    return;
  }
  if (!total) { console.log('Nothing to rename.'); return; }
  if (process.env.APPLY !== '1') { console.log('Report only: set APPLY=1 to save the rename.'); return; }

  const password = process.env.SITE_PASSWORD;
  if (!password) { console.error('SITE_PASSWORD is not set in the environment.'); process.exitCode = 1; return; }
  const login = await fetch(`${API_BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const loginBody = await login.json().catch(() => ({}));
  if (!login.ok) { console.error(`Login failed (${login.status}): ${loginBody.error || 'unknown error'}`); process.exitCode = 1; return; }
  const post = await fetch(`${API_BASE}/api/fam`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify({ resource: 'fishtrips', trips }),
  });
  const postBody = await post.json().catch(() => ({}));
  if (!post.ok) { console.error(`Save failed (${post.status}): ${(postBody.details && postBody.details.join('; ')) || postBody.error || 'unknown error'}`); process.exitCode = 1; return; }
  console.log(`Saved ${postBody.trips.length} trips.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
