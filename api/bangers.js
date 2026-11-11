// Vercel serverless function behind melbostads.com/bangers: the Hoot Owl
// Bangers list — for each year, the songs nominated and which one won.
//
// One account, one document (BANGERS_KEY) in the same Upstash store as
// plans.js and vikings.js (resolveStore), no expiry:
//
//   { years: [ { id, label, nominees: [ { id, title, artist, by, winner } ] } ],
//     updatedAt }
//
// Array order is display order, newest first. `label` is free text ("2023",
// "2020 (Spring)", "Grandfathered"), not a number, because the list has
// years that aren't one. A year may have several winners: "Grandfathered"
// is one group of four.
//
// GET is PUBLIC and returns { bangers: null } before anything has been saved;
// the page then shows the list it ships with (SEED_YEARS in bangers.html).
// POST needs the same Bearer token as every other write (api/_lib/auth.mjs).
// Like vikings.js, and unlike plans.js: logged-out visitors see the plaques,
// and nothing here is strategy. Don't gate the GET.
//
// POST replaces the whole document, and refuses a stale one: the page sends
// the `updatedAt` it loaded (null for "never saved") and a mismatch is a 409,
// so a second device can't silently erase the first one's edits
// (api/save-leagues.js does the same with a blob sha). The read-modify-write
// isn't atomic, which is fine for a single editor.

import { verifyToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { storeGet, storeSet } from './_lib/store.mjs';
import { resolveStore } from './plans.js';

const BANGERS_KEY = 'bangers:list';
const ID = /^[A-Za-z0-9]{1,40}$/;
const MAX_YEARS = 100;
const MAX_NOMINEES = 40;
const MAX_LABEL_LENGTH = 40;
const MAX_TITLE_LENGTH = 120;
const MAX_ARTIST_LENGTH = 120;
const MAX_BY_LENGTH = 60;

export { validateBangers, normalizeBangers, isStale, BANGERS_KEY };

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
      winner: n.winner === true,
    })),
  }));
}

// `base` is the updatedAt the page loaded. A missing or null base means "I saw
// nothing stored" and is only stale if something has been stored since.
function isStale(stored, base) {
  if (!stored) return false;
  return (base == null ? null : base) !== (stored.updatedAt == null ? null : stored.updatedAt);
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
    const stored = await storeGet(store, BANGERS_KEY);
    if (req.method === 'GET') {
      res.status(200).json({ bangers: stored || null });
      return;
    }

    const body = req.body || {};
    const { errors } = validateBangers(body);
    if (errors.length) {
      res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
      return;
    }
    if (isStale(stored, body.baseUpdatedAt)) {
      res.status(409).json({ error: 'Nothing was saved — the list changed on another device. Reload to pick up those changes, then redo this edit.', bangers: stored });
      return;
    }
    const next = { years: normalizeBangers(body.years), updatedAt: Date.now() };
    await storeSet(store, BANGERS_KEY, next);
    res.status(200).json({ bangers: next });
  } catch (err) {
    res.status(502).json({ error: `Bangers store unavailable: ${err.message}` });
  }
}
