// Vercel serverless function behind the Admin tab of index.html (myFAM, the
// melbostads.com home page): its Tasks card and its Quick Links card, the same
// two features as vikings.html's and bangers.html's Admin tabs.
//
// Unlike api/bangers.js there is no committed file here: the Family tab has no
// data yet, so this endpoint is the Upstash-backed half only. Both resources
// are NOT in the repo: they change constantly and tasks are private, so they
// live in the Upstash store (resolveStore in plans.js) under their own keys,
// apart from the Vikings page's, the Bangers page's and myFFL's. They go
// through `?resource=tasks` / `?resource=quicklinks`, and the validators,
// per-task patch and link normalisation are vikings.js's own, imported so the
// pages can never disagree about a task or a link.
//
// Access: the quick-links GET is public (logged-out visitors see the toolbar),
// the tasks GET needs the Bearer token, and every POST does.
//
// Why its own file and not a third `resource` on bangers.js: that file's other
// job is committing data/bangers.json, and a Hobby deployment may hold 12
// functions. This is the 12th, so the cap is now spent. A next endpoint means
// folding two of these site endpoints together first. (Count api/*.js.)

import { verifyToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { storeGet, storeSet } from './_lib/store.mjs';
import { resolveStore } from './plans.js';
import { validateTaskPatch, applyTaskPatch, validateQuickLinks, normalizeQuickLinks } from './vikings.js';

// Upstash keys. Deliberately not vikings.js's or bangers.js's: sharing one
// would show each page the other's tasks and toolbar.
const TASKS_KEY = 'fam:tasks';
const QUICKLINKS_KEY = 'fam:quicklinks';
const MAX_TASKS = 300;

export { TASKS_KEY, QUICKLINKS_KEY };

function bearerOk(req) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return verifyToken(bearer, process.env.SESSION_SECRET);
}

// Auth has already been checked by the caller.
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
  // Only the two store resources exist here; anything else is a mistake.
  if (resource !== 'tasks' && resource !== 'quicklinks') {
    res.status(req.method === 'GET' ? 405 : 400).json({ error: 'Unknown resource: use "tasks" or "quicklinks".' });
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
  await handleStoreResource(req, res, resource);
}
