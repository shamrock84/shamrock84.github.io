// Vercel serverless function: stores the roster planning values — planned
// contract lengths, planned salaries, planned cuts, and manually-confirmed
// Results corrections — server-side so they follow the manager between
// devices instead of living in one browser's localStorage.
//
// Why this exists: plans were browser-local from the start, which meant an
// iPad and a phone kept entirely separate copies and neither knew about the
// other. That reads as data loss even though nothing was lost.
//
// Requires a valid Bearer token from api/login.js — the same stateless token
// the lineup editor and the Admin tab use. A plan is strategy (see
// plannedSalary in myffl.html: they're withheld from logged-out viewers
// precisely because anyone can open a card), so this endpoint must never
// answer an unauthenticated read. That is also why the plans are NOT kept in
// the repo the way config/leagues.json is — this repository is public, and
// committing them would publish exactly what the logged-out gate hides.
//
// Needs an Upstash Redis store connected to the Vercel project (Storage ->
// Marketplace -> Upstash -> Redis; Vercel's own first-party "KV" product is
// retired and no longer offered in that dialog). Spoken to over its REST API
// with plain fetch rather than an SDK, to keep the project's no-dependency
// property intact — which is also why it has to be Upstash rather than the
// marketplace's "Redis" entry: that one hands back a redis:// connection
// string, and speaking that protocol would mean taking on a client library.
//
// The credentials are read under either name Vercel might inject them as,
// since the integration has used both: KV_REST_API_URL/KV_REST_API_TOKEN and
// UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN. Accepting both removes a
// setup step that otherwise fails with a 500 and no obvious cause.
//
// The site password gates a single account, so there is one plan document,
// not one per user. PLANS_KEY is that document.

import { verifyToken } from './lib/auth.mjs';
import { applyCors } from './lib/cors.mjs';

const PLANS_KEY = 'myffl:plans';

// Bounds, so a malformed or hostile client can't push an unbounded blob into
// the store. Comfortably above any real roster: 18 leagues x ~30 players is
// ~540 entries per kind.
const MAX_LEAGUES = 200;
const MAX_ENTRIES_PER_LEAGUE = 400;
const MAX_VALUE_LENGTH = 8;
const MAX_BODY_BYTES = 256 * 1024;

// resultOverrides is keyed leagueId -> year -> the manager's confirmed rank
// (a string, same shape as every other plan kind — see setResultOverride in
// myffl.html). Presence of an entry IS its confirmation; there is no
// separate confirmed flag to validate here.
const PLAN_KINDS = ['contractPlans', 'salaryPlans', 'cutPlans', 'resultOverrides'];

// Exported for the unit test in scripts/test-plans.mjs. Vercel only ever
// invokes the default export, so extra named exports cost nothing at runtime.
export { validatePlans, mergePlans, emptyDocument, resolveStore };

// The Upstash integration has injected its REST credentials under two
// different prefixes over time, and which one a project gets depends on when
// and how the store was connected. Take either, preferring the KV_* pair
// since a project carrying both got them from the Vercel-managed side.
// Returns null when neither pair is fully present — a half-configured pair is
// treated as absent rather than used, so the failure is the clear "not
// configured" message instead of a fetch to `undefined/get/...`.
function resolveStore(env) {
	const pairs = [
		[env.KV_REST_API_URL, env.KV_REST_API_TOKEN],
		[env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN],
	];
	for (const [url, token] of pairs) {
		if (url && token) return { url: url.replace(/\/+$/, ''), token };
	}
	return null;
}

function emptyDocument() {
  return { contractPlans: {}, salaryPlans: {}, cutPlans: {}, resultOverrides: {}, updatedAt: null };
}

// Returns an array of human-readable problems — empty means valid.
// Deliberately shape-only: what counts as a sensible contract length or
// salary is the page's business and changes with league settings, but the
// shape (leagueId -> playerId -> short string) is what the store depends on.
function validatePlans(plans) {
  const errors = [];
  if (plans === null || typeof plans !== 'object' || Array.isArray(plans)) {
    return ['plans must be an object'];
  }
  for (const kind of PLAN_KINDS) {
    const byLeague = plans[kind];
    if (byLeague === undefined) continue;
    if (byLeague === null || typeof byLeague !== 'object' || Array.isArray(byLeague)) {
      errors.push(`${kind} must be an object`);
      continue;
    }
    const leagueIds = Object.keys(byLeague);
    if (leagueIds.length > MAX_LEAGUES) {
      errors.push(`${kind} has more than ${MAX_LEAGUES} leagues`);
      continue;
    }
    for (const leagueId of leagueIds) {
      const entries = byLeague[leagueId];
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
        errors.push(`${kind}.${leagueId} must be an object`);
        continue;
      }
      const playerIds = Object.keys(entries);
      if (playerIds.length > MAX_ENTRIES_PER_LEAGUE) {
        errors.push(`${kind}.${leagueId} has more than ${MAX_ENTRIES_PER_LEAGUE} entries`);
        continue;
      }
      for (const playerId of playerIds) {
        const value = entries[playerId];
        // Numbers are accepted and normalised by mergePlans — older browsers
        // wrote them before the value was consistently a string.
        const asString = typeof value === 'number' ? String(value) : value;
        if (typeof asString !== 'string') {
          errors.push(`${kind}.${leagueId}.${playerId} must be a string`);
        } else if (asString.length > MAX_VALUE_LENGTH) {
          errors.push(`${kind}.${leagueId}.${playerId} is too long`);
        }
      }
    }
  }
  return errors;
}

// Union of two plan documents, two levels deep, with `stored` winning any
// key present on both.
//
// Direction matters and is the whole point of the merge mode. A device that
// has never synced posts a local document that may be empty; if that replaced
// what's stored, opening the page on a second device would wipe the plans
// made on the first — which is the exact failure this endpoint exists to fix.
// Union can't destroy anything, so it's what a first load uses.
//
// Stored wins ties because it came from whichever device wrote most recently,
// while an unsynced local value may be arbitrarily old. The cost is that a
// plan cleared on a device that hasn't synced since could come back on its
// next load; a subsequent change on that device then pushes the deletion
// through, because every change after the first load posts in replace mode.
function mergePlans(stored, incoming) {
  const out = emptyDocument();
  for (const kind of PLAN_KINDS) {
    const merged = {};
    const a = (incoming && incoming[kind]) || {};
    const b = (stored && stored[kind]) || {};
    for (const leagueId of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const entries = { ...normaliseEntries(a[leagueId]), ...normaliseEntries(b[leagueId]) };
      // An empty league object is noise — drop it so the document doesn't
      // accumulate a key per league ever touched.
      if (Object.keys(entries).length > 0) merged[leagueId] = entries;
    }
    out[kind] = merged;
  }
  return out;
}

// Values are strings everywhere the page reads them; a stray number from an
// older write would otherwise compare and render differently. Empty values
// mean "no plan" and are dropped rather than stored as blanks.
function normaliseEntries(entries) {
  const out = {};
  if (!entries || typeof entries !== 'object') return out;
  for (const [playerId, value] of Object.entries(entries)) {
    const asString = typeof value === 'number' ? String(value) : value;
    if (typeof asString === 'string' && asString !== '') out[playerId] = asString;
  }
  return out;
}

async function kvGet(url, token) {
  const res = await fetch(`${url}/get/${encodeURIComponent(PLANS_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Store read failed (${res.status})`);
  const json = await res.json();
  if (json.result === null || json.result === undefined) return emptyDocument();
  try {
    const parsed = typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
    return { ...emptyDocument(), ...parsed };
  } catch {
    // A corrupt document is not worth failing a read over — the page would
    // lose its plans entirely rather than just this one stale copy. Treat it
    // as empty and let the next write replace it.
    return emptyDocument();
  }
}

async function kvSet(url, token, document) {
  const res = await fetch(`${url}/set/${encodeURIComponent(PLANS_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(document),
  });
  if (!res.ok) throw new Error(`Store write failed (${res.status})`);
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, Authorization' })) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
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

  const store = resolveStore(process.env);
  if (!store) {
    res.status(500).json({
      error: 'No plan store is configured on this deployment. Connect an Upstash Redis store to the Vercel project (Storage → Marketplace → Upstash → Redis) so that either KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN is set, then redeploy.',
    });
    return;
  }
  const kvUrl = store.url;
  const kvToken = store.token;

  try {
    if (req.method === 'GET') {
      res.status(200).json({ plans: await kvGet(kvUrl, kvToken) });
      return;
    }

    const body = req.body || {};
    const incoming = body.plans;
    const mode = body.mode === 'replace' ? 'replace' : 'merge';

    if (JSON.stringify(incoming || {}).length > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Plans payload is too large.' });
      return;
    }
    const errors = validatePlans(incoming);
    if (errors.length) {
      res.status(400).json({ error: 'Nothing was saved — the plans were malformed:', details: errors });
      return;
    }

    const stored = await kvGet(kvUrl, kvToken);
    // Replace still goes through mergePlans with an empty document, so the
    // normalising and empty-league pruning happen on exactly one path.
    const next = mode === 'merge'
      ? mergePlans(stored, incoming)
      : mergePlans(emptyDocument(), incoming);
    next.updatedAt = Date.now();

    await kvSet(kvUrl, kvToken, next);
    res.status(200).json({ plans: next });
  } catch (err) {
    // The page keeps a local copy and carries on when this fails, so a store
    // outage degrades to what the site did before this endpoint existed
    // rather than breaking the roster view.
    res.status(502).json({ error: `Plan store unavailable: ${err.message}` });
  }
}
