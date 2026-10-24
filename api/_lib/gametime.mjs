// The decision logic behind api/game-time-check.js: which of the manager's
// starters to check before kickoff, what the feeds say about each one, and
// which push notification (if any) that adds up to. Everything here is pure
// — no fetch, no clock, no store — so scripts/test-game-time-check.mjs can
// drive it offline against the response shapes probe-inactives.mjs actually
// captured.
//
// The rules are the ones probe-inactives.mjs RUN 1 (2026-09-27) measured,
// not guesses — read that header before changing any of them:
//
//   * Check from WATCH_LEAD_MINUTES (45) before kickoff. Every team's
//     inactive list was visible somewhere by T-47; at T-80 only about three
//     of 24 had posted. Same constant as the Game-Time Watchlist card's
//     WATCHLIST_CHECK_LEAD_MINUTES in myffl.html, which says "check at" for
//     the same reason.
//   * INACTIVE if ANY source says so. ESPN's league injuries feed and the
//     per-game summary (details.fantasyStatus "INACTIVE") usually lead, MFL
//     trails by about ten minutes, and each was the laggard for somebody —
//     the summary once showed a ruling 50 minutes after the injuries feed.
//   * PLAYING only on evidence: ESPN's injuries feed flipping him to
//     "Active", or his team's gameday list being visibly posted (some
//     teammate reads INACTIVE in the game summary) with him not on it. A
//     missing Active flag alone proves nothing — Jalen Coker never got one
//     pre-game and played.
//   * Otherwise PENDING — "list not posted yet" — never a guess. The
//     notification says so and a later poll updates it.
//
// The watched set is the manager's starters, read off the synced snapshot the
// same way the watchlist card reads it — never the live poll, which can still
// be on last week before kickoff. Two groups: starters carrying a designation,
// who are always reported; and any other starter the game summary lists
// INACTIVE, a surprise scratch that is reported only when it happens. On top
// of that, a designated BENCH player is reported when the manager has asked
// for him (the watchlist's Notify checkbox, plans.notifyPlans) — and he is
// asked for by default when he is the chosen backup of a designated starter,
// the one benched player whose status decides a swap. See benchNotify.

import { normalizePlayerName } from '../../scripts/lib/fantasypros.mjs';

export const WATCH_LEAD_MINUTES = 45;
// A player still PENDING this close to kickoff gets one last, high-priority
// "check him yourself" rather than silence until lock.
export const FINAL_CALL_MINUTES = 10;

// Designations that already mean he will not play — no feed needs to confirm
// an IR or a Friday "Out". Mirrors myffl.html's INJURY_SETTLED plus O.
const ALREADY_OUT = new Set(['O', 'IR', 'IR R', 'PUP', 'NFI', 'SUSP', 'HOL', 'NA', 'RET']);

const key = (name) => normalizePlayerName(name) || String(name || '').toLowerCase();

// The label the quick-link toolbar uses (quickLinkLabelForLeague in
// myffl.html): short, and the one the manager already reads leagues by.
export function leagueLabel(league) {
  return league.nickname || league.displayName || league.leagueName || league.name || league.id;
}

// Every game kicking off within the watch window, keyed by kickoff ISO. A
// "slot" is one kickoff time — the Sunday 1:00 games are one notification,
// not ten. `games` is fetchNflGames' map, which holds every alias of a team,
// so entries are de-duplicated by event id.
export function slotsInWindow(games, now) {
  const slots = new Map();
  const seen = new Set();
  for (const g of games.values()) {
    if (!g || !g.kickoff || seen.has(`${g.id}:${g.team}`)) continue;
    seen.add(`${g.id}:${g.team}`);
    const mins = (new Date(g.kickoff).getTime() - now.getTime()) / 60000;
    if (g.state !== 'pre' || mins <= 0 || mins > WATCH_LEAD_MINUTES) continue;
    if (!slots.has(g.kickoff)) slots.set(g.kickoff, new Set());
    slots.get(g.kickoff).add(g.id);
  }
  return slots;
}

// The replacement the Game-Time Watchlist card shows for a starter, worked
// out here too because the push has to say it on a phone with no page open.
// DUPLICATED from watchlistBackupFor/watchlistBackupCandidates/
// watchlistSuggestedBackup in myffl.html (no build step, no shared import),
// and pinned against the page's own functions by test-game-time-check.mjs
// over one fixture, so a drift fails there rather than quietly telling the
// phone one name and the page another.
//
// `saved` is the manager's own pick from the plans store (backupPlans[league]
// [starter id]): a bench player's id, 'none' for "deliberately no backup", or
// absent for "never chosen". Never chosen reads as the suggestion — the
// best-ECR HEALTHY bench player at the starter's own position, and nobody
// otherwise, since a designated or off-position default is a judgement the
// manager makes, not one made for him in a push. A saved pick no longer on the
// roster falls back to the suggestion, exactly as the card does.
export const NO_BACKUP = 'none';

// Only a player whose game kicks off after WATCH_LEAD_MINUTES before the
// starter's (the moment the injury is known; so a 3:05 player can still
// replace a 3:15 starter) qualifies; a
// missing kickoff for the starter (or no `games`) filters nothing. Mirrors
// the page's playsInTime.
// Slot-rule gate, DUPLICATED from swapKeepsLineupLegal/parseLineupBounds in
// myffl.html: the swap must leave every position inside the league's
// startingLineup range ("1 QB, 2-3 RB, ..."). No requirement string, or an
// unresolved starter id, filters nothing on counts.
function lineupKey(position) {
  const k = String(position || '').trim().toUpperCase();
  if (k === 'K') return 'PK';
  if (k === 'DST' || k === 'D/ST' || k === 'DEF') return 'DEF';
  return k;
}
function lineupBounds(requirement) {
  if (!requirement) return null;
  const bounds = new Map();
  for (const m of String(requirement).matchAll(/(\d+)(?:\s*-\s*(\d+))?\s+([A-Za-z/]+)/g)) {
    const min = Number(m[1]);
    bounds.set(lineupKey(m[3]), { min, max: m[2] != null ? Number(m[2]) : min });
  }
  return bounds.size ? bounds : null;
}
function swapKeepsLineupLegal(league, starter, candidate) {
  const bounds = lineupBounds(league.startingLineup);
  if (!bounds || !starter) return true;
  const out = lineupKey(starter.position);
  const inn = lineupKey(candidate.position);
  if (out === inn) return true;
  const into = bounds.get(inn);
  if (!into || into.max < 1) return false;
  const byId = new Map((league.players || []).map((p) => [String(p.id), p]));
  const counts = new Map();
  for (const id of league.starters || []) {
    const sp = byId.get(String(id));
    if (!sp) return true;
    const k = lineupKey(sp.position);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if ((counts.get(inn) || 0) + 1 > into.max) return false;
  const from = bounds.get(out);
  if (from && (counts.get(out) || 0) - 1 < from.min) return false;
  return true;
}

function backupCandidates(league, starter, games) {
  const starting = new Set((league.starters || []).map(String));
  const startAt = starter.team && games?.get(starter.team)?.kickoff
    ? new Date(games.get(starter.team).kickoff).getTime() : NaN;
  const playsInTime = (p) => {
    if (Number.isNaN(startAt)) return true;
    const at = p.team && games.get(p.team)?.kickoff ? new Date(games.get(p.team).kickoff).getTime() : NaN;
    return !Number.isNaN(at) && at > startAt - WATCH_LEAD_MINUTES * 60000;
  };
  const samePos = (p) => (p.position && starter.position && p.position === starter.position ? 0 : 1);
  const ecr = (p) => (p.ecr && Number.isFinite(p.ecr.rank) ? p.ecr.rank : Infinity);
  return (league.players || [])
    .filter((p) => (p.status || 'ROSTER').toUpperCase() === 'ROSTER' && !starting.has(String(p.id)) && playsInTime(p) && swapKeepsLineupLegal(league, starter, p))
    .sort((a, b) => samePos(a) - samePos(b)
      || (a.injuryStatus ? 1 : 0) - (b.injuryStatus ? 1 : 0)
      || (ecr(a) === ecr(b) ? 0 : ecr(a) < ecr(b) ? -1 : 1)
      || String(a.name).localeCompare(String(b.name)));
}

export function resolveBackup(league, starter, saved, games) {
  if (saved === NO_BACKUP) return { player: null, source: 'none' };
  const candidates = backupCandidates(league, starter, games);
  const chosen = saved && candidates.find((c) => String(c.id) === String(saved));
  if (chosen) return { player: chosen, source: 'chosen' };
  const first = candidates[0];
  if (first && !first.injuryStatus && first.position && first.position === starter.position) {
    return { player: first, source: 'suggested' };
  }
  return { player: null, source: 'none' };
}

// Whether the push covers a designated bench player in this league, and
// whom he is the chosen backup for. DUPLICATED from watchlistBenchNotify in
// myffl.html and pinned against it by test-game-time-check.mjs, for the same
// reason as resolveBackup.
//
// `notifyPlans[league][player id]` is the manager's explicit answer: 'on' or
// 'off'; absent means "follow the default". The default is on exactly when he
// is the manager's CHOSEN backup (a saved pick, never the suggestion — a
// suggestion is healthy by construction, so it could never be designated) for
// a starter who carries a designation, since that is the swap his own status
// bears on. A saved pick for a starter who is healthy now is stale, not a plan.
export function benchNotify(league, bench, plans, games) {
  const starting = new Set((league.starters || []).map(String));
  const backupFor = [];
  for (const s of league.players || []) {
    if (!s.injuryStatus || !starting.has(String(s.id))) continue;
    const saved = plans?.backupPlans?.[league.id]?.[s.id];
    if (!saved || saved === NO_BACKUP) continue;
    const { player, source } = resolveBackup(league, s, saved, games);
    if (source === 'chosen' && String(player.id) === String(bench.id)) backupFor.push(s.name);
  }
  const choice = plans?.notifyPlans?.[league.id]?.[bench.id];
  const on = choice === 'on' ? true : choice === 'off' ? false : backupFor.length > 0;
  return { on, backupFor };
}

// Starters in games at `kickoff`, from the snapshot, plus designated bench
// players the manager is notified about (benchNotify). One entry per player
// (normalized name + scoreboard team), carrying every league that starts him
// (`leagues`) or benches him with notify on (`benchLeagues`), and any MFL id
// seen, so MFL's by-id injury map can be joined exactly. A row with no
// `leagues` is bench-only: nothing to swap, only something to know.
export function startersForSlot(snapshot, games, kickoff, plans = null) {
  const out = new Map();
  const year = Number(snapshot?.year);
  for (const league of snapshot?.leagues || []) {
    if (league.type === 'draftonly') continue;
    if (!Array.isArray(league.starters) || league.lineupWeek == null) continue;
    if (league.draftInProgress === true) continue;
    if (Number(league.season) < year) continue;
    const byId = new Map((league.players || []).map((p) => [String(p.id), p]));
    const starting = new Set(league.starters.map(String));
    const rowFor = (p, game) => {
      const k = `${key(p.name)}|${game.team}`;
      if (!out.has(k)) {
        out.set(k, { key: k, name: p.name, team: game.team, designation: null, mflIds: new Set(), leagues: [], backups: [], benchLeagues: [] });
      }
      const row = out.get(k);
      if (p.injuryStatus && !row.designation) row.designation = p.injuryStatus;
      if (!league.provider || league.provider === 'mfl') row.mflIds.add(String(p.id));
      return row;
    };
    for (const id of league.starters) {
      const p = byId.get(String(id));
      if (!p || !p.team) continue;
      const game = games.get(p.team);
      if (!game || game.kickoff !== kickoff) continue;
      const row = rowFor(p, game);
      row.leagues.push(leagueLabel(league));
      // Per league, because the bench behind him is each league's own. A
      // backup whose game has already kicked off is flagged rather than
      // dropped: he is still the pick, but the lineup slot is locked.
      const { player: b } = resolveBackup(league, p, plans?.backupPlans?.[league.id]?.[p.id], games);
      const bGame = b?.team ? games.get(b.team) : null;
      row.backups.push({
        league: leagueLabel(league),
        backup: b ? { name: b.name, position: b.position || null, team: b.team || null, locked: !!bGame && bGame.state !== 'pre' } : null,
      });
    }
    // Bench players ride along only with a designation and only when asked
    // for. Active Roster only, like the card: taxi and IR can't play this week.
    for (const p of league.players || []) {
      if (starting.has(String(p.id)) || (p.status || 'ROSTER').toUpperCase() !== 'ROSTER') continue;
      if (!p.injuryStatus || !p.team) continue;
      const game = games.get(p.team);
      if (!game || game.kickoff !== kickoff) continue;
      const { on, backupFor } = benchNotify(league, p, plans, games);
      if (!on) continue;
      rowFor(p, game).benchLeagues.push({ league: leagueLabel(league), backupFor });
    }
  }
  return out;
}

// ESPN's league-wide injuries feed (site.api.espn.com/.../nfl/injuries):
// normalized name -> { status, team }. The team is read off the athlete or
// its block, whichever the response carries; null means join on name alone.
export function parseEspnInjuries(json) {
  const out = new Map();
  for (const block of json?.injuries || []) {
    for (const inj of block.injuries || []) {
      const name = inj.athlete?.displayName || inj.athlete?.fullName;
      if (!name) continue;
      out.set(key(name), {
        status: inj.status || null,
        team: inj.athlete?.team?.abbreviation || block.team?.abbreviation || null,
      });
    }
  }
  return out;
}

// One game's summary (site.api.espn.com/.../summary?event=ID): each injured
// player's status and fantasyStatus, plus which teams have visibly posted
// their gameday list — any player on that team reading INACTIVE.
export function parseEspnSummary(json) {
  const byName = new Map();
  const teamsPosted = new Set();
  for (const block of json?.injuries || []) {
    const team = block.team?.abbreviation || null;
    for (const inj of block.injuries || []) {
      const name = inj.athlete?.displayName || inj.athlete?.fullName;
      if (!name) continue;
      const fantasy = inj.details?.fantasyStatus?.abbreviation || inj.details?.fantasyStatus?.description || null;
      const t = inj.athlete?.team?.abbreviation || team;
      byName.set(key(name), { status: inj.status || null, fantasy, team: t });
      if (t && /^INACTIVE$/i.test(fantasy || '')) teamsPosted.add(t);
    }
  }
  return { byName, teamsPosted };
}

const sameTeam = (a, b) => !a || !b || a === b;
const isOut = (s) => /^(out|inactive)$/i.test(String(s || '').trim());

// The verdict for one watched starter. `feeds` = { espnInjuries (Map),
// summary ({byName, teamsPosted} merged across the slot's games), mfl (Map of
// MFL id -> {status}) }. Any feed may be missing — a failed fetch degrades to
// fewer signals, never to a false "playing".
export function classify(player, feeds) {
  const k = key(player.name);
  const reasons = [];
  if (player.designation && ALREADY_OUT.has(player.designation)) {
    return { state: 'inactive', why: `listed ${player.designation}` };
  }
  const sum = feeds.summary?.byName.get(k);
  const inj = feeds.espnInjuries?.get(k);
  const mflRows = [...player.mflIds].map((id) => feeds.mfl?.get(id)).filter(Boolean);
  if (sum && sameTeam(sum.team, player.team) && (isOut(sum.fantasy) || isOut(sum.status))) reasons.push('ESPN game page');
  if (inj && sameTeam(inj.team, player.team) && isOut(inj.status)) reasons.push('ESPN injuries');
  if (mflRows.some((r) => ALREADY_OUT.has(r.status))) reasons.push('MFL');
  if (reasons.length) return { state: 'inactive', why: `ruled out (${reasons.join(', ')})` };

  if (inj && sameTeam(inj.team, player.team) && /^active$/i.test(inj.status || '')) {
    return { state: 'active', why: 'ESPN lists him Active' };
  }
  if (feeds.summary?.teamsPosted.has(player.team)) {
    return { state: 'active', why: `not on ${player.team}'s inactive list` };
  }
  return { state: 'pending', why: `${player.team}'s inactive list not posted yet` };
}

// Which players this slot is about: every designated starter, plus any
// undesignated starter who turned up inactive.
export function watchedForSlot(starters, feeds) {
  const out = [];
  for (const p of starters.values()) {
    const verdict = classify(p, feeds);
    if (p.designation || verdict.state === 'inactive') out.push({ ...p, ...verdict });
  }
  const order = { inactive: 0, pending: 1, active: 2 };
  return out.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
}

// What to send, given what was already sent for this slot. `sent` is the
// stored { players: {key: state}, finalCall: bool } (or null the first time).
// Rules:
//   * First look at a slot with anyone watched: one message covering all of
//     them, even when every one of them is playing — silence has to mean
//     "the checker is broken", never "all clear".
//   * After that, a message only when someone's state changes.
//   * Inside FINAL_CALL_MINUTES, one last message if anyone is still pending.
// Returns { message: {title, body, priority} | null, next: newSentState }.
function backupText(b) {
  if (!b) return 'no backup picked';
  const tag = [b.position, b.team].filter(Boolean).join(' ');
  return `${b.name}${tag ? ` (${tag})` : ''}${b.locked ? ' — game already started' : ''}`;
}

export function planMessage(watched, sent, minutesToKickoff, whenLabel) {
  const prev = sent?.players || {};
  const next = { players: { ...prev }, finalCall: !!sent?.finalCall };
  for (const p of watched) next.players[p.key] = p.state;
  if (watched.length === 0) return { message: null, next };

  const first = !sent;
  // A player new to the slot since the last message (a surprise scratch)
  // counts as a change too: prev[key] is undefined, which differs.
  const changed = first ? [] : watched.filter((p) => prev[p.key] !== p.state);
  // A bench-only row has no swap riding on it, so it never raises the final
  // call, the high priority, or "lineup change needed" — it is told, not chased.
  const benchOnly = (p) => (p.benchLeagues?.length || 0) > 0 && p.leagues.length === 0;
  const pending = watched.filter((p) => p.state === 'pending' && !benchOnly(p));
  const finalCall = !next.finalCall && pending.length > 0 && minutesToKickoff <= FINAL_CALL_MINUTES;
  if (finalCall) next.finalCall = true;
  if (!first && changed.length === 0 && !finalCall) return { message: null, next };

  const rows = first || finalCall ? watched : changed;
  const line = (p) => {
    const icon = p.state === 'inactive' ? '❌' : p.state === 'active' ? '✅' : '⏳';
    const verb = p.state === 'inactive' ? (benchOnly(p) ? 'OUT' : 'OUT — swap him') : p.state === 'active' ? 'playing' : 'not known yet';
    const tag = p.designation ? ` (${p.designation})` : '';
    // An OUT starter is the one the manager has to act on, so only that line
    // names who goes in — per league, since each has its own bench. The rest
    // keep the plain league list. Older callers without `backups` do too.
    const starts = p.state === 'inactive' && p.backups?.length
      ? p.backups.map(({ league, backup }) => `${league} → ${backupText(backup)}`).join('; ')
      : p.leagues.join(', ');
    // Bench copies say so, and say whose backup he is when that is why he is
    // here — an OUT backup is the news, not the bench slot.
    const benched = (p.benchLeagues || [])
      .map(({ league, backupFor }) => `bench in ${league}${backupFor?.length ? ` (backup for ${backupFor.join(', ')})` : ''}`)
      .join('; ');
    const where = [starts, benched].filter(Boolean).join('; ');
    return `${icon} ${p.name} ${p.team}${tag}: ${verb} — ${p.why}. ${where}`;
  };
  const anyOut = rows.some((p) => p.state === 'inactive' && !benchOnly(p));
  let title;
  if (finalCall) title = `${whenLabel} kickoff: still no word on ${pending.length} — check manually`;
  else if (first) title = anyOut ? `${whenLabel} kickoff: lineup change needed` : `${whenLabel} kickoff: ${watched.length} checked`;
  else title = `${whenLabel} kickoff: update`;
  return {
    message: { title, body: rows.map(line).join('\n'), priority: anyOut || finalCall ? 1 : 0 },
    next,
  };
}
