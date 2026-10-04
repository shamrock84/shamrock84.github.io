// Vercel serverless function: lets the "Last synced" link on the page kick
// off a fresh run of the Sync Fantasy Rosters GitHub Action on demand, instead
// of waiting for the next scheduled run (every 4 hours).
//
// This is a public, unauthenticated endpoint (same as live-scoring.js), so
// it does two things live-scoring doesn't need to: it holds a write-scoped
// GitHub token (GITHUB_DISPATCH_TOKEN — a fine-grained PAT limited to just
// this repo's Actions: write permission, never MFL/ESPN credentials) and
// enforces a cooldown so the page can't be used to hammer the workflow (and
// in turn MFL/ESPN's APIs) by spamming the button or the endpoint directly.
//
// The cooldown lives in the plans Upstash store, not in this module. A
// module-level timestamp was all it used to be, and that never held: it
// resets on every cold start, and two concurrent instances each keep their
// own. And its length is set by how long a sync RUNS, not by how fast a
// person clicks — a run takes 60-120s and the workflow queues dispatches
// rather than dropping them, so the old 2-minute gap let anyone with curl
// keep the sync (and MFL's rate limit, on the manager's account) busy around
// the clock. COOLDOWN_MS is comfortably longer than a run, so the most this
// endpoint can add is one sync per window on top of the 4-hourly schedule.
//
// With no store configured, or the store unreachable, it falls back to the
// old module-level check, so the button keeps working through an outage.

import { applyCors } from './_lib/cors.mjs';
import { storeClaim, storeRelease } from './_lib/store.mjs';
import { resolveStore } from './plans.js';

const OWNER = 'shamrock84';
const REPO = 'shamrock84.github.io';
const WORKFLOW = 'sync-fantasy-rosters.yml';
const REF = 'main';

const COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const COOLDOWN_KEY = 'sync:cooldown';

// Fallback only — see the header. Resets on cold start.
let lastTriggeredAt = 0;

function cooldownRefusal(res, remainingMs) {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  res.status(429).json({
    error: `A sync was requested recently. Manual syncs are limited to one every ${COOLDOWN_MS / 60000} minutes — try again in ${minutes} min.`,
    retryAfterSeconds: Math.ceil(remainingMs / 1000),
  });
}

// Returns { ok: true, release } when this request may dispatch, or
// { ok: false, remainingMs } when it's inside the cooldown. `release` hands
// the cooldown back if the dispatch then fails, so a GitHub hiccup doesn't
// cost the manager ten minutes.
async function takeCooldown() {
  const store = resolveStore(process.env);
  if (store) {
    try {
      const claim = await storeClaim(store, COOLDOWN_KEY, COOLDOWN_MS / 1000);
      if (!claim.claimed) return { ok: false, remainingMs: claim.remainingMs };
      return { ok: true, release: () => storeRelease(store, COOLDOWN_KEY).catch(() => {}) };
    } catch (err) {
      console.error(`trigger-sync: shared cooldown unavailable, using this instance's: ${err.message}`);
    }
  }
  const sinceLast = Date.now() - lastTriggeredAt;
  if (sinceLast < COOLDOWN_MS) return { ok: false, remainingMs: COOLDOWN_MS - sinceLast };
  const previous = lastTriggeredAt;
  lastTriggeredAt = Date.now();
  return { ok: true, release: async () => { lastTriggeredAt = previous; } };
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'POST, OPTIONS' })) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'GITHUB_DISPATCH_TOKEN is not configured on this deployment.' });
    return;
  }

  const cooldown = await takeCooldown();
  if (!cooldown.ok) {
    cooldownRefusal(res, cooldown.remainingMs);
    return;
  }

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: REF }),
      }
    );
    if (!ghRes.ok) {
      const bodyText = await ghRes.text();
      throw new Error(`GitHub API returned ${ghRes.status}: ${bodyText.slice(0, 300)}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    await cooldown.release();
    res.status(502).json({ error: `Failed to trigger sync: ${err.message}` });
  }
}

export { COOLDOWN_MS };
