// Vercel serverless function: lets the "Last synced" link on the page kick
// off a fresh run of the Sync MFL Rosters GitHub Action on demand, instead
// of waiting for the next scheduled run (every 4 hours).
//
// This is a public, unauthenticated endpoint (same as live-scoring.js), so
// it does two things live-scoring doesn't need to: it holds a write-scoped
// GitHub token (GITHUB_DISPATCH_TOKEN — a fine-grained PAT limited to just
// this repo's Actions: write permission, never MFL/ESPN credentials) and
// enforces a cooldown so the page can't be used to hammer the workflow (and
// in turn MFL/ESPN's APIs) by spamming the button or the endpoint directly.

import { applyCors } from './lib/cors.mjs';

const OWNER = 'shamrock84';
const REPO = 'shamrock84.github.io';
const WORKFLOW = 'sync-mfl-rosters.yml';
const REF = 'main';

const COOLDOWN_MS = 2 * 60 * 1000; // 2 min

// Module-level — persists across warm invocations, same caveat as
// live-scoring's cache (resets on cold start, which just means the
// cooldown resets too; not worth a real datastore for this).
let lastTriggeredAt = 0;

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

  const sinceLast = Date.now() - lastTriggeredAt;
  if (sinceLast < COOLDOWN_MS) {
    res.status(429).json({
      error: 'A sync was just triggered. Please wait before trying again.',
      retryAfterSeconds: Math.ceil((COOLDOWN_MS - sinceLast) / 1000),
    });
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
    lastTriggeredAt = Date.now();
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Failed to trigger sync: ${err.message}` });
  }
}
