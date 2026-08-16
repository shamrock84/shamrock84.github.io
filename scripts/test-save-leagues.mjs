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
check('rejects a non-boolean lineup flag', validate(withField('lineupPilot', 'yes')).length > 0);
check('rejects tags that are not a list', validate(withField('tags', 'Superflex')).length > 0);
check('rejects a rules link with no scheme', validate(withField('rulesUrl', 'docs.google.com/x')).length > 0);
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
check('allows a blank commissioner contact', validate(withField('commishContact', '')).length === 0);
// Deliberately not tied to type: switching a league away from Salary Cap and
// back must not silently discard the contact.
check('allows a commissioner contact on a non-salarycap league',
  validate([{ ...base(), type: 'redraft', commishContact: 'c@example.com' }]).length === 0);
check('rejects a non-object row', validate([null]).length > 0);

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
check('drops a blank season', !('season' in mergeLeague({ ...base(), season: '' })));
check('keeps a season pin as a string', mergeLeague({ ...base(), season: 2027 }).season === '2027');
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
