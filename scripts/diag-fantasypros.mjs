#!/usr/bin/env node
// One-off diagnostic: FantasyPros' interactive docs pages are blocked by bot
// protection from this environment's fetch tools, so this hits the real API
// directly (with the actual key) to learn the real endpoint shape empirically
// — including trying a request with no query params first, since a helpful
// 4xx error often names the required/valid params. Read-only. Delete this
// script and its workflow once the real shape is confirmed and wired in.

const API_KEY = process.env.FANTASYPROS_API_KEY;
const BASE = 'https://api.fantasypros.com/public/v2/json';

async function tryRequest(label, path) {
  console.log(`\n=== ${label} ===`);
  console.log(`GET ${path}`);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': API_KEY } });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Body (first 2000 chars):\n${text.slice(0, 2000)}`);
  } catch (err) {
    console.log(`Request failed: ${err.message}`);
  }
}

async function main() {
  if (!API_KEY) throw new Error('FANTASYPROS_API_KEY environment variable is required.');

  await tryRequest('No query params', '/nfl/2026/consensus-rankings');
  await tryRequest('type=ros&position=qb', '/nfl/2026/consensus-rankings?type=ros&position=QB');
  await tryRequest('type=draft&position=qb&scoring=PPR', '/nfl/2026/consensus-rankings?type=draft&position=QB&scoring=PPR');
  await tryRequest('type=dynasty&position=qb', '/nfl/2026/consensus-rankings?type=dynasty&position=QB');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
