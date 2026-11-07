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

import { verifyToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { storeGet, storeSet } from './_lib/store.mjs';
import { resolveStore } from './plans.js';

const VIKINGS_KEY = 'vikings:tickets';
const MAX_GAMES = 40;
const MAX_SEATS_PER_PATCH = 12;
const MAX_NAME_LENGTH = 60;
const MAX_FACE_LENGTH = 8;
// `2026-9` is regular-season week 9; `2026-p3` is preseason week 3, which
// would otherwise collide with a regular-season week of the same number.
const GAME_KEY = /^\d{4}-p?\d{1,2}$/;
const SEAT_ID = /^\d{1,3}$/;

export { validatePatch, applyPatch, emptyDocument, VIKINGS_KEY };

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
    errors.push('game must look like 2026-9 or 2026-p3 (season-week)');
  }
  if (patch.face === undefined && patch.seats === undefined) {
    errors.push('nothing to save: send face and/or seats');
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
// with neither a face value nor a seat is dropped, so clearing a row clears it.
function applyPatch(doc, patch) {
  const games = {};
  for (const [k, v] of Object.entries((doc && doc.games) || {})) {
    games[k] = { ...(v.face ? { face: v.face } : {}), seats: { ...(v.seats || {}) } };
  }
  const game = games[patch.game] || { seats: {} };
  if (patch.face !== undefined) {
    const face = patch.face.trim();
    if (face) game.face = face; else delete game.face;
  }
  for (const [id, raw] of Object.entries(patch.seats || {})) {
    const name = raw.trim();
    if (name) game.seats[id] = name; else delete game.seats[id];
  }
  if (game.face || Object.keys(game.seats).length) games[patch.game] = game;
  else delete games[patch.game];
  return { games, updatedAt: Date.now() };
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, Authorization' })) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (req.method === 'POST') {
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
