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
// A save from a stale copy is refused: the page sends the git blob sha of the
// exact bytes it loaded (`baseSha`, computed the way myffl.html's gitBlobSha
// does) and a mismatch is a 409. A missing sha is never stale.

import { verifyToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { storeGet, storeSet } from './_lib/store.mjs';
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

export { validateBangers, normalizeBangers, serialize, isStaleBase, TASKS_KEY, QUICKLINKS_KEY };

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

async function githubGet(token) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return { sha: null }; // first save creates the file
  if (!res.ok) throw new Error(`Couldn't read the current list (GitHub returned ${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { sha: json.sha };
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
  // The bangers list has no GET (Pages serves the file), so a bare GET is a mistake.
  if (req.method === 'GET' && !storeResource) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Everything but the public quick-links read needs a login.
  if (req.method === 'POST' || resource === 'tasks') {
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
    const { sha } = await githubGet(token);
    if (isStaleBase(body.baseSha, sha)) {
      res.status(409).json({ error: 'The list changed since this page loaded it (another save, possibly still publishing). Nothing was saved — reload in a few minutes and make your change again.' });
      return;
    }
    const years = normalizeBangers(body.years);
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
    res.status(200).json({ ok: true, years, sha: (saved.content && saved.content.sha) || null });
  } catch (err) {
    res.status(502).json({ error: `Failed to save: ${err.message}` });
  }
}
