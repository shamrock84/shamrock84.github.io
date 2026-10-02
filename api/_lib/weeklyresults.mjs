// The logic behind api/weekly-results.js: which NFL week just finished, what
// each provider's raw matchup response says about the manager's own game, and
// how the answers become Pushover messages. Pure — no fetch, no clock, no
// store — so scripts/test-weekly-results.mjs can drive it offline.
//
// Two decisions worth knowing before editing:
//
//   * The finished week comes off the CALENDAR, not a provider. ESPN and
//     Sleeper advance their own "current week" some time early Tuesday and
//     MFL's liveScoring stays on the old week until Wednesday, so asking any
//     of them which week just ended gets different answers depending on the
//     hour. Every provider is then asked for that one week by number.
//   * A league whose result can't be read is listed as unreadable and left out
//     of the overall record, never counted as a loss or dropped silently —
//     a summary that quietly omits a league reads exactly like a complete one.

const DAY_MS = 24 * 60 * 60 * 1000;
// Pushover's hard cap on one message body is 1024 characters; stay under it.
export const PUSHOVER_BODY_LIMIT = 1000;

// The NFL week that has just finished, or null when `now` isn't Tuesday or
// Wednesday of an NFL week (days 5 and 6 counted from the Thursday kickoff).
// Outside that window the answer would be a week still in progress, and a
// stray call must not send a half-played week's "results". `?week=` on the
// endpoint bypasses this deliberately.
export function finishedWeek(now, kickoffMs) {
  const days = Math.floor((now.getTime() - kickoffMs) / DAY_MS);
  if (days < 0) return null;
  const dayOfWeek = days % 7;
  if (dayOfWeek !== 5 && dayOfWeek !== 6) return null;
  const week = Math.floor(days / 7) + 1;
  return week >= 1 && week <= 18 ? week : null;
}

const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// Each parser returns [{ teams: [{ franchiseId, points }] }] — one entry per
// head-to-head game. A team with no opponent (bye, eliminated) is never in a
// pair, which is what makes myResult report "no game" for it.

// MFL weeklyResults. Starters' scores are summed rather than trusting a
// franchise-level total, the same choice parseMflWeekScores makes. A flat
// franchise entry outside `matchup` is a team with no game that week.
export function mflWeekMatchups(data) {
  const sumStarters = (f) => asList(f.player)
    .filter((p) => p.status === 'starter')
    .reduce((sum, p) => sum + (Number(p.score) || 0), 0);
  return asList(data?.weeklyResults?.matchup)
    .map((m) => ({ teams: asList(m.franchise).map((f) => ({ franchiseId: String(f.id), points: sumStarters(f) })) }))
    .filter((m) => m.teams.length > 0);
}

// ESPN mScoreboard's `schedule`, filtered to the one matchup period. A bye has
// only one side present.
export function espnWeekMatchups(data, week) {
  return (data?.schedule || [])
    .filter((m) => m.matchupPeriodId === week)
    .map((m) => ({
      teams: [m.home, m.away]
        .filter(Boolean)
        .map((s) => ({ franchiseId: String(s.teamId), points: Number(s.totalPoints) || 0 })),
    }))
    .filter((m) => m.teams.length > 0);
}

// Sleeper pairs opponents by a shared matchup_id; a missing id stands alone.
export function sleeperWeekMatchups(raw) {
  const groups = new Map();
  let alone = 0;
  for (const m of raw || []) {
    const key = m.matchup_id != null ? `m${m.matchup_id}` : `solo${alone++}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ franchiseId: String(m.roster_id), points: Number(m.points) || 0 });
  }
  return [...groups.values()].map((teams) => ({ teams }));
}

// The manager's own game: { result: 'W'|'L'|'T', points, oppPoints }, or null
// when there is nothing to report — no game (bye), or a pairing where neither
// side has scored, which is a week that hasn't been scored yet rather than
// a 0-0 tie.
export function myResult(matchups, franchiseId) {
  const mine = String(franchiseId);
  for (const m of matchups) {
    const me = m.teams.find((t) => t.franchiseId === mine);
    if (!me) continue;
    const others = m.teams.filter((t) => t !== me);
    if (others.length !== 1) return null;
    const opp = others[0];
    if (me.points === 0 && opp.points === 0) return null;
    const result = me.points > opp.points ? 'W' : me.points < opp.points ? 'L' : 'T';
    return { result, points: me.points, oppPoints: opp.points };
  }
  return null;
}

// The second game of a "weekly median" league (config weeklyMedianGame): the
// manager's score against the average of every team's score that week, taken
// over all the matchups so a bye's score still counts toward the average.
// Same null rule as myResult — a week where nobody has scored isn't a tie.
export function medianResult(matchups, franchiseId) {
  const all = matchups.flatMap((m) => m.teams);
  const me = all.find((t) => t.franchiseId === String(franchiseId));
  if (!me || all.every((t) => t.points === 0)) return null;
  const avg = all.reduce((sum, t) => sum + t.points, 0) / all.length;
  const result = me.points > avg ? 'W' : me.points < avg ? 'L' : 'T';
  return { result, points: me.points, avg };
}

export function recordLabel({ wins, losses, ties }) {
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

const pts = (n) => n.toFixed(2);

// entries: [{ name, result: {result, points}|null, median?: {result, points}|null,
//             record: {wins,losses,ties}|null, error?: string }]
// A weekly-median league has two decisions for the week, each counted in the
// overall record and shown as "W+L". Returns { overall: {wins, losses, ties}, lines: [string] }.
export function summarize(entries) {
  const overall = { wins: 0, losses: 0, ties: 0 };
  const lines = [];
  for (const e of entries) {
    const label = e.name;
    if (e.error) {
      lines.push(`⚠ ${label}: couldn't read (${e.error})`);
      continue;
    }
    const rec = e.record ? ` · ${recordLabel(e.record)}` : '';
    const games = [e.result, e.median].filter(Boolean);
    if (games.length === 0) {
      lines.push(`– ${label}: no game${rec}`);
      continue;
    }
    for (const g of games) {
      if (g.result === 'W') overall.wins++;
      else if (g.result === 'L') overall.losses++;
      else overall.ties++;
    }
    lines.push(`${games.map((g) => g.result).join('+')} ${label} · ${pts(games[0].points)}${rec}`);
  }
  return { overall, lines };
}

// Splits into as many messages as Pushover's cap needs, breaking only between
// lines. The first carries the headline in its title; later ones are numbered.
export function buildMessages(week, entries) {
  const { overall, lines } = summarize(entries);
  const headline = `Week ${week}: ${recordLabel(overall)} overall`;
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > PUSHOVER_BODY_LIMIT && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push('No leagues to report.');
  return chunks.map((body, i) => ({
    title: chunks.length > 1 ? `${headline} (${i + 1}/${chunks.length})` : headline,
    body,
  }));
}
