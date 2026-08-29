#!/usr/bin/env node
// Unit tests for the validation and serialisation behind the Admin tab
// (api/save-leagues.js). Pure functions, no network and no secrets, so unlike
// the other scripts in here this runs anywhere — including in CI on every PR.
//
// Worth testing properly: this is the one write path in the project that skips
// pull requests entirely and commits straight to main. config/leagues.json
// feeds the 4-hour sync, live scoring, and lineup submission alike, so a bad
// write breaks all three at once and the only symptom is data quietly going
// stale. These functions are the only thing standing in the way.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validate, mergeLeague, serialize } from '../api/save-leagues.js';

let failures = 0;
function check(name, pass, detail = '') {
  if (pass) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// A minimal league that passes, so each case below varies exactly one thing.
const base = () => ({ id: '123', franchiseId: '0001', name: 'Test', type: 'draftonly' });
const withField = (k, v) => [{ ...base(), [k]: v }];

// ---- validate: the happy path is the real config ----
const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const real = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
check('the live config validates', validate(real.leagues).length === 0, JSON.stringify(validate(real.leagues)));

// ---- validate: rejections ----
check('rejects a non-array', validate('nope').length === 1);
check('rejects an empty list', validate([]).length === 1);
check('rejects a missing id', validate(withField('id', '')).length > 0);
check('rejects a non-text name', validate(withField('name', { oops: 1 })).length > 0);
check('rejects an unknown type', validate(withField('type', 'keeper')).length > 0);
check('rejects an unknown provider', validate(withField('provider', 'yahoo')).length > 0);
check('rejects the retired bestball type', validate(withField('type', 'bestball')).length > 0);
check('rejects an unknown ranking type', validate(withField('rankingType', 'VIBES')).length > 0);
check('rejects an unknown scoring format', validate(withField('scoring', 'TE-PREMIUM')).length > 0);
// The season pin goes straight into a provider URL path, and a bad one doesn't
// fail loudly — the league just quietly stops updating.
check('rejects a non-numeric season', validate(withField('season', 'next')).length > 0);
check('rejects a two-digit season', validate(withField('season', '27')).length > 0);
check('rejects a fractional season', validate(withField('season', '2027.5')).length > 0);
check('allows a four-digit season', validate(withField('season', '2027')).length === 0,
  JSON.stringify(validate(withField('season', '2027'))));
check('allows a blank season (follow the rollover)', validate(withField('season', '')).length === 0);
// Same range-check as season, same reasoning: a typo here doesn't fail
// loudly, it quietly hides or shows years nobody asked for.
check('rejects a non-numeric startYear', validate(withField('startYear', 'a while ago')).length > 0);
check('rejects a two-digit startYear', validate(withField('startYear', '23')).length > 0);
check('rejects a fractional startYear', validate(withField('startYear', '2023.5')).length > 0);
check('allows a four-digit startYear', validate(withField('startYear', '2023')).length === 0,
  JSON.stringify(validate(withField('startYear', '2023'))));
check('allows a blank startYear (this league\'s whole history is yours)', validate(withField('startYear', '')).length === 0);
check('rejects a non-boolean lineup flag', validate(withField('lineupPilot', 'yes')).length > 0);
check('rejects tags that are not a list', validate(withField('tags', 'Superflex')).length > 0);
check('rejects a rules link with no scheme', validate(withField('rulesUrl', 'docs.google.com/x')).length > 0);
// nickname — free text shown in the header's quick-link toolbar instead of
// the full league name.
check('rejects a non-text nickname', validate(withField('nickname', { oops: 1 })).length > 0);
check('allows a blank nickname', validate(withField('nickname', '')).length === 0);
check('allows a short nickname', validate(withField('nickname', 'MNMx')).length === 0);
// toolbarOrder — this league's position in that same toolbar, independent
// of the row's own position in the array. Only ever integers, only ever
// non-negative — same reasoning as season/startYear: a bad value here
// doesn't fail loudly, it just sorts unpredictably.
check('rejects a non-numeric toolbarOrder', validate(withField('toolbarOrder', 'first')).length > 0);
check('rejects a negative toolbarOrder', validate(withField('toolbarOrder', -1)).length > 0);
check('rejects a fractional toolbarOrder', validate(withField('toolbarOrder', 1.5)).length > 0);
check('allows a zero toolbarOrder', validate(withField('toolbarOrder', 0)).length === 0,
  JSON.stringify(validate(withField('toolbarOrder', 0))));
check('allows a blank toolbarOrder', validate(withField('toolbarOrder', '')).length === 0);
// The contract-length summary is addressed with this, and a malformed one fails
// silently: the mailto still opens, it just reaches nobody.
check('rejects a commissioner contact with no @ and no scheme', validate(withField('commishContact', 'not-an-email')).length > 0);
check('rejects a commissioner contact with no domain dot', validate(withField('commishContact', 'a@b')).length > 0);
check('rejects a commissioner contact with a space', validate(withField('commishContact', 'a b@c.com')).length > 0);
check('allows a normal commissioner email', validate(withField('commishContact', 'commish@example.com')).length === 0,
  JSON.stringify(validate(withField('commishContact', 'commish@example.com'))));
// A URL is the alternative to an email — for a commissioner who'd rather not
// be emailed for this at all.
check('allows an https commissioner contact link', validate(withField('commishContact', 'https://discord.gg/abc123')).length === 0,
  JSON.stringify(validate(withField('commishContact', 'https://discord.gg/abc123'))));
check('allows an http commissioner contact link', validate(withField('commishContact', 'http://example.com/contact')).length === 0);
check('rejects a commissioner contact link with no scheme', validate(withField('commishContact', 'discord.gg/abc123')).length > 0);
// slack:// deep links straight to a DM are a legitimate contact too — see
// slack://channel?team=TEAM_ID&id=USER_ID in the schema note.
check('allows a slack commissioner contact link', validate(withField('commishContact', 'slack://channel?team=T12345678&id=U12345678')).length === 0,
  JSON.stringify(validate(withField('commishContact', 'slack://channel?team=T12345678&id=U12345678'))));
check('allows a blank commissioner contact', validate(withField('commishContact', '')).length === 0);
// Deliberately not tied to type: switching a league away from Salary Cap and
// back must not silently discard the contact.
check('allows a commissioner contact on a non-salarycap league',
  validate([{ ...base(), type: 'redraft', commishContact: 'c@example.com' }]).length === 0);
check('rejects a non-object row', validate([null]).length > 0);
// Feeds the History tab's Finances card. Zero is a real, deliberate answer
// (a league that pays $0 for a spot) and must validate like any amount —
// only negative numbers and non-numeric text are rejected.
check('rejects negative dues', validate(withField('dues', -50)).length > 0);
check('rejects non-numeric dues', validate(withField('dues', 'fifty')).length > 0);
check('allows a blank dues field', validate(withField('dues', '')).length === 0);
check('allows a zero dues field', validate(withField('dues', 0)).length === 0,
  JSON.stringify(validate(withField('dues', 0))));
check('rejects a negative payout', validate(withField('payout2', -1)).length > 0);
check('rejects a non-numeric payout', validate(withField('payout1', 'lots')).length > 0);
check('allows a zero payout', validate(withField('payout3', 0)).length === 0);
check('allows all three payouts blank', validate([base()]).length === 0);
// Weekly/season high-score payouts are a second, independent pair — not
// tied to a finish's rank the way payout1/2/3 are — but validate the same:
// a non-negative dollar amount, or blank.
check('rejects a negative weekly-high payout', validate(withField('payoutWeeklyHigh', -1)).length > 0);
check('rejects a non-numeric season-high payout', validate(withField('payoutSeasonHigh', 'lots')).length > 0);
check('allows a zero weekly-high payout', validate(withField('payoutWeeklyHigh', 0)).length === 0);
check('allows both high-score payouts blank', validate([base()]).length === 0);
// Division winner payout — independent of Finish (best regular-season
// record, not necessarily the eventual bracket winner), same non-negative
// dollar-amount-or-blank validation as every other payout field.
check('rejects a negative division-winner payout', validate(withField('payoutDivisionWinner', -1)).length > 0);
check('rejects a non-numeric division-winner payout', validate(withField('payoutDivisionWinner', 'lots')).length > 0);
check('allows a zero division-winner payout', validate(withField('payoutDivisionWinner', 0)).length === 0);
check('allows a blank division-winner payout', validate([base()]).length === 0);
// historyLeagueIds — a manual escape hatch for a broken/missing MFL
// history.league[] chain (see fetch-rosters.mjs's
// applyHistoryLeagueIdOverrides and config/leagues.json's own _readme
// entry). No Admin tab field for it; validated here so a malformed
// hand-edit fails loudly instead of quietly corrupting a sync.
check('allows a league with no historyLeagueIds', validate([base()]).length === 0);
check('allows a valid historyLeagueIds map',
  validate(withField('historyLeagueIds', { '2010': '34034', '2015': '39564' })).length === 0,
  JSON.stringify(validate(withField('historyLeagueIds', { '2010': '34034', '2015': '39564' }))));
check('rejects a historyLeagueIds that is an array', validate(withField('historyLeagueIds', ['34034'])).length > 0);
check('rejects a historyLeagueIds that is a string', validate(withField('historyLeagueIds', 'nope')).length > 0);
check('rejects a historyLeagueIds key that is not a four-digit year',
  validate(withField('historyLeagueIds', { '15': '39564' })).length > 0);
check('rejects a historyLeagueIds value that is blank',
  validate(withField('historyLeagueIds', { '2015': '' })).length > 0);

// The whole reason the endpoint checks this: every lookup in the codebase is
// leagues.find((l) => l.id === id), so a duplicate shadows rather than errors.
const dupes = validate([base(), { ...base(), name: 'Other' }]);
check('rejects duplicate ids', dupes.length === 1 && dupes[0].includes('123'), JSON.stringify(dupes));

// ---- validate: things that must be allowed ----
// Regression: an empty team ID used to be rejected, which made it impossible to
// add a league before looking up your own franchise id inside it.
check('allows a blank team id', validate(withField('franchiseId', '')).length === 0,
  JSON.stringify(validate(withField('franchiseId', ''))));
check('allows an omitted team id', validate([{ id: '1', name: 'x', type: 'redraft' }]).length === 0);
check('allows omitted optional fields', validate([base()]).length === 0);
// The Admin tab no longer sets a name — it shows the live one from the last
// sync — so a league added there arrives with none until its first sync.
check('allows a blank name', validate(withField('name', '')).length === 0,
  JSON.stringify(validate(withField('name', ''))));
check('allows an omitted name', validate([{ id: '1', type: 'redraft' }]).length === 0,
  JSON.stringify(validate([{ id: '1', type: 'redraft' }])));
check('error messages fall back to the row number when unnamed',
  validate([{ id: '1', type: 'bogus' }])[0].includes('Row 1'));
check('error messages name the league', validate([{ ...base(), type: 'bogus' }])[0].includes('Test'));

// ---- mergeLeague ----
const merged = mergeLeague({ ...base(), franchiseId: '', tags: [], lineupPilot: false, rulesUrl: '' });
check('drops a blank team id', !('franchiseId' in merged), JSON.stringify(merged));
check('drops empty tags', !('tags' in merged));
check('drops lineupPilot when off', !('lineupPilot' in merged));
check('drops a blank rules link', !('rulesUrl' in merged));
check('drops a blank commissioner contact', !('commishContact' in mergeLeague({ ...base(), commishContact: '' })));
check('trims a commissioner contact', mergeLeague({ ...base(), commishContact: '  c@e.com ' }).commishContact === 'c@e.com');
check('drops a blank nickname', !('nickname' in mergeLeague({ ...base(), nickname: '' })));
check('trims a nickname', mergeLeague({ ...base(), nickname: '  MNMx  ' }).nickname === 'MNMx');
check('drops a blank toolbarOrder', !('toolbarOrder' in mergeLeague({ ...base(), toolbarOrder: '' })));
check('stores toolbarOrder as a number', mergeLeague({ ...base(), toolbarOrder: '3' }).toolbarOrder === 3,
  JSON.stringify(mergeLeague({ ...base(), toolbarOrder: '3' })));
// Zero is a real, meaningful position (first in the toolbar), not an unset
// value — must survive the same way a zero dues/payout does.
check('keeps a zero toolbarOrder rather than dropping it',
  mergeLeague({ ...base(), toolbarOrder: 0 }).toolbarOrder === 0,
  JSON.stringify(mergeLeague({ ...base(), toolbarOrder: 0 })));
check('drops a blank season', !('season' in mergeLeague({ ...base(), season: '' })));
check('keeps a season pin as a string', mergeLeague({ ...base(), season: 2027 }).season === '2027');
check('drops a blank startYear', !('startYear' in mergeLeague({ ...base(), startYear: '' })));
check('keeps a startYear as a string', mergeLeague({ ...base(), startYear: 2023 }).startYear === '2023');
check('keeps the required fields', merged.id === '123' && merged.name === 'Test' && merged.type === 'draftonly');
// Retired keys are stripped rather than carried through by the unknown-field
// passthrough — otherwise a removed field would live in the config forever.
check('strips the retired format key',
  !('format' in mergeLeague({ ...base(), format: 'auction' })),
  JSON.stringify(mergeLeague({ ...base(), format: 'auction' })));
check('strips the retired commishEmail key',
  !('commishEmail' in mergeLeague({ ...base(), commishEmail: 'c@example.com' })),
  JSON.stringify(mergeLeague({ ...base(), commishEmail: 'c@example.com' })));
check('still preserves genuinely unknown keys alongside retired ones',
  mergeLeague({ ...base(), format: 'auction', somethingNew: 1 }).somethingNew === 1);
check('drops a blank name', !('name' in mergeLeague({ id: '1', type: 'redraft', name: '' })));
// Regression: String(undefined) is the string "undefined", which would have
// written a league literally named undefined into the config.
check('drops an omitted name rather than stringifying it',
  !('name' in mergeLeague({ id: '1', type: 'redraft' })),
  JSON.stringify(mergeLeague({ id: '1', type: 'redraft' })));
check('trims whitespace', mergeLeague({ ...base(), name: '  Padded  ' }).name === 'Padded');
check('keeps lineupPilot when on', mergeLeague({ ...base(), lineupPilot: true }).lineupPilot === true);
check('key order is stable', Object.keys(mergeLeague(base())).join() === 'id,franchiseId,name,type');
// Stored as real JSON numbers, not quoted strings like season — these feed
// arithmetic (won - dues) rather than being compared as an identifier.
check('stores dues as a number', mergeLeague({ ...base(), dues: '100' }).dues === 100,
  JSON.stringify(mergeLeague({ ...base(), dues: '100' })));
check('stores a payout as a number', mergeLeague({ ...base(), payout1: '500' }).payout1 === 500);
check('stores a weekly-high payout as a number', mergeLeague({ ...base(), payoutWeeklyHigh: '25' }).payoutWeeklyHigh === 25);
check('drops a blank season-high payout', !('payoutSeasonHigh' in mergeLeague({ ...base(), payoutSeasonHigh: '' })));
check('stores a division-winner payout as a number', mergeLeague({ ...base(), payoutDivisionWinner: '75' }).payoutDivisionWinner === 75);
check('drops a blank division-winner payout', !('payoutDivisionWinner' in mergeLeague({ ...base(), payoutDivisionWinner: '' })));
check('drops a blank dues field', !('dues' in mergeLeague({ ...base(), dues: '' })));
check('drops blank payout fields', !('payout1' in mergeLeague({ ...base(), payout1: '' })));
// Zero is a real, deliberate answer and must survive — not be dropped the
// way put()'s empty-string/null/undefined check drops a genuinely blank field.
check('keeps a zero dues value rather than dropping it',
  mergeLeague({ ...base(), dues: 0 }).dues === 0,
  JSON.stringify(mergeLeague({ ...base(), dues: 0 })));
check('keeps a zero payout value rather than dropping it',
  mergeLeague({ ...base(), payout3: 0 }).payout3 === 0);

// The Admin tab only renders the fields it knows about. Without this, any field
// added to the config later would be wiped the first time someone pressed Save.
const preserved = mergeLeague({ ...base(), someFutureField: { nested: true } });
check('preserves unknown fields', JSON.stringify(preserved.someFutureField) === '{"nested":true}', JSON.stringify(preserved));

// ---- serialize ----
const out = serialize(real._readme, real.leagues.map(mergeLeague));
const reparsed = JSON.parse(out);
check('output is valid JSON', Array.isArray(reparsed.leagues));
check('round-trips every league', reparsed.leagues.length === real.leagues.length);
check('preserves the _readme notes', JSON.stringify(reparsed._readme) === JSON.stringify(real._readme));
check('round-trip is lossless', JSON.stringify(reparsed.leagues) === JSON.stringify(real.leagues.map(mergeLeague)));
// One line per league keeps a one-league edit to a one-line diff, which is what
// makes an Admin-tab commit reviewable at a glance in the repo history.
const leagueLines = out.split('\n').filter((l) => l.trim().startsWith('{ "id"'));
check('one line per league', leagueLines.length === real.leagues.length, `got ${leagueLines.length}`);
check('ends with a newline', out.endsWith('\n'));

// The property that makes Admin-tab commits readable: saving without editing
// anything rewrites the file byte-for-byte identically, so the only diff a real
// save produces is the change itself rather than whole-file whitespace churn.
const onDisk = await readFile(CONFIG_PATH, 'utf8');
check('an unedited save is a byte-for-byte no-op', out === onDisk,
  out === onDisk ? '' : 'serialize() no longer matches the file\'s hand-written spacing');
check('array spacing matches the existing style', serialize(undefined, [{ tags: ['a', 'b'] }]).includes('["a", "b"]'));
check('handles a config with no _readme', JSON.parse(serialize(undefined, [mergeLeague(base())])).leagues.length === 1);

console.log(failures === 0 ? '\nAll save-leagues checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
