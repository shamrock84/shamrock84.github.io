// Unit test for the header's all-leagues season record — computeSeasonRecord /
// formatRecord in myffl.html. The page's script block runs in a vm with the
// browser globals stubbed, so this is the real source, not a copy.
//
// The decisions pinned here are all "doesn't apply / couldn't tell is not a
// zero": a draftonly league has no matchups, a league still on last season
// would fold last year's record into this year's total, and a league whose
// standings weren't read must not be counted as read (the tooltip's
// "N of M leagues counted" depends on it). A 0-0 league that WAS read counts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

function fakeElement() {
	return {
		value: '', textContent: '', disabled: false, dataset: {}, style: {},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		addEventListener() {}, removeEventListener() {},
		appendChild: (child) => child, removeChild: (child) => child,
		insertBefore: (child) => child, remove() {}, focus() {}, setAttribute() {},
		querySelector: () => null, querySelectorAll: () => [], closest: () => null,
	};
}
const context = {
	console,
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setTimeout, clearTimeout, setInterval, clearInterval,
	document: {
		addEventListener() {}, getElementById: () => fakeElement(),
		createElement: () => fakeElement(), createTextNode: () => fakeElement(),
		querySelector: () => null, querySelectorAll: () => [],
		visibilityState: 'visible', body: fakeElement(),
	},
	window: { addEventListener() {} },
	fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
};
vm.createContext(context);
vm.runInContext(scriptSource, context);
const { computeSeasonRecord, formatRecord, recordIsStale } = context;

const D = (iso) => new Date(`${iso}T12:00:00Z`);
const lg = (name, type, season, me, extra = {}) => ({
	id: name, name, type, season,
	standings: me ? [{ franchiseId: '1', isMe: false, wins: 9, losses: 9, ties: 0 }, { franchiseId: '2', isMe: true, ...me }] : [],
	...extra,
});

// Sums across leagues; draftonly is skipped even if it somehow carries a record.
{
	const r = computeSeasonRecord([
		lg('A', 'dynasty', '2026', { wins: 3, losses: 0, ties: 0 }),
		lg('B', 'redraft', '2026', { wins: 1, losses: 2, ties: 1 }),
		lg('C', 'draftonly', '2026', { wins: 5, losses: 5, ties: 0 }),
	], D('2026-10-02'));
	assert.deepEqual([r.wins, r.losses, r.ties, r.counted, r.eligible], [4, 2, 1, 2, 2]);
}

// A league whose season has ended is eligible but not counted.
{
	const r = computeSeasonRecord([
		lg('A', 'dynasty', '2025', { wins: 10, losses: 3, ties: 0 }),
		lg('B', 'dynasty', '2026', { wins: 1, losses: 1, ties: 0 }),
	], D('2026-10-02'));
	assert.deepEqual([r.wins, r.losses, r.counted, r.eligible], [1, 1, 1, 2]);
}

// Unread standings: not counted, not a 0-0. A read 0-0 does count.
{
	const r = computeSeasonRecord([
		lg('A', 'dynasty', '2026', null),
		lg('B', 'dynasty', '2026', { wins: 0, losses: 0, ties: 0 }),
	], D('2026-10-02'));
	assert.deepEqual([r.wins, r.losses, r.counted, r.eligible], [0, 0, 1, 2]);
}

// Missing season data doesn't exclude (NaN < year is false), and no leagues is safe.
assert.equal(computeSeasonRecord([lg('A', 'dynasty', undefined, { wins: 1, losses: 0, ties: 0 })], D('2026-10-02')).counted, 1);
assert.equal(computeSeasonRecord(undefined, D('2026-10-02')).counted, 0);

// Ties print only when present.
assert.equal(formatRecord(16, 17, 0), '16-17');
assert.equal(formatRecord(16, 17, 1), '16-17-1');

// Offseason. The 2026 season ends the day after Super Bowl LXI (Sunday
// 2027-02-14), so records stay up through the playoffs and that Sunday, then
// go away. A rolled-over 0-0 league shows none either.
{
	const l26 = lg('A', 'dynasty', '2026', { wins: 10, losses: 3, ties: 0 });
	const l27 = lg('B', 'dynasty', '2027', { wins: 0, losses: 0, ties: 0 });
	assert.equal(recordIsStale(l26, D('2026-12-31')), false);
	assert.equal(recordIsStale(l26, D('2027-01-01')), false, 'New Year is not the end');
	assert.equal(recordIsStale(l26, D('2027-02-14')), false, 'Super Bowl Sunday still shows');
	assert.equal(recordIsStale(l26, D('2027-02-15')), true, 'the day after, gone');
	assert.equal(recordIsStale(l27, D('2027-03-01')), false, 'rolled over: not stale, hidden by 0-0');
	assert.equal(recordIsStale(lg('D', 'redraft', undefined, null), D('2030-01-01')), false);
	const off = computeSeasonRecord([l26, l27], D('2027-03-01'));
	assert.equal(off.counted, 1);
	assert.equal(off.wins + off.losses + off.ties, 0, 'only the 0-0 league remains: header hides');
	const jan = computeSeasonRecord([l26], D('2027-01-15'));
	assert.deepEqual([jan.wins, jan.losses, jan.counted], [10, 3, 1]);
}

// renderSeasonRecord returns quietly when its element is missing, so a lost
// markup edit would otherwise pass everything above.
assert.match(html, /<[a-z]+[^>]*id="season-record"/);
assert.match(html, /id="season-record-sep"/);

console.log('test-season-record: ok');
