// Vercel serverless function behind melbostads.com/vikings: who sits in which
// season-ticket seat for each Vikings home game, plus each game's face value.
//
// The schedule itself is NOT stored here. The page reads it from the sync's
// committed snapshot (data/rosters.json -> nflSchedules.teams.MIN, home games
// only, plus preseason from nflPreseason); this endpoint holds only what the
// manager types, keyed by `${season}-${week}` (`${season}-p${week}` for
// preseason; the week number survives a flex, so a moved kickoff keeps its
// names).
//
// GET is PUBLIC and POST needs the same Bearer token as every other write
// (api/_lib/auth.mjs). That is the opposite of api/plans.js, and deliberate:
// the page renders for logged-out visitors as plain text, and the sheet this
// replaced was already published to the world. Nothing here is strategy.
// Don't gate the GET, and don't move this into the plans document, which is
// login-only on read.
//
// POST is a per-game patch — { game, face?, seats? } — not a whole-document
// replace, so a page holding a stale copy can only touch the cell it edited.
// Within a patch an empty string deletes the value. One account, one document
// (VIKINGS_KEY); the read-modify-write isn't atomic, which is fine for a
// single editor.
//
// Same Upstash store as plans.js (resolveStore), no expiry on the key.
//
// TASKS. The Admin tab's Tasks card keeps its list in a SECOND key
// (TASKS_KEY), deliberately apart from myFFL's plans document: the two lists
// share a card design, not data. Unlike the seats, tasks are private, so
// `GET ?resource=tasks` needs the Bearer token (the seats GET above stays
// public). A write is a per-task patch, like the seat patch —
// { resource: 'tasks', tasks: { <id>: task | null } } — where null deletes, so
// a device holding a stale list can only touch the tasks it edited. The task
// shape and its validator are plans.js's own (validateTasks / mergeTasks).
//
// QUICK LINKS. The page's header toolbar, edited from the Admin tab's Quick
// Links card: `{ resource: 'quicklinks', links: [{ url, nickname, style?,
// group?, visibility? }] }`, the whole ordered list replaced in one write (array order is
// toolbar order). Same fields as myFFL's quickLinks in config/leagues.json,
// minus the League Links block, but stored in Upstash (QUICKLINKS_KEY) rather
// than committed to the repo. Like the seats, the GET is public: logged-out
// visitors see the toolbar too. The POST is login-gated like every write.

import { verifyToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { storeGet, storeSet } from './_lib/store.mjs';
import { resolveStore, validateTasks, mergeTasks } from './plans.js';

const VIKINGS_KEY = 'vikings:tickets';
const TASKS_KEY = 'vikings:tasks';
const QUICKLINKS_KEY = 'vikings:quicklinks';
const TASK_ID = /^[A-Za-z0-9]{1,40}$/;
const MAX_TASKS = 300;
// Every season back to 2007, each with preseason, regular-season and playoff
// home games: about 15 a season.
const MAX_GAMES = 300;
const MAX_SEATS_PER_PATCH = 12;
const MAX_NAME_LENGTH = 60;
const MAX_FACE_LENGTH = 8;
// `2026-9` is regular-season week 9; `2026-p3` is preseason week 3, which
// would otherwise collide with a regular-season week of the same number.
// `2026-po1` is a hand-entered playoff row: the schedule feed can't know them,
// so the manager types their date, day, time and opponent too (`info`).
const GAME_KEY = /^\d{4}-(?:p|po)?\d{1,2}$/;
const INFO_FIELDS = ['day', 'date', 'time', 'opp'];
const MAX_INFO_LENGTH = 40;
const SEAT_ID = /^\d{1,3}$/;

const MAX_QUICKLINKS = 50;
const QUICKLINK_STYLES = new Set(['gold', 'purple']);
// Unset = always; 'loggedin' hides from logged-out visitors; 'never' hides for all.
// Page-side only: the public GET still returns every link.
const QUICKLINK_VISIBILITIES = new Set(['never', 'loggedin']);

export { validatePatch, applyPatch, emptyDocument, validateTaskPatch, applyTaskPatch, validateQuickLinks, normalizeQuickLinks, VIKINGS_KEY, TASKS_KEY, QUICKLINKS_KEY };

function emptyDocument() {
  return { games: {}, updatedAt: null };
}

// Returns { errors } — empty means valid. Shape-only: which seat ids exist is
// the page's business (SEAT_GROUPS in vikings.html), not this endpoint's.
function validatePatch(patch) {
  const errors = [];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { errors: ['body must be an object'] };
  }
  if (typeof patch.game !== 'string' || !GAME_KEY.test(patch.game)) {
    errors.push('game must look like 2026-9, 2026-p3 or 2026-po1');
  }
  if (patch.face === undefined && patch.seats === undefined && patch.info === undefined) {
    errors.push('nothing to save: send face, seats and/or info');
  }
  if (patch.info !== undefined) {
    const info = patch.info;
    if (info === null || typeof info !== 'object' || Array.isArray(info)) {
      errors.push('info must be an object');
    } else {
      for (const [k, v] of Object.entries(info)) {
        if (!INFO_FIELDS.includes(k)) errors.push(`info.${k} is not a known field`);
        else if (typeof v !== 'string' || v.trim().length > MAX_INFO_LENGTH) errors.push(`info.${k} must be a string up to ${MAX_INFO_LENGTH} characters`);
      }
    }
  }
  if (patch.face !== undefined && (typeof patch.face !== 'string' || patch.face.trim().length > MAX_FACE_LENGTH)) {
    errors.push(`face must be a string up to ${MAX_FACE_LENGTH} characters`);
  }
  if (patch.seats !== undefined) {
    const seats = patch.seats;
    if (seats === null || typeof seats !== 'object' || Array.isArray(seats)) {
      errors.push('seats must be an object');
    } else {
      const ids = Object.keys(seats);
      if (ids.length > MAX_SEATS_PER_PATCH) errors.push(`seats has more than ${MAX_SEATS_PER_PATCH} entries`);
      for (const id of ids) {
        if (!SEAT_ID.test(id)) errors.push(`seat id ${JSON.stringify(id)} must be a number`);
        else if (typeof seats[id] !== 'string' || seats[id].trim().length > MAX_NAME_LENGTH) {
          errors.push(`seats.${id} must be a string up to ${MAX_NAME_LENGTH} characters`);
        }
      }
    }
  }
  return { errors };
}

// Pure: returns a new document with a validated patch applied. A game left
// with no face value, info or seat is dropped, so clearing a row clears it.
function applyPatch(doc, patch) {
  const games = {};
  for (const [k, v] of Object.entries((doc && doc.games) || {})) {
    games[k] = { ...(v.face ? { face: v.face } : {}), ...(v.info ? { info: { ...v.info } } : {}), seats: { ...(v.seats || {}) } };
  }
  const game = games[patch.game] || { seats: {} };
  if (patch.face !== undefined) {
    const face = patch.face.trim();
    if (face) game.face = face; else delete game.face;
  }
  for (const [k, raw] of Object.entries(patch.info || {})) {
    const text = raw.trim();
    game.info = { ...(game.info || {}) };
    if (text) game.info[k] = text; else delete game.info[k];
    if (!Object.keys(game.info).length) delete game.info;
  }
  for (const [id, raw] of Object.entries(patch.seats || {})) {
    const name = raw.trim();
    if (name) game.seats[id] = name; else delete game.seats[id];
  }
  if (game.face || game.info || Object.keys(game.seats).length) games[patch.game] = game;
  else delete games[patch.game];
  return { games, updatedAt: Date.now() };
}

// { tasks: { id: task | null } } — shape only; the task fields are checked by
// plans.js's validateTasks so the two lists can never disagree about a task.
function validateTaskPatch(patch) {
  const tasks = patch && patch.tasks;
  if (tasks === null || typeof tasks !== 'object' || Array.isArray(tasks)) return { errors: ['tasks must be an object'] };
  const errors = [];
  const ids = Object.keys(tasks);
  if (!ids.length) errors.push('nothing to save: tasks is empty');
  if (ids.length > MAX_TASKS) errors.push(`tasks has more than ${MAX_TASKS} entries`);
  const live = {};
  for (const id of ids) {
    if (!TASK_ID.test(id)) errors.push(`task id ${JSON.stringify(id)} must be letters and digits`);
    else if (tasks[id] !== null) live[id] = tasks[id];
  }
  errors.push(...validateTasks(live));
  return { errors };
}

// Pure: returns a new { tasks } list with the patch applied. mergeTasks only
// normalises here (each patched task goes through an empty list), so a
// stored task is replaced by the patched one rather than winning.
function applyTaskPatch(stored, patch) {
  const tasks = { ...(stored || {}) };
  for (const [id, task] of Object.entries(patch.tasks)) {
    if (task === null) delete tasks[id];
    else tasks[id] = mergeTasks({}, { [id]: task })[id];
  }
  return tasks;
}

// { links: [...] } — returns { errors }, empty meaning valid.
function validateQuickLinks(body) {
  const links = body && body.links;
  if (!Array.isArray(links)) return { errors: ['links must be a list'] };
  if (links.length > MAX_QUICKLINKS) return { errors: [`links has more than ${MAX_QUICKLINKS} entries`] };
  const errors = [];
  links.forEach((link, i) => {
    const where = `Quick link ${i + 1}`;
    if (!link || typeof link !== 'object' || Array.isArray(link)) { errors.push(`${where}: not a valid entry.`); return; }
    const nickname = typeof link.nickname === 'string' ? link.nickname.trim() : '';
    const url = typeof link.url === 'string' ? link.url.trim() : '';
    if (!nickname) errors.push(`${where}: nickname is required.`);
    else if (nickname.length > 40) errors.push(`${where}: nickname is longer than 40 characters.`);
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > 500) errors.push(`${where}: link must start with http:// or https://.`);
    if (link.style != null && link.style !== '' && !QUICKLINK_STYLES.has(link.style)) errors.push(`${where}: style must be gold, purple, or left blank for plain.`);
    if (link.visibility != null && link.visibility !== '' && !QUICKLINK_VISIBILITIES.has(link.visibility)) errors.push(`${where}: visibility must be never, loggedin, or left blank for always.`);
    if (link.group != null && (typeof link.group !== 'string' || link.group.trim().length > 40)) errors.push(`${where}: group must be text up to 40 characters.`);
  });
  return { errors };
}

// Pure: the stored shape. Trims, drops blank optional fields and anything
// unknown, so what reaches the page is only url, nickname, style, visibility and group.
function normalizeQuickLinks(links) {
  return (links || []).map((link) => {
    const out = { url: link.url.trim(), nickname: link.nickname.trim() };
    if (link.style) out.style = link.style;
    if (link.visibility) out.visibility = link.visibility;
    const group = typeof link.group === 'string' ? link.group.trim() : '';
    if (group) out.group = group;
    return out;
  });
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, Authorization' })) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const resource = req.method === 'GET' ? (req.query && req.query.resource) : (req.body || {}).resource;
  const wantsTasks = resource === 'tasks';
  const wantsQuickLinks = resource === 'quicklinks';
  if (req.method === 'POST' || wantsTasks) {
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
  }

  const store = resolveStore(process.env);
  if (!store) {
    res.status(500).json({ error: 'No store is configured on this deployment (see resolveStore in api/plans.js).' });
    return;
  }

  try {
    if (wantsQuickLinks) {
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
    if (wantsTasks) {
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
      return;
    }
    const stored = (await storeGet(store, VIKINGS_KEY)) || emptyDocument();
    if (req.method === 'GET') {
      res.status(200).json({ tickets: stored });
      return;
    }

    const patch = req.body || {};
    const { errors } = validatePatch(patch);
    if (errors.length) {
      res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
      return;
    }
    const next = applyPatch(stored, patch);
    if (Object.keys(next.games).length > MAX_GAMES) {
      res.status(400).json({ error: `Nothing was saved — more than ${MAX_GAMES} games.` });
      return;
    }
    await storeSet(store, VIKINGS_KEY, next);
    res.status(200).json({ tickets: next });
  } catch (err) {
    res.status(502).json({ error: `Ticket store unavailable: ${err.message}` });
  }
}
