// One-off import of past seasons' attendees (2016-2025) from the old Google
// Sheet ("Vikings Season Tickets - Who Is Going?") into the ticket store behind
// api/vikings.js. The sheet was read once and matched to the schedule by date
// (by opponent where the date was missing), then frozen in
// scripts/vikings-import-data.json as per-game patches in the endpoint's own
// shape: { game: '2019-3', seats: { 1: 'Jeff', 2: 'Kristin' }, face? }.
// The game key is the schedule's week number, which the sheet doesn't carry.
// Seat 15/16 are Jeff's 2024-only Section 101 pair.
//
// Requires SITE_PASSWORD (same login as the page). Run it through
// import-vikings-history.yml: the Vercel host is unreachable from a sandbox.
//
// It only FILLS EMPTY CELLS. A seat or face value the store already holds is
// left alone and reported, so re-running is harmless and nothing typed in the
// Admin tab since can be overwritten. DRY_RUN=1 logs the plan and writes
// nothing. 2026 is deliberately not in the data: the page is the source of
// truth for the current season.
//
// Run: SITE_PASSWORD=... [DRY_RUN=1] node scripts/import-vikings-history.mjs

import fs from 'node:fs';

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

// Pure and separately tested (test-vikings-import.mjs). `stored` is the
// endpoint's { games } document; returns { send, skipped } where `send` is
// the patches reduced to cells the store doesn't have yet, and `skipped`
// counts what was already there.
export function planImport(stored, patches) {
  const games = (stored && stored.games) || {};
  const send = [];
  let skipped = 0;
  for (const p of patches) {
    const have = games[p.game] || {};
    const out = { game: p.game };
    const seats = {};
    for (const [id, name] of Object.entries(p.seats || {})) {
      if ((have.seats || {})[id]) skipped++; else seats[id] = name;
    }
    if (Object.keys(seats).length) out.seats = seats;
    if (p.face !== undefined) {
      if (have.face) skipped++; else out.face = p.face;
    }
    if (out.seats || out.face !== undefined) send.push(out);
  }
  return { send, skipped };
}

async function main() {
  const password = process.env.SITE_PASSWORD;
  if (!password) {
    console.error('SITE_PASSWORD is not set in the environment.');
    process.exitCode = 1;
    return;
  }
  const { patches } = JSON.parse(fs.readFileSync(new URL('./vikings-import-data.json', import.meta.url), 'utf8'));

  const storedRes = await fetch(`${API_BASE}/api/vikings`);
  const storedBody = await storedRes.json();
  if (!storedRes.ok) throw new Error(`Reading the store failed (${storedRes.status}): ${storedBody.error || ''}`);
  const { send, skipped } = planImport(storedBody.tickets, patches);
  console.log(`${patches.length} games in the import; ${send.length} to write, ${skipped} cell(s) already filled and left alone.`);
  if (process.env.DRY_RUN) {
    for (const p of send) console.log(`  would write ${JSON.stringify(p)}`);
    return;
  }

  const loginRes = await fetch(`${API_BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const loginBody = await loginRes.json();
  if (!loginRes.ok) throw new Error(`Login failed (${loginRes.status}): ${loginBody.error || 'unknown error'}`);

  // One at a time: each POST is a read-modify-write on one document.
  let written = 0;
  for (const p of send) {
    const res = await fetch(`${API_BASE}/api/vikings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` },
      body: JSON.stringify(p),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${p.game}: ${res.status} ${(body.details && body.details.join('; ')) || body.error || ''} (${written} written before this)`);
    written++;
  }
  console.log(`Wrote ${written} game(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
