#!/usr/bin/env node
// Reports what scoring format each league actually uses, and the raw number it
// was read from.
//
// The question is narrow: how many points is a reception worth? 1 is PPR, 0.5
// is half, 0 (or no rule at all) is standard. That single number is the whole of
// what config/leagues.json's `scoring` field means — it picks which FantasyPros
// list the ECR column is drawn from, and nothing else.
//
// Where it lives per provider, all three verified against the real APIs:
//   MFL     — TYPE=rules, rules.positionRules[].rule[] where event.$t is "CC"
//             and points.$t is "*1"-style. XML-derived, so every leaf is {$t}.
//   ESPN    — view=mSettings, settings.scoringSettings.scoringItems, statId 53.
//   Sleeper — the league object's scoring_settings.rec. Public, no auth.
//
// Detection itself lives in providers.mjs (detectScoringFormat) so this reports
// exactly what the sync will conclude, rather than a parallel implementation
// that could agree with it today and drift tomorrow.
//
// Read-only. Run from the Actions tab (probe-league-scoring.yml).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, detectScoringFormat } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const ROSTERS_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

// Read each league against the season the sync actually resolved it to, not the
// calendar year. Without this the probe silently disagrees with the sync for any
// league mid-rollover: Rug's Playground reported STD from an unconfigured 2026
// shell while the sync, correctly on 2025, read PPR. The audit tool has to ask
// the same question the sync asks or it isn't auditing anything.
let recordedSeasons = new Map();
try {
  const prev = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
  recordedSeasons = new Map((prev.leagues || []).map((l) => [l.id, l.season]));
} catch {
  console.log('No data/rosters.json to read seasons from — falling back to the calendar year.\n');
}
for (const league of leagues) {
  const season = recordedSeasons.get(league.id);
  if (season && !league.season) league.season = String(season);
}

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

const rows = [];
for (const league of leagues) {
  const provider = league.provider || 'mfl';
  const configured = league.scoring || null;
  try {
    const { format, points, values, byPosition } = await detectScoringFormat(league, cookie);
    rows.push({ name: league.name || league.id, provider, configured, format, points, values, byPosition, season: league.season || '(year)' });
  } catch (err) {
    rows.push({ name: league.name || league.id, provider, configured, error: err.message });
  }
}

const pad = (v, n) => String(v ?? '').padEnd(n);
console.log(`${pad('LEAGUE', 34)}${pad('SITE', 9)}${pad('SEASON', 8)}${pad('PER REC', 9)}${pad('DETECTED', 10)}${pad('CONFIGURED', 12)}NOTE`);
for (const r of rows) {
  if (r.error) {
    console.log(`${pad(r.name, 34)}${pad(r.provider, 9)}${pad('-', 8)}${pad('-', 9)}${pad('-', 10)}${pad(r.configured || '(unset)', 12)}FAILED: ${r.error}`);
    continue;
  }
  const effective = r.configured || 'PPR';
  const notes = [];
  // Distinct per-position rates mean a premium somewhere; the base rate is what
  // gets used, but it's worth seeing that it wasn't unanimous.
  const distinct = [...new Set(r.values)];
  // Print the actual per-position breakdown, not just the distinct rates: which
  // positions get which is the whole basis for picking the base rate.
  if (distinct.length > 1) notes.push(`by position ${JSON.stringify(r.byPosition)} — base ${r.points}`);
  if (!r.format) notes.push("doesn't map onto PPR/HALF/STD — left alone");
  else if (r.format !== effective) notes.push(`CHANGE: currently scored as ${effective}`);
  console.log(`${pad(r.name, 34)}${pad(r.provider, 9)}${pad(r.season, 8)}${pad(r.points, 9)}${pad(r.format || '-', 10)}${pad(r.configured || '(unset)', 12)}${notes.join('; ')}`);
}

const changes = rows.filter((r) => r.format && r.format !== (r.configured || 'PPR'));
const unmapped = rows.filter((r) => !r.error && !r.format);
console.log(`\n${rows.length} leagues: ${changes.length} would change, ${unmapped.length} don't map onto FantasyPros' three lists.`);
if (changes.length) {
  console.log('Would change:');
  for (const c of changes) console.log(`  ${c.name}: ${c.configured || 'PPR (default)'} -> ${c.format} (${c.points} per reception)`);
}
