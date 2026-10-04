// Vercel serverless function: the game-time injury checker. Called every five
// minutes by an external scheduler (cron-job.org — Vercel's Hobby cron runs
// once a day, and GitHub Actions cron is routinely 5-30+ minutes late, both
// useless for a 45-minute window). For each kickoff inside that window it
// checks the manager's starters against the gameday inactive feeds and sends
// the answer to his phone through Pushover, instead of him setting an alarm
// to go look. All the decisions live in api/_lib/gametime.mjs; this file only
// fetches, stores and sends.
//
// Cheap when there's nothing to do, which is almost always: the scoreboard is
// read first, and unless some game kicks off within WATCH_LEAD_MINUTES the
// function returns before touching the 600KB snapshot, MFL or the store.
//
// What was sent per kickoff slot is kept in the same Upstash store as the
// plans (resolveStore), under its own key with a two-day expiry, so a poll
// every five minutes only notifies on a change. A Pushover failure leaves the
// record unwritten, so the next poll retries the same message.
//
// Protected by GAMETIME_CHECK_SECRET, sent as an Authorization: Bearer header
// (never ?key=, which is refused — see cronAuthorized in _lib/auth.mjs) —
// otherwise anyone could make the manager's phone buzz. Two extra modes:
//   ?test=1    send a one-line test notification (checks the Pushover keys)
//   ?dryRun=1  run the whole check for the current window, return what it
//              WOULD send as JSON, and neither notify nor record anything.
//
// Environment (Vercel project settings, never the repo):
//   GAMETIME_CHECK_SECRET, PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY (required)
//   ALERT_TIMEZONE (optional, default America/New_York — times in the message
//     are built here, on a UTC server, so the zone has to be named)
//   MFL_USERNAME/MFL_PASSWORD and the Upstash variables, already set for the
//     other endpoints.

import { cronAuthorized } from './_lib/auth.mjs';
import { mflLogin, fetchMflInjuries, fetchNflGames } from '../scripts/lib/providers.mjs';
import { resolveStore, PLANS_KEY } from './plans.js';
import { storeGet, storeSet } from './_lib/store.mjs';
import {
  WATCH_LEAD_MINUTES,
  slotsInWindow,
  startersForSlot,
  parseEspnInjuries,
  parseEspnSummary,
  watchedForSlot,
  planMessage,
} from './_lib/gametime.mjs';

export const config = { maxDuration: 30 };

const SNAPSHOT_URL = 'https://melbostads.com/data/rosters.json';
const WATCHLIST_URL = 'https://melbostads.com/myffl.html#watchlist';
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const SENT_TTL_SECONDS = 2 * 24 * 60 * 60;

// Same warm-instance cache idea as live-scoring.js: a login per poll would be
// wasteful, and a cold start just logs in again.
const cache = { mflCookie: null, mflCookieAt: 0 };
const MFL_COOKIE_TTL_MS = 20 * 60 * 1000;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function mflInjuries() {
  const { MFL_USERNAME: u, MFL_PASSWORD: p } = process.env;
  if (!u || !p) return null;
  if (!cache.mflCookie || Date.now() - cache.mflCookieAt > MFL_COOKIE_TTL_MS) {
    cache.mflCookie = await mflLogin(u, p);
    cache.mflCookieAt = Date.now();
  }
  return fetchMflInjuries(cache.mflCookie);
}

async function pushover({ title, body, priority }) {
  const form = new URLSearchParams({
    token: process.env.PUSHOVER_APP_TOKEN,
    user: process.env.PUSHOVER_USER_KEY,
    title,
    // Pushover refuses a message over 1024 characters, and a refusal here
    // leaves the slot unrecorded so every later poll retries the same too-long
    // body forever. Truncated rather than risked.
    message: body.length > 1024 ? `${body.slice(0, 1021)}...` : body,
    priority: String(priority ?? 0),
    url: WATCHLIST_URL,
    url_title: 'Open the Game-Time Watchlist',
  });
  const res = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Pushover rejected the message (${res.status}): ${await res.text()}`);
}

function whenLabel(kickoff) {
  const tz = process.env.ALERT_TIMEZONE || 'America/New_York';
  const at = new Date(kickoff);
  const day = at.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const time = at.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
}

function authorized(req) {
  return cronAuthorized(req, process.env.GAMETIME_CHECK_SECRET);
}

export default async function handler(req, res) {
  if (!process.env.GAMETIME_CHECK_SECRET) {
    res.status(500).json({ error: 'GAMETIME_CHECK_SECRET is not configured on this deployment.' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!process.env.PUSHOVER_APP_TOKEN || !process.env.PUSHOVER_USER_KEY) {
    res.status(500).json({ error: 'PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY must both be configured.' });
    return;
  }

  try {
    if (req.query?.test) {
      await pushover({ title: 'Game-time checker', body: 'Test notification — Pushover is wired up.', priority: 0 });
      res.status(200).json({ ok: true, sent: 'test' });
      return;
    }

    const dryRun = !!req.query?.dryRun;
    const now = new Date();
    const games = await fetchNflGames();
    const slots = slotsInWindow(games, now);
    if (slots.size === 0) {
      res.status(200).json({ ok: true, slots: 0, windowMinutes: WATCH_LEAD_MINUTES });
      return;
    }

    const store = resolveStore(process.env);
    if (!store && !dryRun) throw new Error('No Upstash store is configured, so sent notifications cannot be tracked.');

    const snapshot = await getJson(`${SNAPSHOT_URL}?t=${Date.now()}`);
    // Each feed is optional: a failure costs its signal, never the check.
    // classify() treats a missing feed as fewer reasons, never as "playing".
    const feedErrors = [];
    const espnInjuries = await getJson(`${ESPN_SITE}/injuries`).then(parseEspnInjuries).catch((e) => { feedErrors.push(`ESPN injuries: ${e.message}`); return null; });
    const mfl = await mflInjuries().catch((e) => { feedErrors.push(`MFL: ${e.message}`); return null; });
    // The manager's replacement picks (backupPlans), so an OUT line can say who
    // goes in. Optional like every feed: unreadable plans cost the picks, and
    // the message falls back to the suggestion rather than failing the check.
    const plans = store ? await storeGet(store, PLANS_KEY).catch((e) => { feedErrors.push(`Plans: ${e.message}`); return null; }) : null;

    const results = [];
    for (const [kickoff, eventIds] of slots) {
      const summary = { byName: new Map(), teamsPosted: new Set() };
      for (const id of eventIds) {
        try {
          const s = parseEspnSummary(await getJson(`${ESPN_SITE}/summary?event=${id}`));
          for (const [k, v] of s.byName) summary.byName.set(k, v);
          for (const t of s.teamsPosted) summary.teamsPosted.add(t);
        } catch (e) {
          feedErrors.push(`ESPN summary ${id}: ${e.message}`);
        }
      }
      const watched = watchedForSlot(startersForSlot(snapshot, games, kickoff, plans), { espnInjuries, summary, mfl });
      const storeKey = `gametime:sent:${kickoff}`;
      const sent = store ? await storeGet(store, storeKey) : null;
      const minutes = (new Date(kickoff).getTime() - now.getTime()) / 60000;
      const { message, next } = planMessage(watched, dryRun ? null : sent, minutes, whenLabel(kickoff));
      if (message && feedErrors.length) message.body += `\n(Some feeds failed: ${feedErrors.join('; ')})`;
      if (message && !dryRun) {
        await pushover(message);
        await storeSet(store, storeKey, next, SENT_TTL_SECONDS);
      }
      results.push({
        kickoff,
        minutesToKickoff: Math.round(minutes),
        watched: watched.map(({ name, team, designation, state, why, leagues, backups }) => ({ name, team, designation, state, why, leagues, backups })),
        message,
      });
    }
    res.status(200).json({ ok: true, dryRun, feedErrors, slots: results });
  } catch (err) {
    // A 500 is what makes cron-job.org's own failure email fire — the other
    // half of "silence must never mean all clear".
    res.status(500).json({ error: err.message });
  }
}
