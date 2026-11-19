// Pins the pure parts of scripts/sync-dev-quicklinks.mjs: reading myFFL's Dev
// group out of config/leagues.json, comparing, and rewriting only that group.
// What can drift silently: another page's own links being dropped or reordered
// by a sync, a second Dev group left behind, or the League Links placeholder
// (no url) being copied as a link.
//
// Run: node scripts/test-sync-dev-quicklinks.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { devLinksFrom, sameDev, withDevGroup, SITES } from './sync-dev-quicklinks.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config/leagues.json', import.meta.url), 'utf8'));
const dev = devLinksFrom(config.quickLinks);

assert.ok(dev.length >= 1, 'config has a Dev group');
assert.ok(dev.every((l) => l.group === 'Dev' && l.url && l.nickname), 'every Dev entry is a complete link in the Dev group');
assert.deepEqual(devLinksFrom([{ type: 'leagues' }, { url: 'https://a.example', nickname: 'A', group: ' dev ' }]).map((l) => l.nickname), ['A'], 'group match ignores case and spaces');

const mine = [
  { url: 'https://x.example', nickname: 'X', style: 'gold' },
  { url: 'https://old.example', nickname: 'Old', group: 'Dev' },
  { url: 'https://y.example', nickname: 'Y', group: 'Other' },
];
const next = withDevGroup(mine, dev);
assert.deepEqual(next.filter((l) => l.group !== 'Dev'), [mine[0], mine[2]], 'other links are kept, in order');
assert.equal(next.findIndex((l) => l.group === 'Dev'), 1, 'the group goes where the old one was');
assert.ok(!next.some((l) => l.nickname === 'Old'), 'the old Dev entry is gone');
assert.equal(next.filter((l) => l.group === 'Dev').length, dev.length);
assert.ok(sameDev(next, dev) && !sameDev(mine, dev));

assert.deepEqual(withDevGroup([], dev), dev, 'an empty list just gets the group');
assert.deepEqual(withDevGroup([mine[0]], dev), [mine[0], ...dev], 'no old group: appended at the end');
assert.deepEqual(withDevGroup(next, dev), next, 'applying twice changes nothing');

assert.deepEqual(Object.keys(SITES).sort(), ['bangers', 'fam', 'fish', 'vikings']);
assert.equal(SITES.fish.resource, 'fishquicklinks');
assert.equal(SITES.fam.resource, 'quicklinks');

console.log('sync-dev-quicklinks ok');
