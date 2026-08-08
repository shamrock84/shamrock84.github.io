// Asks FantasyPros what it actually returns for a ranked player, so linking a
// name to that player's profile page rests on the response rather than on a
// slug guessed from the name.
//
// This exists because api.fantasypros.com is unreachable from a sandbox and
// the key is a GitHub Actions secret, so the only place this question can be
// answered is a workflow run — the same reason probe-league-season.mjs and
// probe-league-scoring.mjs exist. Read-only: one consensus-rankings GET.
//
// What it reports:
//   - every field name on a ranked player, so a renamed or missing URL field
//     is visible rather than inferred from links silently vanishing;
//   - how many of the ranked players carry a usable page URL, since a field
//     that exists but is blank for half the list is a different answer;
//   - what playerPageUrl() makes of them, including the duplicate-name cases
//     that are the whole reason we don't build slugs ourselves.

import { fantasyProsApiKey, playerPageUrl, nflSeasonPhase, normalizePlayerName } from './lib/fantasypros.mjs';

const apiKey = fantasyProsApiKey();
if (!apiKey) {
  console.error('No FANTASYPROS_API_KEY set — nothing to probe.');
  process.exit(1);
}

const season = nflSeasonPhase().season;
const params = new URLSearchParams({ position: 'ALL', type: 'DRAFT', scoring: 'PPR', week: '0' });
const url = `https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings?${params}`;

console.log(`GET ${url}`);
const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
console.log(`HTTP ${res.status}`);
const body = await res.text();
if (!res.ok) {
  console.error(body.slice(0, 500));
  process.exit(1);
}

const data = JSON.parse(body);
const players = data?.players || [];
console.log(`players: ${players.length}, last_updated: ${data?.last_updated ?? '—'}`);
if (players.length === 0) process.exit(1);

console.log('\n--- every field on the first ranked player ---');
for (const [k, v] of Object.entries(players[0])) {
  const shown = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 60) : String(v);
  console.log(`  ${k}: ${shown}`);
}

console.log('\n--- coverage of the fields playerPageUrl reads ---');
for (const field of ['player_page_url', 'player_url', 'player_filename']) {
  const present = players.filter((p) => p[field]).length;
  console.log(`  ${field}: ${present}/${players.length}`);
}
const resolved = players.filter((p) => playerPageUrl(p));
console.log(`  playerPageUrl() resolves: ${resolved.length}/${players.length}`);

console.log('\n--- what the first few resolve to ---');
for (const p of players.slice(0, 5)) {
  console.log(`  ${p.player_name} (${p.player_position_id} ${p.player_team_id}) -> ${playerPageUrl(p) ?? 'NO URL'}`);
}

// Shared names are exactly where a name-built slug goes wrong, so show what
// the response says about them — two players, two different pages, or the
// same page twice (which would mean the URL can't be trusted either).
const byName = new Map();
for (const p of players) {
  const key = normalizePlayerName(p.player_name);
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(p);
}
const shared = [...byName.values()].filter((group) => group.length > 1);
console.log(`\n--- ${shared.length} name(s) shared by more than one ranked player ---`);
for (const group of shared.slice(0, 10)) {
  for (const p of group) {
    console.log(`  ${p.player_name} (${p.player_position_id} ${p.player_team_id}) -> ${playerPageUrl(p) ?? 'NO URL'}`);
  }
  console.log('');
}
