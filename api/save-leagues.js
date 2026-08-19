// Vercel serverless function: writes config/leagues.json back to the repo on
// behalf of the Admin tab in myffl.html, so leagues can be added, edited, and
// removed from the page instead of by hand-editing the file.
//
// Requires a valid Bearer token from api/login.js — same stateless token the
// lineup editor uses, so the shared site password is only ever typed once.
//
// Needs GITHUB_CONTENTS_TOKEN (a fine-grained PAT scoped to this repo with
// Contents: Read and write) as a Vercel project environment variable. That is
// deliberately NOT the same token as trigger-sync.js's GITHUB_DISPATCH_TOKEN:
// trigger-sync is a public unauthenticated endpoint, and it should stay unable
// to rewrite repository files no matter what.
//
// Everything here is validated server-side before a single byte is committed.
// This path skips pull requests entirely, so the syntax-check workflow never
// sees it — and config/leagues.json feeds the 4-hour sync, live-scoring, and
// submit-lineup alike. A malformed write would break all three at once, with
// the only symptom being data quietly going stale.

import { verifyToken } from './lib/auth.mjs';
import { applyCors } from './lib/cors.mjs';

const OWNER = 'shamrock84';
const REPO = 'shamrock84.github.io';
const PATH = 'config/leagues.json';
const BRANCH = 'main';

const LEAGUE_TYPES = new Set(['dynasty', 'salarycap', 'draftonly', 'redraft']);
const PROVIDERS = new Set(['mfl', 'espn', 'sleeper']);

// Retired fields. Anything listed here is stripped on save rather than being
// carried through by mergeLeague's unknown-key passthrough, which is what keeps
// a removed field from living forever in the config.
//   format — 'auction' always agreed with type 'salarycap', which now drives
//            the salary/contract UI on its own; 'dynasty' was never read.
//   commishEmail — renamed to commishContact, which accepts a URL as well as
//                  an email address (for a commissioner who'd rather not be
//                  emailed at all).
const RETIRED_KEYS = new Set(['format', 'commishEmail']);
const RANKING_TYPES = new Set(['DYNASTY', 'DRAFT', 'ROS', 'WEEKLY', 'ADP']);
const SCORING_FORMATS = new Set(['PPR', 'HALF', 'STD']);

// Written back in this order so a change to one league shows up as a one-line
// diff rather than a reshuffle. Anything not listed here is preserved and
// appended after — see mergeLeague below for why that matters.
const KEY_ORDER = [
  'id', 'franchiseId', 'name', 'type', 'provider',
  'tags', 'lineupPilot', 'rankingType', 'scoring', 'season', 'rulesUrl', 'commishContact',
];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Exported for the unit test in scripts/test-save-leagues.mjs. Vercel only ever
// invokes the default export, so extra named exports cost nothing at runtime.
export { validate, mergeLeague, serialize };

// Returns an array of human-readable problems — empty means valid. Phrased for
// someone reading them in a browser, not a stack trace.
function validate(leagues) {
  const errors = [];
  if (!Array.isArray(leagues)) return ['Expected a list of leagues.'];
  if (leagues.length === 0) return ['At least one league is required.'];

  leagues.forEach((league, i) => {
    const where = `Row ${i + 1}`;
    if (!league || typeof league !== 'object' || Array.isArray(league)) {
      errors.push(`${where}: not a league entry.`);
      return;
    }
    const label = isNonEmptyString(league.name) ? `${where} (${league.name.trim()})` : where;

    if (!isNonEmptyString(league.id)) errors.push(`${label}: league ID is required.`);
    // Optional. The Admin tab stopped setting it once the name shown there
    // came from the live sync instead, and it was only ever a fallback for
    // when the provider can't be reached. Still has to be text if present,
    // so a hand-edited config can't put an object here.
    if (league.name != null && typeof league.name !== 'string') {
      errors.push(`${label}: name must be text.`);
    }
    if (!LEAGUE_TYPES.has(league.type)) {
      errors.push(`${label}: type must be one of ${[...LEAGUE_TYPES].join(', ')}.`);
    }
    // franchiseId may be blank or absent — fetch-rosters.mjs treats that as
    // "not configured yet" and renders the league with an explanatory error
    // rather than failing. That's a legitimate half-set-up state: you often add
    // a league before you've looked up your own team ID within it, so an empty
    // string has to pass here, not just an omitted key.
    if (league.franchiseId != null && typeof league.franchiseId !== 'string') {
      errors.push(`${label}: team ID must be text, or left blank.`);
    }
    if (league.provider != null && !PROVIDERS.has(league.provider)) {
      errors.push(`${label}: provider must be one of ${[...PROVIDERS].join(', ')}, or left blank for MFL.`);
    }
    if (league.rankingType != null && !RANKING_TYPES.has(league.rankingType)) {
      errors.push(`${label}: rankings must be one of ${[...RANKING_TYPES].join(', ')}, or left blank.`);
    }
    if (league.scoring != null && !SCORING_FORMATS.has(league.scoring)) {
      errors.push(`${label}: scoring must be one of ${[...SCORING_FORMATS].join(', ')}, or left blank.`);
    }
    // Pins the league to one season instead of letting the sync follow its
    // rollover. Range-checked rather than free-form: this value goes straight
    // into a provider URL path, and a typo here doesn't fail loudly — it just
    // makes the league quietly stop updating.
    if (league.season != null && league.season !== '') {
      const year = Number(league.season);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        errors.push(`${label}: season must be a four-digit year, or left blank to follow the league's own rollover.`);
      }
    }
    if (league.lineupPilot != null && typeof league.lineupPilot !== 'boolean') {
      errors.push(`${label}: lineup editor setting must be on or off.`);
    }
    if (league.tags != null) {
      if (!Array.isArray(league.tags) || !league.tags.every(isNonEmptyString)) {
        errors.push(`${label}: tags must be a list of words.`);
      }
    }
    // Only salary-cap leagues use this (it's who/where the contract-length
    // summary is sent), but the check is on shape rather than on type: a
    // league that changes type shouldn't have its contact silently discarded,
    // and the Admin tab already hides the field where it doesn't apply.
    // Either an email address (mailto:, pre-filled with the plan) or a link
    // (opened as-is) is valid — a URL is how a commissioner who doesn't want
    // to be emailed for this can still be reached. slack:// is accepted
    // alongside http(s):// for exactly that case — a deep link straight to
    // a DM (slack://channel?team=TEAM_ID&id=USER_ID), which Slack's own docs
    // confirm is the real scheme; there is no separate slack://user form.
    if (league.commishContact != null && league.commishContact !== '') {
      const contact = isNonEmptyString(league.commishContact) ? league.commishContact.trim() : '';
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
      const looksLikeUrl = /^(https?|slack):\/\//i.test(contact);
      if (!contact || !(looksLikeEmail || looksLikeUrl)) {
        errors.push(`${label}: commissioner contact must be an email address or a link starting with http://, https://, or slack://.`);
      }
    }
    if (league.rulesUrl != null && league.rulesUrl !== '') {
      if (!isNonEmptyString(league.rulesUrl) || !/^https?:\/\//i.test(league.rulesUrl)) {
        errors.push(`${label}: rules link must start with http:// or https://.`);
      }
    }
  });

  // Every lookup in this codebase is leagues.find((l) => l.id === id), so a
  // duplicate id doesn't error anywhere — it silently shadows the later league.
  const ids = leagues.filter((l) => l && isNonEmptyString(l.id)).map((l) => l.id.trim());
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) errors.push(`Duplicate league ID(s): ${dupes.join(', ')}. Each league needs its own.`);

  return errors;
}

// Drops blank optional fields, trims strings, and — importantly — carries
// through any key this endpoint doesn't know about. The Admin tab only renders
// the fields in KEY_ORDER, so without this a field added to the config later
// would be silently erased the first time someone pressed Save.
//
// out is prototype-less rather than a plain {}: the unknown-key passthrough
// below assigns with out[k] = v where k comes straight from the request body,
// and on a normal object a key of "__proto__" wouldn't create an own property
// at all — it would hit Object.prototype's setter and repoint out's
// prototype. Object.create(null) has no such setter, so that key lands as an
// ordinary own property like any other, which is what serialize/formatLeague
// (both plain Object.entries/JSON.stringify calls) already expect.
function mergeLeague(league) {
  const out = Object.create(null);
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') out[k] = v; };

  put('id', String(league.id).trim());
  put('franchiseId', league.franchiseId == null ? '' : String(league.franchiseId).trim());
  put('name', league.name == null ? '' : String(league.name).trim());
  put('type', league.type);
  put('provider', league.provider);
  if (Array.isArray(league.tags) && league.tags.length) out.tags = league.tags.map((t) => t.trim());
  if (league.lineupPilot === true) out.lineupPilot = true;
  put('rankingType', league.rankingType);
  put('scoring', league.scoring);
  put('season', league.season == null ? '' : String(league.season).trim());
  put('rulesUrl', league.rulesUrl);
  put('commishContact', league.commishContact == null ? '' : String(league.commishContact).trim());

  for (const [k, v] of Object.entries(league)) {
    if (!KEY_ORDER.includes(k) && !RETIRED_KEYS.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

// Matches the file's existing hand-written spacing exactly — `{ "a": 1, "b": 2 }`
// and `["x", "y"]`, not JSON.stringify's compact form. Without this, the first
// save would reformat all 18 lines and bury the one real change in whitespace
// churn; with it, saving an unchanged config is a genuine no-op.
function formatValue(value) {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  return JSON.stringify(value);
}

function formatLeague(league) {
  const pairs = Object.entries(league).map(([k, v]) => `${JSON.stringify(k)}: ${formatValue(v)}`);
  return `{ ${pairs.join(', ')} }`;
}

// Hand-rolled rather than JSON.stringify(obj, null, 2) so each league stays on
// one line, matching how the file is already written. That keeps a one-league
// edit to a one-line diff, which is the difference between being able to eyeball
// what the Admin tab did and having to read a 200-line reshuffle.
function serialize(readme, leagues) {
  const lines = ['{'];
  if (readme !== undefined) {
    lines.push('  "_readme": [');
    const entries = Array.isArray(readme) ? readme : [readme];
    entries.forEach((entry, i) => {
      lines.push(`    ${JSON.stringify(entry)}${i === entries.length - 1 ? '' : ','}`);
    });
    lines.push('  ],');
  }
  lines.push('  "leagues": [');
  leagues.forEach((league, i) => {
    lines.push(`    ${formatLeague(league)}${i === leagues.length - 1 ? '' : ','}`);
  });
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n') + '\n';
}

async function githubGet(token) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Couldn't read the current config (GitHub returned ${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return {
    sha: json.sha,
    parsed: JSON.parse(Buffer.from(json.content, 'base64').toString('utf8')),
  };
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, Authorization' })) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    res.status(500).json({ error: 'SESSION_SECRET is not configured on this deployment.' });
    return;
  }
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!verifyToken(bearer, sessionSecret)) {
    res.status(401).json({ error: 'Log in again — your session has expired or is invalid.' });
    return;
  }

  const token = process.env.GITHUB_CONTENTS_TOKEN;
  if (!token) {
    res.status(500).json({
      error: 'GITHUB_CONTENTS_TOKEN is not configured on this deployment. Add a fine-grained token with Contents: Read and write in the Vercel project settings.',
    });
    return;
  }

  const { leagues } = req.body || {};
  const errors = validate(leagues);
  if (errors.length) {
    res.status(400).json({ error: 'Nothing was saved — please fix these first:', details: errors });
    return;
  }

  try {
    // Re-read immediately before writing: the sha doubles as the concurrency
    // check, and _readme is taken from the file rather than the browser so the
    // schema notes can never be edited or dropped from the Admin tab.
    const { sha, parsed } = await githubGet(token);
    const content = serialize(parsed._readme, leagues.map(mergeLeague));

    const putRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Update league config (${leagues.length} leagues) from the Admin tab`,
          content: Buffer.from(content, 'utf8').toString('base64'),
          sha,
          branch: BRANCH,
        }),
      }
    );

    if (putRes.status === 409) {
      res.status(409).json({
        error: 'The config changed while you were editing. Reload the page and make your change again.',
      });
      return;
    }
    if (!putRes.ok) {
      const body = await putRes.text();
      throw new Error(`GitHub returned ${putRes.status}: ${body.slice(0, 300)}`);
    }

    const saved = await putRes.json();
    res.status(200).json({ ok: true, count: leagues.length, commit: saved.commit?.sha || null });
  } catch (err) {
    res.status(502).json({ error: `Failed to save: ${err.message}` });
  }
}
