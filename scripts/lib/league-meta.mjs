// A small cache of the slow-moving facts the sync reads off each MFL league's
// TYPE=league response: franchise names, owner names and divisions.
//
// Why it exists: those reads were about a fifth of every sync's MFL requests.
// Each MFL league costs two TYPE=league requests per sync — one against the
// generic host (names, divisions, and the roster pass's rules) and one against
// the league's own regional host, which exists only because the generic host
// doesn't reliably return owner names (see fetchMflOwnerNames). Owners and team
// names change a few times a year; the frozen draft-only leagues (eight of
// fifteen) spent both requests on nothing but labelling their standings.
//
// What is cached, and what deliberately is not:
//   - Owner names for every MFL league, refreshed daily. That is the whole of
//     the regional-host request.
//   - Names and divisions for frozen draft-only leagues too, so a frozen
//     league with a fresh entry costs no request at all. For every other league
//     the generic-host read still happens each sync, because the roster entry
//     needs the live salary cap, roster limits and lineup slots off it, and
//     the names and divisions come off that same response for free.
//
// Where it lives: a separate committed file (data/mfl-league-meta.json), never
// a field on the rosters.json result. Everything on that object is downloaded
// by every visitor on every page load, and this is scaffolding for the sync.
// The page never fetches this file, and what is in it is already public in the
// standings ("Team Name (Owner)").
//
// Staleness is bounded and cheap: a renamed team or a new owner shows the old
// name for up to one refresh (20h, the availability pass's own rule), while
// standings themselves are still read every sync. A failed refresh keeps the
// old entry rather than dropping owners, which is better than the fetch
// function's own behaviour (an empty map, so every owner annotation vanishes).
//
// Pure apart from the injected fetchers, so test-league-meta.mjs can drive it
// without a network.

// Twenty hours rather than twenty-four for the reason AVAILABILITY_MAX_AGE_MS
// in fetch-rosters.mjs spells out: with a four-hour sync, an exactly-24h rule
// walks the daily refresh later in the day by one run every day.
export const LEAGUE_META_MAX_AGE_MS = 20 * 60 * 60 * 1000;

export const LEAGUE_META_VERSION = 1;

// An entry only answers for the season and type it was read under. A season
// rollover can change franchises; a type change changes whether the league is
// frozen at all, so neither should ever be answered from an old entry.
export function leagueMetaMatches(entry, league) {
  return !!entry
    && String(entry.season) === String(league.season)
    && entry.type === league.type;
}

// Usable without asking MFL again. `force` is the manual refresh_availability
// input, which is a "re-read everything now" button and so covers this too.
export function leagueMetaIsFresh(entry, league, now, force = false) {
  if (force) return false;
  if (!leagueMetaMatches(entry, league)) return false;
  const fetchedAt = Date.parse(entry.fetchedAt ?? '');
  if (!Number.isFinite(fetchedAt)) return false;
  const age = now.getTime() - fetchedAt;
  // A clock that went backwards is not "fresh forever".
  return age >= 0 && age < LEAGUE_META_MAX_AGE_MS;
}

const objectFromMap = (map) => Object.fromEntries(map);
const mapFromObject = (obj) => new Map(Object.entries(obj || {}));

// Maps in, plain JSON out, and back. Franchise ids are strings in MFL's
// responses, so Object keys lose nothing.
export function packLeagueMeta({ nameById, ownerById, divisionById }, league, now) {
  return {
    season: String(league.season),
    type: league.type ?? null,
    fetchedAt: now.toISOString(),
    nameById: objectFromMap(nameById),
    ownerById: objectFromMap(ownerById),
    divisionById: objectFromMap(divisionById),
  };
}

export function unpackLeagueMeta(entry) {
  return {
    nameById: mapFromObject(entry?.nameById),
    ownerById: mapFromObject(entry?.ownerById),
    divisionById: mapFromObject(entry?.divisionById),
  };
}

// The pass's one decision, per MFL league.
//
//   frozen + fresh entry  -> no request at all; the cached maps are the answer.
//   everything else       -> the generic-host read happens (the roster pass
//                            needs it) and names/divisions come off it; owners
//                            come from a fresh entry or one regional-host read.
//
// `record` is the entry to store, or null when nothing was refreshed. A refresh
// that came back with no owners is not stored: an empty answer is far more
// likely a failed request (fetchMflOwnerNames swallows errors into an empty
// map) than a league with nobody in it, and storing it would pin "no owners"
// for the day. In that case the previous entry's owners are used if it is for
// the same season and type, however old.
//
// `requestsSaved` is for the sync's log line only.
export async function resolveMflLeagueInfo({
  league,
  entry,
  frozen,
  now,
  force = false,
  fetchLeagueData,
  fetchOwners,
  franchiseNames,
  franchiseDivisions,
}) {
  const fresh = leagueMetaIsFresh(entry, league, now, force);

  if (frozen && fresh) {
    return { leagueData: null, info: unpackLeagueMeta(entry), record: null, requestsSaved: 2 };
  }

  const leagueData = await fetchLeagueData();
  const nameById = franchiseNames(leagueData);
  const divisionById = franchiseDivisions(leagueData);

  if (fresh) {
    return {
      leagueData,
      info: { nameById, ownerById: unpackLeagueMeta(entry).ownerById, divisionById },
      record: null,
      requestsSaved: 1,
    };
  }

  const fetched = await fetchOwners(leagueData);
  if (fetched.size > 0) {
    const info = { nameById, ownerById: fetched, divisionById };
    return { leagueData, info, record: packLeagueMeta(info, league, now), requestsSaved: 0 };
  }
  const ownerById = leagueMetaMatches(entry, league) ? unpackLeagueMeta(entry).ownerById : fetched;
  return { leagueData, info: { nameById, ownerById, divisionById }, record: null, requestsSaved: 0 };
}

// One league per line, like serializeSnapshot, so a refresh is a readable diff.
// Only leagues still in the config are kept: a removed league must not leave an
// entry behind forever.
export function serializeLeagueMeta(entriesById, configuredIds) {
  const keep = new Set(configuredIds.map(String));
  const lines = Object.entries(entriesById || {})
    .filter(([id]) => keep.has(String(id)))
    .map(([id, entry]) => `${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
  return `{\n"version": ${LEAGUE_META_VERSION},\n"leagues": {\n${lines.join(',\n')}\n}\n}\n`;
}

// Unreadable, missing, or from a format this code doesn't know: start empty.
// Everything then falls through to fetching, which is exactly what the sync did
// before this cache existed.
export function parseLeagueMeta(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version !== LEAGUE_META_VERSION || typeof parsed.leagues !== 'object' || parsed.leagues === null) return {};
    return parsed.leagues;
  } catch {
    return {};
  }
}
