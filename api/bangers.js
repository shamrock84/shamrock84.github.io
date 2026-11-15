// Vercel serverless function: writes data/bangers.json back to the repo on
// behalf of the Admin tab in bangers.html (melbostads.com/bangers), the way
// api/save-leagues.js does for config/leagues.json. The Hoot Owl Bangers list
// is a committed file, not a database: the page READS it from GitHub Pages
// like any other static file (so the list has no GET here, and nothing is
// public or private about it), and this endpoint is only how an edit gets in.
//
//   data/bangers.json
//   { years: [ { id, label, nominees: [ { id, title, artist, by, link?, winner } ] } ] }
//
// `link` is optional (usually an Apple Music URL for the song): http(s) only,
// because the page renders it as an href, and left out of the file when blank.
//
// Array order is display order, newest first. `label` is free text ("2023",
// "2020 (Spring)", "Grandfathered"), not a number, because the list has years
// that aren't one. A year may have several winners: "Grandfathered" is one
// group of four.
//
// POST needs the same Bearer token as every other write (api/_lib/auth.mjs)
// and GITHUB_CONTENTS_TOKEN, the same fine-grained PAT save-leagues.js uses
// (Contents: Read and write), as a Vercel environment variable.
//
// The commit goes straight to main, skipping pull requests, so the validation
// below is the only guardrail on what the page will render. scripts/
// test-bangers.mjs also validates the committed file, so a hand edit that
// breaks it fails CI. The push also starts deploy-pages.yml, so the public
// page picks the change up a minute or two after the save returns.
//
// TASKS and QUICK LINKS. The Admin tab's Tasks card and Quick Links card (the
// header toolbar) are the same two features as vikings.html's, and are NOT
// committed to the repo: they change constantly and tasks are private, so
// they live in the Upstash store (resolveStore in plans.js) under their own
// keys, apart from the Vikings page's and myFFL's. They go through
// `?resource=tasks` / `?resource=quicklinks`, and the validators, per-task
// patch and link normalisation are vikings.js's own, imported so the pages
// can never disagree about a task or a link. Same access rules as there:
// the quick-links GET is public (logged-out visitors see the toolbar), the
// tasks GET needs the Bearer token, and every POST does. The bangers list
// itself still has no GET: the page reads data/bangers.json from Pages.
//
// VOTING. Also in the Upstash store: one hash per year, `bangers:votes:<yearId>`,
// field = the voter's name lowercased with whitespace collapsed (voterKey),
// value = { name, nomineeId, at }. A hash, not one JSON document, because a
// vote is written with HSETNX: atomic, so a name can't vote twice in a year
// even from two requests at once, and two voters never overwrite each other.
//   GET  ?resource=state              public: each year's phase
//   POST resource=state {phases}      login-gated: set the phases
//   GET  ?resource=tally&years=a,b    public: vote COUNTS per nominee (no names),
//                                     for the "X Votes" line on the plaques
//   GET  ?resource=votes&years=a,b    login-gated: every ballot for those years
//   POST resource=vote                public, but needs BANGERS_VOTE_PASSWORD
//        {name, password, yearId, nomineeId}
//   POST resource=ballot              login-gated: Admin edits a ballot
//        {yearId, name, nomineeId, action: 'set'|'delete'}
//   POST resource=nominate            public, same password as voting:
//        {name, password, yearId, title, artist}
// PHASES. Each year is in one of four, kept in `bangers:year-states` as
// { phases: { yearId: 'pending' | 'nominating' | 'voting' } }; a year with no
// entry is Complete (the default for every historical year):
//   pending     takes nothing; the page shows the year on the Admin tab only. A
//               year the Admin save adds to the file (an id not in the file
//               being replaced) is set Pending in that same request, before the
//               commit, so it is never public even for a moment
//   nominating  the Nominate tab takes nominations; the page hides the year's
//               nominees from the Winners, Nominees and Stats views
//   voting      the Vote tab takes votes; nominations are refused
//   complete    neither
// Both public writes check the phase here, not in the page. The hiding is
// cosmetic: nominations are committed to data/bangers.json (below), which is
// public, so anyone reading the file can see them.
// The doc replaced two lists (`bangers:voting`, `bangers:nominating`); until the
// first save under the new key those are read as a fallback (readPhases).
//
// A nomination is added to data/bangers.json as an ordinary nominee (by = the
// name typed, winner false) and committed to main, so it appears in Admin's Years
// card to edit or tick as winner. The commit is a read-modify-write on the
// file's sha, retried when an Admin save or another nomination lands first. One
// nomination per person per year (isOwnNomination against each nominee's `by`),
// one per song, and MAX_NOMINEES per year.
//
// Nobody may vote for their own nomination (isOwnNomination): the voter's name
// is matched against the nominee's `by`. Best effort by nature, since names are
// typed freely. Admin's ballot edit is an override and skips that check, and
// skips "is the year open", but still needs a real year and nominee.
// The vote checks the year and nominee against data/bangers.json on main (read
// with GITHUB_CONTENTS_TOKEN), not against what the caller claims. Wrong
// passwords are counted per IP like login.js, and that check fails open.
// Names are honour-system: "Bob" and "Robert" are two voters.
//
// A save from a stale copy is refused: the page sends the git blob sha of the
// exact bytes it loaded (`baseSha`, computed the way myffl.html's gitBlobSha
// does) and a mismatch is a 409. A missing sha is never stale.

import { verifyToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { storeGet, storeSet, storeCounts, storeBump, storeRelease, storeHashSetNew, storeHashGetAll, storeHashSet, storeHashDelete } from './_lib/store.mjs';
import { resolveStore } from './plans.js';
import { validateTaskPatch, applyTaskPatch, validateQuickLinks, normalizeQuickLinks } from './vikings.js';

const OWNER = 'shamrock84';
const REPO = 'shamrock84.github.io';
const PATH = 'data/bangers.json';
const BRANCH = 'main';
// Upstash keys. Deliberately not vikings.js's (`vikings:tasks`, `vikings:quicklinks`):
// sharing one would show each page the other's tasks and toolbar.
const TASKS_KEY = 'bangers:tasks';
const QUICKLINKS_KEY = 'bangers:quicklinks';
// Legacy open lists, read only until the first save of STATE_KEY.
const VOTING_KEY = 'bangers:voting';
const STATE_KEY = 'bangers:year-states';
const PHASES = ['pending', 'nominating', 'voting'];
const votesKey = (yearId) => `bangers:votes:${yearId}`;
const NOMINATING_KEY = 'bangers:nominating';
const MAX_OPEN_YEARS = 20;
const MAX_VOTER_NAME = 40;
const VOTE_IP_MAX_FAILURES = 10;
const VOTE_IP_WINDOW_SECONDS = 15 * 60;
const MAX_TASKS = 300;
const ID = /^[A-Za-z0-9]{1,40}$/;
const MAX_YEARS = 100;
const MAX_NOMINEES = 40;
const MAX_LABEL_LENGTH = 40;
const MAX_TITLE_LENGTH = 120;
const MAX_ARTIST_LENGTH = 120;
const MAX_BY_LENGTH = 60;
const MAX_LINK_LENGTH = 500;

// An absolute http(s) URL. Anything else (javascript:, data:, a bare word) is
// refused, since the page puts it in an href.
function isWebUrl(s) {
  if (/\s/.test(s)) return false;
  try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; }
}

export { validateBangers, normalizeBangers, serialize, isStaleBase, TASKS_KEY, QUICKLINKS_KEY, voterKey, cleanVoterName, validateVote, isOwnNomination, validateBallotEdit, validateNomination, validatePhases, readPhases, VOTING_KEY, NOMINATING_KEY, STATE_KEY, votesKey };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// { years: [...] } — returns { errors }, empty meaning valid. Messages name
// the year by position so the Admin tab can show them as written.
function validateBangers(body) {
  if (!isObject(body)) return { errors: ['body must be an object'] };
  const years = body.years;
  if (!Array.isArray(years)) return { errors: ['years must be a list'] };
  if (years.length > MAX_YEARS) return { errors: [`years has more than ${MAX_YEARS} entries`] };
  const errors = [];
  const seenYears = new Set();
  const seenNominees = new Set();
  years.forEach((year, i) => {
    const where = `Year ${i + 1}`;
    if (!isObject(year)) { errors.push(`${where}: not a valid entry.`); return; }
    if (typeof year.id !== 'string' || !ID.test(year.id)) errors.push(`${where}: id must be letters and digits.`);
    else if (seenYears.has(year.id)) errors.push(`${where}: id is used twice.`);
    else seenYears.add(year.id);
    const label = text(year.label);
    if (!label) errors.push(`${where}: a name is required.`);
    else if (label.length > MAX_LABEL_LENGTH) errors.push(`${where}: name is longer than ${MAX_LABEL_LENGTH} characters.`);
    const name = label ? `"${label}"` : where;
    if (!Array.isArray(year.nominees)) { errors.push(`${name}: nominees must be a list.`); return; }
    if (year.nominees.length > MAX_NOMINEES) { errors.push(`${name}: more than ${MAX_NOMINEES} nominees.`); return; }
    year.nominees.forEach((n, j) => {
      const nw = `${name}, nominee ${j + 1}`;
      if (!isObject(n)) { errors.push(`${nw}: not a valid entry.`); return; }
      if (typeof n.id !== 'string' || !ID.test(n.id)) errors.push(`${nw}: id must be letters and digits.`);
      else if (seenNominees.has(n.id)) errors.push(`${nw}: id is used twice.`);
      else seenNominees.add(n.id);
      const title = text(n.title);
      if (!title) errors.push(`${nw}: a song title is required.`);
      else if (title.length > MAX_TITLE_LENGTH) errors.push(`${nw}: title is longer than ${MAX_TITLE_LENGTH} characters.`);
      for (const [field, max] of [['artist', MAX_ARTIST_LENGTH], ['by', MAX_BY_LENGTH]]) {
        if (n[field] != null && (typeof n[field] !== 'string' || n[field].trim().length > max)) errors.push(`${nw}: ${field} must be text up to ${max} characters.`);
      }
      if (n.link != null) {
        const link = typeof n.link === 'string' ? n.link.trim() : null;
        if (link === null || link.length > MAX_LINK_LENGTH) errors.push(`${nw}: link must be text up to ${MAX_LINK_LENGTH} characters.`);
        else if (link && !isWebUrl(link)) errors.push(`${nw}: link must be a web address starting with http:// or https://.`);
      }
      if (n.winner != null && typeof n.winner !== 'boolean') errors.push(`${nw}: winner must be true or false.`);
    });
  });
  return { errors };
}

// Pure: the stored shape. Trims, drops anything unknown, and gives every
// field a value so the page never has to guess what's missing.
function normalizeBangers(years) {
  return (years || []).map((y) => ({
    id: y.id,
    label: text(y.label),
    nominees: y.nominees.map((n) => ({
      id: n.id,
      title: text(n.title),
      artist: text(n.artist),
      by: text(n.by),
      ...(text(n.link) ? { link: text(n.link) } : {}),
      winner: n.winner === true,
    })),
  }));
}

// One nominee per line, so adding a song or ticking a winner is a one-line
// diff in the commit. Ids and field order are fixed by normalizeBangers.
function serialize(years) {
  const lines = ['{', '  "years": ['];
  years.forEach((y, i) => {
    lines.push('    {');
    lines.push(`      "id": ${JSON.stringify(y.id)},`);
    lines.push(`      "label": ${JSON.stringify(y.label)},`);
    if (!y.nominees.length) {
      lines.push('      "nominees": []');
    } else {
      lines.push('      "nominees": [');
      y.nominees.forEach((n, j) => lines.push(`        ${JSON.stringify(n)}${j === y.nominees.length - 1 ? '' : ','}`));
      lines.push('      ]');
    }
    lines.push(`    }${i === years.length - 1 ? '' : ','}`);
  });
  lines.push('  ]', '}');
  return lines.join('\n') + '\n';
}

// ---- Voting --------------------------------------------------------------

// { phases: { yearId: 'pending' | 'nominating' | 'voting' } } — errors empty when valid.
function validatePhases(body) {
  if (!isObject(body) || !isObject(body.phases)) return { errors: ['phases must be an object of year id to phase'] };
  const entries = Object.entries(body.phases);
  if (entries.length > MAX_OPEN_YEARS) return { errors: [`more than ${MAX_OPEN_YEARS} years in a phase`] };
  const errors = [];
  for (const [id, phase] of entries) {
    if (!ID.test(id)) errors.push('every year id must be letters and digits.');
    else if (!PHASES.includes(phase)) errors.push(`${id}: phase must be pending, nominating or voting (a Complete year has no entry).`);
  }
  return { errors };
}

// The phases now in force. Falls back to the two legacy open lists when the
// state doc has never been saved, so years someone had already opened keep
// working across the change.
async function readPhases(store) {
  const doc = await storeGet(store, STATE_KEY);
  if (isObject(doc && doc.phases)) return doc.phases;
  const [voting, nominating] = await Promise.all([storeGet(store, VOTING_KEY), storeGet(store, NOMINATING_KEY)]);
  const phases = {};
  for (const id of Array.isArray(nominating && nominating.open) ? nominating.open : []) phases[id] = 'nominating';
  for (const id of Array.isArray(voting && voting.open) ? voting.open : []) phases[id] = 'voting';
  return phases;
}

// What the voter typed, tidied: control characters out, runs of whitespace
// collapsed, trimmed. Empty means no usable name.
function cleanVoterName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
// The identity a vote is unique on: case and spacing don't make a new voter.
const voterKey = (name) => cleanVoterName(name).toLowerCase();

// { name, password, yearId, nomineeId } shape only; the password is compared
// separately and the ids are checked against the real list afterwards.
function validateVote(body) {
  if (!isObject(body)) return { errors: ['body must be an object'] };
  const errors = [];
  const name = cleanVoterName(body.name);
  if (!name) errors.push('Enter your name.');
  else if (name.length > MAX_VOTER_NAME) errors.push(`Your name can be at most ${MAX_VOTER_NAME} characters.`);
  if (typeof body.yearId !== 'string' || !ID.test(body.yearId)) errors.push('Pick a year.');
  if (typeof body.nomineeId !== 'string' || !ID.test(body.nomineeId)) errors.push('Pick a nominee.');
  return { errors };
}

// Best-effort self-vote block. Compares the voter's typed name with the
// nominee's "Nominated by" text, ignoring case, punctuation and spacing, and
// counts a match on the first word, so "Jeff" and "Jeff Smith" are both caught
// against by = "Jeff". A nickname slips through, and a different person with
// the same first name is blocked: the cost of matching this loosely. No `by`
// means nothing to match.
function isOwnNomination(voterName, by) {
  const norm = (v) => cleanVoterName(v).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const n = norm(voterName);
  const b = norm(by);
  if (!n || !b) return false;
  return n === b || n.split(' ')[0] === b.split(' ')[0];
}

// { name, yearId, title, artist }: shape only. The password is checked first and
// the year/duplicates against the real file afterwards.
function validateNomination(body) {
  if (!isObject(body)) return { errors: ['body must be an object'] };
  const errors = [];
  const name = cleanVoterName(body.name);
  if (!name) errors.push('Enter your name.');
  else if (name.length > MAX_VOTER_NAME) errors.push(`Your name can be at most ${MAX_VOTER_NAME} characters.`);
  if (typeof body.yearId !== 'string' || !ID.test(body.yearId)) errors.push('Pick a year.');
  const title = cleanVoterName(body.title);
  if (!title) errors.push('Enter the song.');
  else if (title.length > MAX_TITLE_LENGTH) errors.push(`The song can be at most ${MAX_TITLE_LENGTH} characters.`);
  const artist = cleanVoterName(body.artist);
  if (!artist) errors.push('Enter the artist.');
  else if (artist.length > MAX_ARTIST_LENGTH) errors.push(`The artist can be at most ${MAX_ARTIST_LENGTH} characters.`);
  return { errors };
}

// Admin's edit of one ballot.
function validateBallotEdit(body) {
  if (!isObject(body)) return { errors: ['body must be an object'] };
  const errors = [];
  if (body.action !== 'set' && body.action !== 'delete') errors.push('action must be set or delete.');
  const name = cleanVoterName(body.name);
  if (!name) errors.push('A voter name is required.');
  else if (name.length > MAX_VOTER_NAME) errors.push(`The name can be at most ${MAX_VOTER_NAME} characters.`);
  if (typeof body.yearId !== 'string' || !ID.test(body.yearId)) errors.push('A year is required.');
  if (body.action === 'set' && (typeof body.nomineeId !== 'string' || !ID.test(body.nomineeId))) errors.push('A nominee is required.');
  return { errors };
}

// One year's ballots, oldest first, the shape the page reads.
const ballotList = (hash) => Object.values(hash || {}).map((v) => ({ name: v.name, nomineeId: v.nomineeId, at: v.at })).sort((a, b) => String(a.at).localeCompare(String(b.at)));

// Hashed first so timingSafeEqual gets equal-length inputs and the wrong-guess
// time reveals nothing about the real password's length (same as login.js).
function votePasswordMatches(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return 'unknown';
}

// The committed list as it is on main right now (Pages can lag a few minutes).
async function readBangersFile(token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const doc = JSON.parse(await res.text());
  return Array.isArray(doc.years) ? doc.years : [];
}

// The shared-password check for the public writes (vote, nominate), with the
// per-IP wrong-guess limit. Sends the refusal itself and returns false.
async function passwordGate(req, res, store, body) {
  const expected = process.env.BANGERS_VOTE_PASSWORD;
  if (!expected) { res.status(500).json({ error: 'BANGERS_VOTE_PASSWORD is not configured on this deployment.' }); return false; }
  const ipKey = `bangers:votefail:${clientIp(req)}`;
  try {
    const [failures] = await storeCounts(store, [ipKey]);
    if (failures >= VOTE_IP_MAX_FAILURES) { res.status(429).json({ error: 'Too many wrong passwords. Please wait a while and try again.' }); return false; }
  } catch (err) {
    console.error(`bangers: rate-limit check skipped, store unavailable: ${err.message}`);
  }
  if (!votePasswordMatches(body.password, expected)) {
    await storeBump(store, [{ key: ipKey, ttlSeconds: VOTE_IP_WINDOW_SECONDS }]).catch((err) => console.error(`bangers: failed attempt not counted: ${err.message}`));
    res.status(401).json({ error: 'Incorrect password.' });
    return false;
  }
  await storeRelease(store, ipKey).catch(() => {});
  return true;
}

const GH_HEADERS = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

// The list and its sha, as on main right now.
async function readListWithSha(token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`, { headers: GH_HEADERS(token), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const json = await res.json();
  const doc = JSON.parse(Buffer.from(json.content || '', 'base64').toString('utf8'));
  return { sha: json.sha, years: Array.isArray(doc.years) ? doc.years : [] };
}

// Adds one nominee to a year and commits it. The PUT carries the sha it read,
// so if an Admin save or another nomination got in first GitHub refuses it and
// we read again and redo the checks on the fresh list. Returns { nominee,
// yearLabel } or { status, error }.
async function addNomination(token, { yearId, name, title, artist }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sha, years } = await readListWithSha(token);
    const year = years.find((y) => y && y.id === yearId);
    if (!year) return { status: 400, error: 'That year is not on the list.' };
    const nominees = Array.isArray(year.nominees) ? year.nominees : [];
    if (nominees.some((n) => n && isOwnNomination(name, n.by))) return { status: 409, error: `You have already nominated a song for ${year.label}.` };
    const same = (a, b) => cleanVoterName(a).toLowerCase() === cleanVoterName(b).toLowerCase();
    if (nominees.some((n) => n && same(n.title, title) && same(n.artist, artist))) return { status: 409, error: `That song is already nominated for ${year.label}.` };
    if (nominees.length >= MAX_NOMINEES) return { status: 409, error: `${year.label} already has the maximum of ${MAX_NOMINEES} nominees.` };
    const nominee = { id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title, artist, by: name, winner: false };
    year.nominees = [...nominees, nominee];
    const { errors } = validateBangers({ years });
    if (errors.length) return { status: 500, error: `The list would not be valid with this nomination: ${errors[0]}` };
    const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`, {
      method: 'PUT',
      headers: { ...GH_HEADERS(token), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        message: `Add a nomination to ${year.label} from the Nominate tab`,
        content: Buffer.from(serialize(normalizeBangers(years)), 'utf8').toString('base64'),
        sha,
        branch: BRANCH,
      }),
    });
    if (putRes.status === 409 || putRes.status === 422) continue;
    if (!putRes.ok) throw new Error(`GitHub returned ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
    return { nominee, yearLabel: year.label };
  }
  return { status: 409, error: 'The list is being changed right now. Please try again in a moment.' };
}

async function handleVoting(req, res, resource) {
  const store = resolveStore(process.env);
  if (!store) {
    res.status(500).json({ error: 'No store is configured on this deployment (see resolveStore in api/plans.js).' });
    return;
  }
  try {
    if (resource === 'state') {
      if (req.method === 'GET') {
        res.status(200).json({ phases: await readPhases(store) });
        return;
      }
      const { errors } = validatePhases(req.body);
      if (errors.length) { res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors }); return; }
      const phases = { ...req.body.phases };
      await storeSet(store, STATE_KEY, { phases });
      res.status(200).json({ phases });
      return;
    }
    if (resource === 'nominate') {
      const body = req.body || {};
      if (!(await passwordGate(req, res, store, body))) return;
      const { errors } = validateNomination(body);
      if (errors.length) { res.status(400).json({ error: errors.join(' ') }); return; }
      if ((await readPhases(store))[body.yearId] !== 'nominating') { res.status(403).json({ error: 'Nominations are not open for that year.' }); return; }
      const token = process.env.GITHUB_CONTENTS_TOKEN;
      if (!token) { res.status(500).json({ error: 'GITHUB_CONTENTS_TOKEN is not configured on this deployment.' }); return; }
      let out;
      try {
        out = await addNomination(token, { yearId: body.yearId, name: cleanVoterName(body.name), title: cleanVoterName(body.title), artist: cleanVoterName(body.artist) });
      } catch (err) { res.status(502).json({ error: `Couldn't save the nomination: ${err.message}` }); return; }
      if (out.error) { res.status(out.status).json({ error: out.error }); return; }
      res.status(200).json({ ok: true, name: cleanVoterName(body.name), yearLabel: out.yearLabel });
      return;
    }
    if (resource === 'tally') {
      const years = String((req.query && req.query.years) || '').split(',').filter(Boolean);
      if (years.length > MAX_YEARS || years.some((id) => !ID.test(id))) { res.status(400).json({ error: 'years must be a comma-separated list of year ids.' }); return; }
      const hashes = years.length ? await storeHashGetAll(store, years.map(votesKey)) : [];
      const counts = {};
      for (const h of hashes) for (const v of Object.values(h)) if (v && typeof v.nomineeId === 'string') counts[v.nomineeId] = (counts[v.nomineeId] || 0) + 1;
      res.status(200).json({ counts });
      return;
    }
    if (resource === 'votes') {
      const years = String((req.query && req.query.years) || '').split(',').filter(Boolean);
      if (years.length > MAX_YEARS || years.some((id) => !ID.test(id))) { res.status(400).json({ error: 'years must be a comma-separated list of year ids.' }); return; }
      const hashes = years.length ? await storeHashGetAll(store, years.map(votesKey)) : [];
      const votes = {};
      years.forEach((id, i) => { votes[id] = ballotList(hashes[i]); });
      res.status(200).json({ votes });
      return;
    }
    if (resource === 'ballot') {
      const { errors } = validateBallotEdit(req.body);
      if (errors.length) { res.status(400).json({ error: errors.join(' ') }); return; }
      const { yearId, action } = req.body;
      const name = cleanVoterName(req.body.name);
      if (action === 'set') {
        const token = process.env.GITHUB_CONTENTS_TOKEN;
        if (!token) { res.status(500).json({ error: 'GITHUB_CONTENTS_TOKEN is not configured on this deployment.' }); return; }
        let years;
        try { years = await readBangersFile(token); } catch (err) { res.status(502).json({ error: `Couldn't read the nominee list: ${err.message}` }); return; }
        const year = years.find((y) => y && y.id === yearId);
        if (!year || !Array.isArray(year.nominees) || !year.nominees.some((n) => n && n.id === req.body.nomineeId)) {
          res.status(400).json({ error: 'That nominee is not in that year.' });
          return;
        }
        await storeHashSet(store, votesKey(yearId), voterKey(name), { name, nomineeId: req.body.nomineeId, at: new Date().toISOString() });
      } else {
        await storeHashDelete(store, votesKey(yearId), voterKey(name));
      }
      const [hash] = await storeHashGetAll(store, [votesKey(yearId)]);
      res.status(200).json({ yearId, votes: ballotList(hash) });
      return;
    }

    // resource === 'vote'
    const body = req.body || {};
    if (!(await passwordGate(req, res, store, body))) return;
    const { errors } = validateVote(body);
    if (errors.length) { res.status(400).json({ error: errors.join(' ') }); return; }

    if ((await readPhases(store))[body.yearId] !== 'voting') { res.status(403).json({ error: 'Voting is not open for that year.' }); return; }

    const token = process.env.GITHUB_CONTENTS_TOKEN;
    if (!token) { res.status(500).json({ error: 'GITHUB_CONTENTS_TOKEN is not configured on this deployment.' }); return; }
    let years;
    try { years = await readBangersFile(token); } catch (err) { res.status(502).json({ error: `Couldn't read the nominee list: ${err.message}` }); return; }
    const year = years.find((y) => y && y.id === body.yearId);
    const nominee = year && Array.isArray(year.nominees) ? year.nominees.find((n) => n && n.id === body.nomineeId) : null;
    if (!nominee) {
      res.status(400).json({ error: 'That nominee is not in that year.' });
      return;
    }
    if (isOwnNomination(body.name, nominee.by)) {
      res.status(403).json({ error: 'You can’t vote for your own nomination. Pick another song.' });
      return;
    }

    const name = cleanVoterName(body.name);
    const added = await storeHashSetNew(store, votesKey(body.yearId), voterKey(name), { name, nomineeId: body.nomineeId, at: new Date().toISOString() });
    if (!added) { res.status(409).json({ error: `${name} has already voted for ${year.label}.` }); return; }
    res.status(200).json({ ok: true, name, yearId: body.yearId });
  } catch (err) {
    res.status(502).json({ error: `Store unavailable: ${err.message}` });
  }
}

async function githubGet(token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return { sha: null, ids: new Set() }; // first save creates the file
  if (!res.ok) throw new Error(`Couldn't read the current list (GitHub returned ${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  // The year ids already in the file, to tell a year this save adds from one it keeps.
  let ids = new Set();
  try {
    const doc = JSON.parse(Buffer.from(json.content || '', 'base64').toString('utf8'));
    ids = new Set((Array.isArray(doc.years) ? doc.years : []).map((y) => y && y.id));
  } catch { /* unreadable: nothing is treated as new, so nothing is hidden by mistake */ }
  return { sha: json.sha, ids };
}

// Marks the given years Pending, leaving every phase already set alone. Returns
// { phases } when it wrote, or { warning } when it could not (no store, or the
// store failed): the save still goes ahead, and the page says what to do.
async function markPending(ids) {
  const store = resolveStore(process.env);
  if (!store) return { warning: 'No store is configured, so the new year was not marked Pending. Set its status in the Years card.' };
  try {
    const phases = await readPhases(store);
    const next = { ...phases };
    for (const id of ids) if (!(id in next)) next[id] = 'pending';
    await storeSet(store, STATE_KEY, { phases: next });
    return { phases: next };
  } catch (err) {
    return { warning: `The new year was not marked Pending (${err.message}). Set its status in the Years card.` };
  }
}

// True when the page told us which version it loaded and that is no longer the
// current one. A missing or malformed baseSha is "not told", never stale.
function isStaleBase(baseSha, currentSha) {
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(baseSha)) return false;
  return baseSha !== currentSha;
}

function bearerOk(req) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return verifyToken(bearer, process.env.SESSION_SECRET);
}

// The Upstash-backed resources. Auth has already been checked by the caller.
async function handleStoreResource(req, res, resource) {
  const store = resolveStore(process.env);
  if (!store) {
    res.status(500).json({ error: 'No store is configured on this deployment (see resolveStore in api/plans.js).' });
    return;
  }
  try {
    if (resource === 'quicklinks') {
      if (req.method === 'GET') {
        res.status(200).json({ links: (await storeGet(store, QUICKLINKS_KEY)) || [] });
        return;
      }
      const { errors } = validateQuickLinks(req.body);
      if (errors.length) {
        res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
        return;
      }
      const links = normalizeQuickLinks(req.body.links);
      await storeSet(store, QUICKLINKS_KEY, links);
      res.status(200).json({ links });
      return;
    }
    const storedTasks = (await storeGet(store, TASKS_KEY)) || {};
    if (req.method === 'GET') {
      res.status(200).json({ tasks: storedTasks });
      return;
    }
    const { errors } = validateTaskPatch(req.body);
    if (errors.length) {
      res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
      return;
    }
    const nextTasks = applyTaskPatch(storedTasks, req.body);
    if (Object.keys(nextTasks).length > MAX_TASKS) {
      res.status(400).json({ error: `Nothing was saved — more than ${MAX_TASKS} tasks.` });
      return;
    }
    await storeSet(store, TASKS_KEY, nextTasks);
    res.status(200).json({ tasks: nextTasks });
  } catch (err) {
    res.status(502).json({ error: `Store unavailable: ${err.message}` });
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, Authorization' })) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const resource = req.method === 'GET' ? (req.query && req.query.resource) : (req.body || {}).resource;
  const storeResource = resource === 'tasks' || resource === 'quicklinks';
  const votingResource = resource === 'state' || resource === 'votes' || resource === 'vote' || resource === 'ballot' || resource === 'tally' || resource === 'nominate';
  // vote and ballot are POST only, votes (the ballots) GET only, voting (open years) either.
  if (((resource === 'vote' || resource === 'ballot' || resource === 'nominate') && req.method !== 'POST') || ((resource === 'votes' || resource === 'tally') && req.method !== 'GET')) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // The bangers list has no GET (Pages serves the file), so a bare GET is a mistake.
  if (req.method === 'GET' && !storeResource && !votingResource) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Everything but the public quick-links read, the public phases read and
  // casting a vote (password-gated instead) needs a login.
  const needsLogin = resource === 'vote' || resource === 'nominate' ? false : resource === 'state' ? req.method === 'POST' : (req.method === 'POST' || resource === 'tasks' || resource === 'votes');  // ballot is a POST, so login-gated
  if (needsLogin) {
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) {
      res.status(500).json({ error: 'SESSION_SECRET is not configured on this deployment.' });
      return;
    }
    if (!bearerOk(req)) {
      res.status(401).json({ error: 'Log in again — your session has expired or is invalid.' });
      return;
    }
  }
  if (storeResource) {
    await handleStoreResource(req, res, resource);
    return;
  }
  if (votingResource) {
    await handleVoting(req, res, resource);
    return;
  }

  const token = process.env.GITHUB_CONTENTS_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'GITHUB_CONTENTS_TOKEN is not configured on this deployment. Add a fine-grained token with Contents: Read and write in the Vercel project settings.' });
    return;
  }

  const body = req.body || {};
  const { errors } = validateBangers(body);
  if (errors.length) {
    res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
    return;
  }

  try {
    // Re-read immediately before writing: the sha is both the concurrency
    // check for the PUT and what the stale test below compares against.
    const { sha, ids: existingIds } = await githubGet(token);
    if (isStaleBase(body.baseSha, sha)) {
      res.status(409).json({ error: 'The list changed since this page loaded it (another save, possibly still publishing). Nothing was saved — reload in a few minutes and make your change again.' });
      return;
    }
    const years = normalizeBangers(body.years);
    // A year this save adds starts Pending. Done BEFORE the commit so the year is
    // never public; if the commit then fails, the entry is for an id that was never
    // saved, which nothing reads.
    const newIds = existingIds.size ? years.map((y) => y.id).filter((id) => !existingIds.has(id)) : [];
    const pending = newIds.length ? await markPending(newIds) : {};
    const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        message: 'Update Hoot Owl Bangers from the Admin tab',
        content: Buffer.from(serialize(years), 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
        branch: BRANCH,
      }),
    });
    if (putRes.status === 409 || putRes.status === 422) {
      res.status(409).json({ error: 'The list changed while you were editing. Reload the page and make your change again.' });
      return;
    }
    if (!putRes.ok) throw new Error(`GitHub returned ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
    const saved = await putRes.json();
    // The new file's blob sha, so the page can keep saving from this session
    // without a reload tripping the stale check above.
    res.status(200).json({
      ok: true, years, sha: (saved.content && saved.content.sha) || null,
      ...(pending.phases ? { phases: pending.phases, newYears: newIds } : {}),
      ...(pending.warning ? { warning: pending.warning, newYears: newIds } : {}),
    });
  } catch (err) {
    res.status(502).json({ error: `Failed to save: ${err.message}` });
  }
}
