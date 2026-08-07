#!/usr/bin/env node
// Dumps each league's real scoring settings, so the PPR/HALF/STD detection can
// be written against what the providers actually return rather than guessed.
//
// The question it answers is narrow: how many points is a reception worth?
// 1 is PPR, 0.5 is half, 0 (or no rule at all) is standard. That single number
// is the whole of what config/leagues.json's `scoring` field means — it picks
// which FantasyPros list the ECR column is drawn from, and nothing else.
//
// Where it lives per provider:
//   MFL     — TYPE=rules. Shape unverified, which is why this exists; the raw
//             dump below is what the parser gets written against.
//   ESPN    — view=mSettings, settings.scoringSettings.scoringItems. statId 53
//             is receptions.
//   Sleeper — the league object's scoring_settings.rec. Public, no auth.
//
// Read-only. Run from the Actions tab (probe-league-scoring.yml).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, espnGet, seasonOf } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

// One league per provider gets its raw body printed, enough to see the shape
// without burying the run in 18 full scoring tables.
const shapeShown = new Set();
const clip = (v, n = 1200) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}… [${s.length} chars total]` : s;
};

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

for (const league of leagues) {
  const provider = league.provider || 'mfl';
  const season = seasonOf(league);
  console.log(`\n=== ${league.name || league.id} (${provider}, id ${league.id}) ===`);
  console.log(`  configured scoring: ${league.scoring || '(unset — treated as PPR)'}`);

  try {
    if (provider === 'mfl') {
      const data = await mflGet(`/export?TYPE=rules&L=${league.id}&JSON=1`, cookie, season);
      if (!shapeShown.has('mfl')) {
        shapeShown.add('mfl');
        console.log(`  RAW SHAPE: ${clip(data, 2000)}`);
      }
      // Cast a wide net: print every rule whose event mentions a catch/reception
      // code, whatever nesting it turns out to live under.
      const found = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        const ev = String(node.event ?? '');
        if (/\bCC\b|CATCH|REC/i.test(ev)) found.push(node);
        Object.values(node).forEach(walk);
      };
      walk(data);
      console.log(found.length
        ? `  reception-ish rules: ${clip(found, 800)}`
        : '  reception-ish rules: NONE FOUND — check the raw shape above');
    } else if (provider === 'espn') {
      const data = await espnGet(league, 'view=mSettings');
      const items = data?.settings?.scoringSettings?.scoringItems || [];
      if (!shapeShown.has('espn')) {
        shapeShown.add('espn');
        console.log(`  RAW SHAPE (first 3 scoringItems): ${clip(items.slice(0, 3), 900)}`);
        console.log(`  scoringItems count: ${items.length}`);
      }
      const rec = items.filter((i) => i.statId === 53);
      console.log(`  statId 53 (receptions): ${rec.length ? clip(rec, 600) : 'NONE — implies standard'}`);
    } else if (provider === 'sleeper') {
      const res = await fetch(`https://api.sleeper.app/v1/league/${league.id}`);
      const data = await res.json();
      const ss = data?.scoring_settings || {};
      if (!shapeShown.has('sleeper')) {
        shapeShown.add('sleeper');
        console.log(`  RAW SHAPE (reception-ish keys): ${clip(
          Object.fromEntries(Object.entries(ss).filter(([k]) => /rec/i.test(k))), 600)}`);
      }
      console.log(`  scoring_settings.rec: ${JSON.stringify(ss.rec)}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}

console.log('\nWhat to read from this: for each league, the points-per-reception.');
console.log('1 -> PPR, 0.5 -> HALF, 0 or absent -> STD. Anything else is a league');
console.log('that does not map onto FantasyPros\' three lists and should stay manual.');
