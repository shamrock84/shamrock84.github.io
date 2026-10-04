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
// The watched set is starters only (the manager's explicit scope), read off
// the synced snapshot the same way the watchlist card reads it — never the
// live poll, which can still be on last week before kickoff. Two groups:
// starters carrying a designation, who are always reported; and any other
// starter the game summary lists INACTIVE, a surprise scratch that is
// reported only when it happens.

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

function backupCandidates(league, starter) {
  const starting = new Set((league.starters || []).map(String));
  const samePos = (p) => (p.position && starter.position && p.position === starter.position ? 0 : 1);
  const ecr = (p) => (p.ecr && Number.isFinite(p.ecr.rank) ? p.ecr.rank : Infinity);
  return (league.players || [])
    .filter((p) => (p.status || 'ROSTER').toUpperCase() === 'ROSTER' && !starting.has(String(p.id)))
    .sort((a, b) => samePos(a) - samePos(b)
      || (a.injuryStatus ? 1 : 0) - (b.injuryStatus ? 1 : 0)
      || (ecr(a) === ecr(b) ? 0 : ecr(a) < ecr(b) ? -1 : 1)
      || String(a.name).localeCompare(String(b.name)));
}

export function resolveBackup(league, starter, saved) {
  if (saved === NO_BACKUP) return { player: null, source: 'none' };
  const candidates = backupCandidates(league, starter);
  const chosen = saved && candidates.find((c) => String(c.id) === String(saved));
  if (chosen) return { player: chosen, source: 'chosen' };
  const first = candidates[0];
  if (first && !first.injuryStatus && first.position && first.position === starter.position) {
    return { player: first, source: 'suggested' };
  }
  return { player: null, source: 'none' };
}

// Starters in games at `kickoff`, from the snapshot. One entry per player
// (normalized name + scoreboard team), carrying every league that starts him
// and any MFL id seen, so MFL's by-id injury map can be joined exactly.
export function startersForSlot(snapshot, games, kickoff, plans = null) {
  const out = new Map();
  const year = Number(snapshot?.year);
  for (const league of snapshot?.leagues || []) {
    if (league.type === 'draftonly') continue;
    if (!Array.isArray(league.starters) || league.lineupWeek == null) continue;
    if (league.draftInProgress === true) continue;
    if (Number(league.season) < year) continue;
    const byId = new Map((league.players || []).map((p) => [String(p.id), p]));
    for (const id of league.starters) {
      const p = byId.get(String(id));
      if (!p || !p.team) continue;
      const game = games.get(p.team);
      if (!game || game.kickoff !== kickoff) continue;
      const k = `${key(p.name)}|${game.team}`;
      if (!out.has(k)) {
        out.set(k, { key: k, name: p.name, team: game.team, designation: null, mflIds: new Set(), leagues: [], backups: [] });
      }
      const row = out.get(k);
      if (p.injuryStatus && !row.designation) row.designation = p.injuryStatus;
      if (!league.provider || league.provider === 'mfl') row.mflIds.add(String(p.id));
      row.leagues.push(leagueLabel(league));
      // Per league, because the bench behind him is each league's own. A
      // backup whose game has already kicked off is flagged rather than
      // dropped: he is still the pick, but the lineup slot is locked.
      const { player: b } = resolveBackup(league, p, plans?.backupPlans?.[league.id]?.[p.id]);
      const bGame = b?.team ? games.get(b.team) : null;
      row.backups.push({
        league: leagueLabel(league),
        backup: b ? { name: b.name, position: b.position || null, team: b.team || null, locked: !!bGame && bGame.state !== 'pre' } : null,
      });
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
  const pending = watched.filter((p) => p.state === 'pending');
  const finalCall = !next.finalCall && pending.length > 0 && minutesToKickoff <= FINAL_CALL_MINUTES;
  if (finalCall) next.finalCall = true;
  if (!first && changed.length === 0 && !finalCall) return { message: null, next };

  const rows = first || finalCall ? watched : changed;
  const line = (p) => {
    const icon = p.state === 'inactive' ? '❌' : p.state === 'active' ? '✅' : '⏳';
    const verb = p.state === 'inactive' ? 'OUT — swap him' : p.state === 'active' ? 'playing' : 'not known yet';
    const tag = p.designation ? ` (${p.designation})` : '';
    // An OUT starter is the one the manager has to act on, so only that line
    // names who goes in — per league, since each has its own bench. The rest
    // keep the plain league list. Older callers without `backups` do too.
    const where = p.state === 'inactive' && p.backups?.length
      ? p.backups.map(({ league, backup }) => `${league} → ${backupText(backup)}`).join('; ')
      : p.leagues.join(', ');
    return `${icon} ${p.name} ${p.team}${tag}: ${verb} — ${p.why}. ${where}`;
  };
  const anyOut = rows.some((p) => p.state === 'inactive');
  let title;
  if (finalCall) title = `${whenLabel} kickoff: still no word on ${pending.length} — check manually`;
  else if (first) title = anyOut ? `${whenLabel} kickoff: lineup change needed` : `${whenLabel} kickoff: ${watched.length} checked`;
  else title = `${whenLabel} kickoff: update`;
  return {
    message: { title, body: rows.map(line).join('\n'), priority: anyOut || finalCall ? 1 : 0 },
    next,
  };
}
