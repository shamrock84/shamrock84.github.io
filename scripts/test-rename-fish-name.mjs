// Pins the pure part of scripts/rename-fish-name.mjs: what a rename touches and
// what it must leave alone. What can drift silently: a substring match turning
// "Gary" into part of another name, a fisherman listed twice after a rename, or
// the input list being mutated.
//
// Run: node scripts/test-rename-fish-name.mjs

import assert from 'node:assert/strict';
import { renameInTrips } from './rename-fish-name.mjs';
import { validateTrips } from '../api/_lib/fishtrips.mjs';

const day = (o = {}) => ({ first: '', biggest: '', biggestInches: null, ...o });
const trip = (id, year, anglers, days) => ({ id, year, date: null, location: '', days, anglers: anglers.map((name) => ({ name, days: days.map(() => ({ caught: 1, kept: 1 })) })) });

const trips = [
  trip('a', 2025, ['Braden', 'Grandpa'], [day({ first: 'Grandpa', biggest: 'Braden' }), day({ biggest: ' grandpa ' })]),
  trip('b', 2024, ['Jason', 'Grandpa Joe'], [day({ first: 'Grandpa Joe' })]), // a different name that merely contains it
  trip('c', 2023, ['Jason'], [day({ biggest: 'Grandpa' })]), // credited but not a row on that trip
];
const before = JSON.stringify(trips);
const { trips: next, changes, conflicts } = renameInTrips(trips, 'Grandpa', 'Gary');

assert.equal(JSON.stringify(trips), before, 'the input is not mutated');
assert.deepEqual(changes, { anglers: 1, first: 1, biggest: 2 });
assert.deepEqual(conflicts, []);
assert.deepEqual(next[0].anglers.map((a) => a.name), ['Braden', 'Gary']);
assert.equal(next[0].days[0].first, 'Gary');
assert.equal(next[0].days[1].biggest, 'Gary', 'matches ignoring case and spacing');
assert.equal(next[0].days[0].biggest, 'Braden', 'other names are left alone');
assert.deepEqual(next[1].anglers.map((a) => a.name), ['Jason', 'Grandpa Joe'], 'a longer name containing it is not touched');
assert.equal(next[1].days[0].first, 'Grandpa Joe');
assert.equal(next[2].days[0].biggest, 'Gary', 'a credit on a trip where he is not a row is renamed too');
assert.deepEqual(validateTrips({ trips: next }).errors, [], 'the result still validates');

// Renaming onto a name already on the trip would list him twice: reported as a conflict.
const clash = renameInTrips([trip('x', 2022, ['Grandpa', 'Gary'], [day()])], 'Grandpa', 'Gary');
assert.deepEqual(clash.conflicts, ['2022']);

// Nothing to do is a no-op.
assert.deepEqual(renameInTrips(trips, 'Nobody', 'Someone').changes, { anglers: 0, first: 0, biggest: 0 });

console.log('rename-fish-name ok');
