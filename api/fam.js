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
// fish.html's Photos tab reads its own album through `?resource=fishphotos`: same
// code and cache rules, but the token is the FISH_PHOTOS_ALBUM Vercel variable
// and the cache entry is separate from myFAM's.
// (FISH_PHOTOS_ALBUM is set in Vercel production, and must be an old-style token
// from a Public Website link, https://www.icloud.com/sharedalbum/#<token>: the newer
// photos.icloud.com/shared/album/055-… links 404 on this API. A change to it needs a deploy.)
//
// A third resource, `?resource=photos`, is the Photos card's public iCloud
// Shared Album (api/_lib/sharedalbum.mjs). It touches no store, needs no login
// (the Family tab is public, and the album link is already shareable) and reads
// the album token from the FAM_PHOTOS_ALBUM Vercel variable, so the token stays
// out of the repo and the page source. Its cache is tied to when Apple's signed
// image links expire (see photoCacheMs), and `&refresh=1` skips it and needs the
// Bearer token.
//
// `?resource=calendar` is the Calendar card's public iCloud calendar feed
// (api/_lib/calendarfeed.mjs), same shape: no store, no login, link in the
// FAM_CALENDAR_ICS Vercel variable (webcal:// or https://), one `?month=` at a time.
//
// Changing FAM_PHOTOS_ALBUM or FAM_CALENDAR_ICS only reaches a NEW deployment,
// and vercel.json's ignoreCommand cancels a dashboard "Redeploy" of a commit that
// already shipped (nothing under api/ changed). Ship the change with any commit
// that touches api/, such as an edit to this comment.
//
// Why its own file and not a third `resource` on bangers.js: that file's other
// job is committing data/bangers.json, and a Hobby deployment may hold 12
// functions. This is the 12th, so the cap is now spent. A next endpoint means
// folding two of these site endpoints together first. (Count api/*.js.)

import { verifyToken } from './_lib/auth.mjs';
import { applyCors } from './_lib/cors.mjs';
import { storeGet, storeSet, storeRelease } from './_lib/store.mjs';
import { resolveStore } from './plans.js';
import { fetchSharedAlbum } from './_lib/sharedalbum.mjs';
import { fetchCalendar, monthWindow } from './_lib/calendarfeed.mjs';
import { validateTaskPatch, applyTaskPatch, validateQuickLinks, normalizeQuickLinks } from './vikings.js';
import { validateTrips, normalizeTrips, SEED_TRIPS } from './_lib/fishtrips.mjs';
import { validateLures, normalizeLures, decodeLurePhoto, isLureId } from './_lib/fishlures.mjs';

// Upstash keys. Deliberately not vikings.js's or bangers.js's: sharing one
// would show each page the other's tasks and toolbar.
const TASKS_KEY = 'fam:tasks';
const QUICKLINKS_KEY = 'fam:quicklinks';
const MAX_TASKS = 300;
// fish.html (myFish) rides this same endpoint, because the Hobby cap of 12
// functions is spent: its own Tasks, Quick Links and trip log, under their own
// keys (`fishtasks` / `fishquicklinks` / `fishtrips`). Never share keys with
// myFAM's. `fishtrips` GET is public (the Ice Fishing tab is for everyone) and
// answers with the seed trips until the first Save (api/_lib/fishtrips.mjs).
const FISH_TASKS_KEY = 'fish:tasks';
const FISH_QUICKLINKS_KEY = 'fish:quicklinks';
const FISH_TRIPS_KEY = 'fish:trips';
// The Equipment tab's favourite lures (api/_lib/fishlures.mjs): public GET, login-gated
// POST, an empty list until the first Save.
const FISH_LURES_KEY = 'fish:lures';
// One key per lure picture (a JPEG data URL), so the lures list stays small.
const lurePhotoKey = (id) => `fish:lurephoto:${id}`;

export { TASKS_KEY, QUICKLINKS_KEY, FISH_TASKS_KEY, FISH_QUICKLINKS_KEY, FISH_TRIPS_KEY, FISH_LURES_KEY };

// Public, store-less feeds share one cached path (Calendar), and Photos has its
// own below. Module-level: resets on a cold start, which is fine.
const FEED_CACHE_MS = 5 * 60 * 1000;
const feedCache = {};
// Photos: Apple's image links are signed and die at their `url_expiry` (~20 minutes
// after they are issued), so the response may only be reused while the links still
// have a healthy margin left. How long that is comes from the links themselves, so
// it follows Apple if the expiry ever changes: served until PHOTO_URL_MARGIN_MS
// before the earliest expiry, but at least PHOTO_CACHE_MIN_MS, and never longer
// than PHOTO_CACHE_MAX_MS. With no expiry in the response, PHOTO_CACHE_FALLBACK_MS.
// Never cache this response for hours on a fixed timer: the links would be dead.
const PHOTO_URL_MARGIN_MS = 10 * 60 * 1000;
const PHOTO_CACHE_MIN_MS = 60 * 1000;
const PHOTO_CACHE_MAX_MS = 12 * 60 * 60 * 1000;
const PHOTO_CACHE_FALLBACK_MS = 5 * 60 * 1000;
export function photoCacheMs(expires, now) {
  const exp = Date.parse(expires);
  if (!Number.isFinite(exp)) return PHOTO_CACHE_FALLBACK_MS;
  return Math.min(PHOTO_CACHE_MAX_MS, Math.max(PHOTO_CACHE_MIN_MS, exp - PHOTO_URL_MARGIN_MS - now));
}
// One cached album per Vercel variable: myFAM's (`photos`, FAM_PHOTOS_ALBUM) and
// myFish's (`fishphotos`, FISH_PHOTOS_ALBUM) are separate albums and must never
// share an entry. Each is { token, until, body }.
const photoCaches = {};
export function resetPhotosCache() {
  for (const k of Object.keys(feedCache)) delete feedCache[k];
  for (const k of Object.keys(photoCaches)) delete photoCaches[k];
}

// The secret may be a bare token (Photos) or a link (Calendar, stored as
// webcal:// but fetched as https://), so the token part is scrubbed on its own.
function scrubSecret(message, secret) {
  const token = secret.includes('/') ? secret.replace(/\/+$/, '').split('/').pop() : secret;
  let out = message;
  // A dashed `055-` token is also tried without its prefix (sharedalbum.mjs tokenForms).
  const dashed = /^\d{3}-(.{20,})$/.exec(secret);
  for (const s of [secret, token, dashed && dashed[1]]) if (s) out = out.split(s).join('…');
  return out;
}

async function handleFeed(res, { name, envVar, what, load }) {
  const secret = process.env[envVar];
  if (!secret) {
    res.status(503).json({ error: `${envVar} is not configured on this deployment.` });
    return;
  }
  const now = Date.now();
  const hit = feedCache[name];
  if (!hit || hit.secret !== secret || now - hit.at > FEED_CACHE_MS) {
    try {
      feedCache[name] = { secret, at: now, body: await load(secret) };
    } catch (err) {
      // Never "nothing there": a failed read is an error the card shows as one.
      // The secret is only ever in a URL, so scrub it from the message.
      res.status(502).json({ error: `Couldn't read the ${what}: ${scrubSecret(String(err.message), secret)}` });
      return;
    }
  }
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json(feedCache[name].body);
}

async function handlePhotos(req, res, fetchFn, envVar = 'FAM_PHOTOS_ALBUM') {
  const token = process.env[envVar];
  if (!token) {
    res.status(503).json({ error: `${envVar} is not configured on this deployment.` });
    return;
  }
  // A forced refresh is the one login-gated read here (the page shows its button
  // only when logged in); checked before any call to Apple.
  const force = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
  if (force) {
    if (!process.env.SESSION_SECRET) {
      res.status(500).json({ error: 'SESSION_SECRET is not configured on this deployment.' });
      return;
    }
    if (!bearerOk(req)) {
      res.status(401).json({ error: 'Log in again to refresh the album.' });
      return;
    }
  }
  const now = Date.now();
  const cached = photoCaches[envVar];
  if (force || !cached || cached.token !== token || now >= cached.until) {
    try {
      const body = await fetchSharedAlbum(token, fetchFn);
      photoCaches[envVar] = { token, until: now + photoCacheMs(body.expires, now), body };
    } catch (err) {
      // Never "no photos": a failed read is an error the card shows as one, and a
      // failed refresh leaves the earlier cache alone.
      res.status(502).json({ error: `Couldn't read the album: ${scrubSecret(String(err.message), token)}` });
      return;
    }
  }
  res.setHeader('Cache-Control', force ? 'no-store' : 'public, max-age=60');
  res.status(200).json(photoCaches[envVar].body);
}

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
    if (resource === 'fishtrips') {
      if (req.method === 'GET') {
        const stored = await storeGet(store, FISH_TRIPS_KEY);
        res.status(200).json(Array.isArray(stored) ? { trips: stored, seeded: false } : { trips: SEED_TRIPS, seeded: true });
        return;
      }
      const { errors } = validateTrips(req.body);
      if (errors.length) {
        res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
        return;
      }
      const trips = normalizeTrips(req.body.trips);
      await storeSet(store, FISH_TRIPS_KEY, trips);
      res.status(200).json({ trips, seeded: false });
      return;
    }
    if (resource === 'fishlurephoto') {
      if (req.method === 'GET') {
        const id = req.query && req.query.id;
        const stored = isLureId(id) ? await storeGet(store, lurePhotoKey(id)) : null;
        const bytes = decodeLurePhoto(stored);
        if (!bytes) { res.status(404).json({ error: 'No photo.' }); return; }
        // The page's URL carries the version token, so a changed photo is a new URL.
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.status(200);
        res.end(bytes);
        return;
      }
      const body = req.body || {};
      const bytes = decodeLurePhoto(body.image);
      if (!isLureId(body.id) || !bytes) {
        res.status(400).json({ error: 'Nothing was saved — send a lure id and a small JPEG data URL.' });
        return;
      }
      await storeSet(store, lurePhotoKey(body.id), body.image);
      res.status(200).json({ id: body.id, photo: Date.now().toString(36) });
      return;
    }
    if (resource === 'fishlures') {
      if (req.method === 'GET') {
        const stored = await storeGet(store, FISH_LURES_KEY);
        res.status(200).json({ lures: Array.isArray(stored) ? stored : [] });
        return;
      }
      const { errors } = validateLures(req.body);
      if (errors.length) {
        res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
        return;
      }
      const lures = normalizeLures(req.body.lures);
      const before = await storeGet(store, FISH_LURES_KEY);
      await storeSet(store, FISH_LURES_KEY, lures);
      // A lure that was removed, or whose photo was cleared, loses its stored picture.
      // Only now, after the list is saved, so Remove in an unsaved draft never
      // breaks what is live. Best effort: a leftover picture is harmless.
      const keep = new Set(lures.filter((l) => l.photo).map((l) => l.id));
      for (const old of Array.isArray(before) ? before : []) {
        if (old.photo && !keep.has(old.id) && isLureId(old.id)) await storeRelease(store, lurePhotoKey(old.id)).catch(() => {});
      }
      res.status(200).json({ lures });
      return;
    }
    const fish = resource === 'fishtasks' || resource === 'fishquicklinks';
    const quickKey = fish ? FISH_QUICKLINKS_KEY : QUICKLINKS_KEY;
    const tasksKey = fish ? FISH_TASKS_KEY : TASKS_KEY;
    if (resource === 'quicklinks' || resource === 'fishquicklinks') {
      if (req.method === 'GET') {
        res.status(200).json({ links: (await storeGet(store, quickKey)) || [] });
        return;
      }
      const { errors } = validateQuickLinks(req.body);
      if (errors.length) {
        res.status(400).json({ error: 'Nothing was saved — the request was malformed:', details: errors });
        return;
      }
      const links = normalizeQuickLinks(req.body.links);
      await storeSet(store, quickKey, links);
      res.status(200).json({ links });
      return;
    }
    const storedTasks = (await storeGet(store, tasksKey)) || {};
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
    await storeSet(store, tasksKey, nextTasks);
    res.status(200).json({ tasks: nextTasks });
  } catch (err) {
    res.status(502).json({ error: `Store unavailable: ${err.message}` });
  }
}

export default async function handler(req, res, fetchFn = fetch) {
  if (applyCors(req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, Authorization' })) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const resource = req.method === 'GET' ? (req.query && req.query.resource) : (req.body || {}).resource;
  if (req.method === 'GET' && resource === 'photos') {
    await handlePhotos(req, res, fetchFn);
    return;
  }
  if (req.method === 'GET' && resource === 'fishphotos') {
    await handlePhotos(req, res, fetchFn, 'FISH_PHOTOS_ALBUM');
    return;
  }
  if (req.method === 'GET' && resource === 'calendar') {
    // One month at a time (`?month=YYYY-MM`, default this month); each month is
    // cached on its own for the same five minutes.
    const win = monthWindow(req.query && req.query.month);
    if (!win) {
      res.status(400).json({ error: 'Use ?month=YYYY-MM, between 2020 and 2035.' });
      return;
    }
    await handleFeed(res, { name: `calendar:${win.month}`, envVar: 'FAM_CALENDAR_ICS', what: 'calendar', load: (url) => fetchCalendar(url, fetchFn, win).then((cal) => ({ ...cal, month: win.month })) });
    return;
  }
  // Only the store resources exist here; anything else is a mistake.
  if (!['tasks', 'quicklinks', 'fishtasks', 'fishquicklinks', 'fishtrips', 'fishlures', 'fishlurephoto'].includes(resource)) {
    res.status(req.method === 'GET' ? 405 : 400).json({ error: 'Unknown resource: use "tasks", "quicklinks", "fishtasks", "fishquicklinks", "fishtrips", "fishlures", "fishlurephoto" or (GET) "photos" / "fishphotos" / "calendar".' });
    return;
  }

  // Everything but the public quick-links, trip-log, lures and lure-picture reads needs a login.
  if (req.method === 'POST' || resource === 'tasks' || resource === 'fishtasks') {
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
