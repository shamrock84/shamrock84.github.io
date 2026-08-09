#!/usr/bin/env node
// Asks MFL what it will tell us about whether a league's draft is running.
//
// The question this exists to answer: can the sync tell a league that is
// mid-draft from one that has finished (or never started)? It matters for the
// Top Available card, which during a live draft lists elite players as free
// agents — true at the instant it was read, and useless, because they aren't
// claimable off a wire, they're about to be drafted by somebody. August
// Judgment Day looks exactly like this today: five players rostered in a
// superflex league that starts 1-2 QB, 2-4 RB, 3-5 WR, 1-3 TE.
//
// Roster size is a guess, not a signal — a small roster and a half-finished
// draft look identical. So this dumps the endpoints that might carry a real
// one, for a drafting league and for settled ones side by side, since a field
// only tells us something if it *differs* between the two.
//
//   TYPE=league       — already fetched by every sync, so a usable field here
//                       would be free. Printed as a key list, not in full.
//   TYPE=draftResults — the obvious candidate. MFL is understood to list every
//                       pick including unmade ones (empty player attribute),
//                       which would make "some made, some not" the signal, but
//                       that is exactly the assumption worth checking rather
//                       than coding against.
//
// Read-only. Run from the Actions tab (probe-draft-status.yml).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const ROSTERS_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));

const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

// Same seasons the sync resolved, for the same reason probe-league-scoring
// does it: a probe that asks about a different season than the sync isn't
// auditing the sync.
let synced = new Map();
try {
  const prev = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
  synced = new Map((prev.leagues || []).map((l) => [l.id, l]));
} catch {
  console.log('No data/rosters.json — falling back to the calendar year.\n');
}
for (const league of leagues) {
  const season = synced.get(league.id)?.season;
  if (season && !league.season) league.season = String(season);
}

const mflLeagues = leagues.filter((l) => (l.provider || 'mfl') === 'mfl' && l.franchiseId);

// A handful, not all sixteen: this is a shape-finding run, and TYPE=draftResults
// on every league would spend the rate limit for no extra information. Take the
// leagues holding the fewest players (most likely mid-draft) plus a couple of
// clearly-settled ones to contrast against.
const rosterSize = (l) => (synced.get(l.id)?.players || []).length;
const bySize = [...mflLeagues].sort((a, b) => rosterSize(a) - rosterSize(b));
const sample = [...bySize.slice(0, 4), ...bySize.slice(-2)];

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

// Anything that looks like it could be a status, wherever MFL happens to put
// it. Printed rather than interpreted — the point is to see the vocabulary.
const INTERESTING = /draft|pick|status|start|clock|time|paus|complet/i;

for (const league of sample) {
  const season = seasonOf(league);
  console.log('='.repeat(72));
  console.log(`${league.name}  (L=${league.id}, season ${season}, ${rosterSize(league)} players rostered by us)`);
  console.log('='.repeat(72));

  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, season);
    const obj = data?.league ?? {};
    const scalars = Object.entries(obj).filter(([, v]) => typeof v !== 'object' || v === null);
    console.log('  TYPE=league scalar keys:', scalars.map(([k]) => k).join(', ') || '(none)');
    const hits = scalars.filter(([k]) => INTERESTING.test(k));
    if (hits.length) {
      console.log('  ...of which draft-ish:');
      for (const [k, v] of hits) console.log(`      ${k} = ${JSON.stringify(v)}`);
    } else {
      console.log('  ...none matching /draft|pick|status|start|clock|time|paus|complet/');
    }
  } catch (err) {
    console.log(`  TYPE=league FAILED: ${err.message}`);
  }

  try {
    const data = await mflGet(`/export?TYPE=draftResults&L=${league.id}&JSON=1`, cookie, season);
    const unit = data?.draftResults?.draftUnit;
    const units = Array.isArray(unit) ? unit : unit ? [unit] : [];
    if (units.length === 0) {
      console.log('  TYPE=draftResults: no draftUnit at all —', JSON.stringify(data).slice(0, 240));
    }
    for (const u of units) {
      const attrs = Object.fromEntries(Object.entries(u).filter(([k]) => k !== 'draftPick'));
      console.log('  TYPE=draftResults draftUnit attrs:', JSON.stringify(attrs));
      const raw = u.draftPick;
      const picks = Array.isArray(raw) ? raw : raw ? [raw] : [];
      // The shape question: is an unmade pick listed with an empty player, or
      // simply absent? "Some made, some not" is only a usable signal if unmade
      // picks are actually returned.
      const made = picks.filter((p) => p.player && p.player !== '');
      const empty = picks.filter((p) => !p.player || p.player === '');
      console.log(`      picks returned: ${picks.length}  (with a player: ${made.length}, without: ${empty.length})`);
      if (picks.length) console.log('      first pick keys:', Object.keys(picks[0]).join(', '));
      if (picks.length) console.log('      first pick:', JSON.stringify(picks[0]));
      if (made.length) console.log('      last made pick:', JSON.stringify(made[made.length - 1]));
      if (empty.length) console.log('      first unmade pick:', JSON.stringify(empty[0]));
      // A timestamp on the most recent pick would answer "is it moving right
      // now" even if no explicit status field exists anywhere.
      const stamps = made.map((p) => Number(p.timestamp)).filter(Number.isFinite);
      if (stamps.length) {
        const latest = Math.max(...stamps);
        const hours = (Date.now() / 1000 - latest) / 3600;
        console.log(`      most recent pick: ${new Date(latest * 1000).toISOString()} (${hours.toFixed(1)}h ago)`);
      }
    }
  } catch (err) {
    console.log(`  TYPE=draftResults FAILED: ${err.message}`);
  }
}

console.log('\nDone. What to look for: a field that differs between the short-roster');
console.log('leagues at the top and the settled ones at the bottom. If nothing in');
console.log('TYPE=league differs, draftResults is the only source and the sync pays');
console.log('one extra request per league for it.');
