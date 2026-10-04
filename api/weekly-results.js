// Vercel serverless function: the weekly results push. Called early Tuesday
// (cron-job.org, the same scheduler and the same GAMETIME_CHECK_SECRET as
// api/game-time-check.js) once Monday night's game is over. Sends the
// manager's overall record for the week that just finished across every
// league with a head-to-head schedule, then one line per league: result,
// points scored, season record. Draft-only leagues are left out — one draft,
// no matchups.
//
// Every provider is asked for the finished week BY NUMBER, with the number
// taken off the calendar (api/_lib/weeklyresults.mjs finishedWeek) — see that
// file for why no provider's own "current week" is trusted. The season record
// is a fresh standings read, not the 4-hourly snapshot, so a sync that ran
// before Monday night ended can't leave it a game behind. The snapshot is read
// only for a display-name fallback. Run it after MFL has processed the week (mid-morning
// Eastern is safe); a standings read that hasn't caught up would be a game
// short, and nothing here can tell.
//
// What was sent is recorded per season+week in the plans Upstash store, so a
// scheduler retry or a double-fire sends once. Outside Tuesday/Wednesday it
// does nothing unless ?week= is given.
//
//   ?dryRun=1  build and return the messages as JSON; send and record nothing
//   ?week=N    report that week regardless of the day (also skips the
//              already-sent check, so it can be used to resend)
//
// Environment: GAMETIME_CHECK_SECRET, PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY,
// MFL_USERNAME/MFL_PASSWORD, ESPN_S2/ESPN_SWID, and the Upstash variables —
// all already set for the other endpoints.

import { cronAuthorized } from './_lib/auth.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  mflLogin,
  mflGet,
  seasonOf,
  espnGet,
  fetchSleeperWeekMatchups,
  fetchStandings,
  fetchEspnStandings,
  fetchSleeperStandings,
  setMflRequestInterval,
} from '../scripts/lib/providers.mjs';
import { nflSeasonPhase, nflKickoffUtc } from '../scripts/lib/fantasypros.mjs';
import { resolveStore } from './plans.js';
import { storeGet, storeSet } from './_lib/store.mjs';
import {
  finishedWeek,
  mflWeekMatchups,
  espnWeekMatchups,
  sleeperWeekMatchups,
  myResult,
  medianResult,
  buildMessages,
} from './_lib/weeklyresults.mjs';

// ~15 MFL leagues x 3 requests paced 300ms apart, plus ESPN and Sleeper.
export const config = { maxDuration: 60 };

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const SNAPSHOT_URL = 'https://melbostads.com/data/rosters.json';
const APP_URL = 'https://melbostads.com/myffl.html';
const SENT_TTL_SECONDS = 14 * 24 * 60 * 60;
// A burst of MFL requests is what draws the 429s. This runs unattended on a
// schedule, not behind a user-facing tab like live-scoring.js (300ms), so it
// can afford to be slower: the read has ~25s of headroom under maxDuration.
setMflRequestInterval(600);
// Leagues that still fail after the first pass are retried this many times,
// waiting RETRY_WAIT_MS x round between passes, but only while the read has
// used less than RETRY_DEADLINE_MS of the function's 60s.
const RETRY_ROUNDS = 2;
const RETRY_WAIT_MS = 5000;
const RETRY_DEADLINE_MS = 35000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authorized(req) {
  return cronAuthorized(req, process.env.GAMETIME_CHECK_SECRET);
}

async function pushover({ title, body }) {
  const form = new URLSearchParams({
    token: process.env.PUSHOVER_APP_TOKEN,
    user: process.env.PUSHOVER_USER_KEY,
    title,
    message: body,
    priority: '0',
    url: APP_URL,
    url_title: 'Open MyFFL',
  });
  const res = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: form, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Pushover rejected the message (${res.status}): ${await res.text()}`);
}

// The short Toolbar Label (`nickname`) keeps a line of the report narrow; a
// league without one falls back in the same order as leagueDisplayName in
// myffl.html: a manual override, the live synced league name, the config's own.
function displayName(league, snapshotLeague) {
  return league.nickname || league.displayName || snapshotLeague?.displayName || snapshotLeague?.leagueName || league.name;
}

async function readLeague(league, week, cookie, snapshotLeague) {
  const entry = { name: displayName(league, snapshotLeague), result: null, record: null };
  try {
    let matchups;
    let standings;
    if (league.provider === 'espn') {
      const data = await espnGet(league, `view=mScoreboard&view=mTeam&scoringPeriodId=${week}`);
      matchups = espnWeekMatchups(data, week);
      standings = await fetchEspnStandings(league);
    } else if (league.provider === 'sleeper') {
      matchups = sleeperWeekMatchups(await fetchSleeperWeekMatchups(league, week));
      standings = await fetchSleeperStandings(league);
    } else {
      const data = await mflGet(`/export?TYPE=weeklyResults&L=${league.id}&W=${week}&JSON=1`, cookie, seasonOf(league));
      matchups = mflWeekMatchups(data);
      // Only the manager's own row is read, so the franchise-name map fetchStandings
      // would otherwise pull (a whole extra TYPE=league request) is skipped by
      // handing it an empty one.
      standings = await fetchStandings(league, cookie, { nameById: new Map(), ownerById: new Map() });
    }
    entry.result = myResult(matchups, league.franchiseId);
    if (league.weeklyMedianGame) entry.median = medianResult(matchups, league.franchiseId);
    const me = standings.find((r) => r.isMe);
    if (me) entry.record = { wins: Number(me.wins) || 0, losses: Number(me.losses) || 0, ties: Number(me.ties) || 0 };
  } catch (e) {
    entry.error = String(e.message || e).slice(0, 60);
  }
  return entry;
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
    const startedAt = Date.now();
    const dryRun = !!req.query?.dryRun;
    const now = new Date();
    const { season } = nflSeasonPhase(now);
    const forced = req.query?.week != null;
    const week = forced ? Number(req.query.week) : finishedWeek(now, nflKickoffUtc(season));
    if (!Number.isInteger(week) || week < 1 || week > 18) {
      res.status(200).json({ ok: true, sent: false, reason: forced ? 'week must be 1-18' : 'not Tuesday/Wednesday of an NFL week' });
      return;
    }

    const store = resolveStore(process.env);
    const storeKey = `weeklyresults:sent:${season}:${week}`;
    if (!dryRun) {
      if (!store) throw new Error('No Upstash store is configured, so a sent report cannot be tracked.');
      if (!forced && (await storeGet(store, storeKey))) {
        res.status(200).json({ ok: true, sent: false, reason: 'already sent', week });
        return;
      }
    }

    const leagues = JSON.parse(await readFile(CONFIG_PATH, 'utf8')).leagues.filter((l) => l.franchiseId && l.type !== 'draftonly');
    // Fallback names only: a failed snapshot read costs the synced league name,
    // never the report.
    const snapshot = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const snapshotById = new Map((snapshot?.leagues || []).map((l) => [String(l.id), l]));

    let cookie = null;
    const needsMfl = leagues.some((l) => !l.provider || l.provider === 'mfl');
    let mflError = null;
    if (needsMfl) {
      try {
        cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
      } catch (e) {
        mflError = String(e.message || e).slice(0, 60);
      }
    }

    // All leagues at once, in config order. MFL's own requests are still
    // spaced by the shared pacing gate (setMflRequestInterval above), so the
    // burst it prevents can't happen; what this removes is ESPN, Sleeper and
    // each MFL league waiting in line behind one another's round trips.
    const entries = await Promise.all(leagues.map((league) => {
      const snap = snapshotById.get(String(league.id));
      if (!cookie && (!league.provider || league.provider === 'mfl')) {
        return { name: displayName(league, snap), error: `MFL login failed: ${mflError}` };
      }
      return readLeague(league, week, cookie, snap);
    }));
    // A 429 is MFL saying "not now", not an answer: retry just the leagues that
    // failed, after a pause, before reporting them as unreadable.
    for (let round = 1; round <= RETRY_ROUNDS; round++) {
      const failed = entries.map((e, i) => (e.error ? i : -1)).filter((i) => i >= 0);
      if (failed.length === 0 || Date.now() - startedAt > RETRY_DEADLINE_MS) break;
      await sleep(RETRY_WAIT_MS * round);
      await Promise.all(failed.map(async (i) => {
        const league = leagues[i];
        if (!cookie && (!league.provider || league.provider === 'mfl')) return;
        entries[i] = await readLeague(league, week, cookie, snapshotById.get(String(league.id)));
      }));
    }
    const readMs = Date.now() - startedAt;

    const messages = buildMessages(week, entries);
    if (!dryRun) {
      for (const m of messages) await pushover(m);
      await storeSet(store, storeKey, { at: now.toISOString(), messages: messages.length }, SENT_TTL_SECONDS);
    }
    res.status(200).json({ ok: true, dryRun, week, sent: !dryRun, readMs, totalMs: Date.now() - startedAt, messages });
  } catch (err) {
    // A 500 is what makes cron-job.org's own failure email fire.
    res.status(500).json({ error: err.message });
  }
}
