// The trip log behind fish.html (myFish): validation, normalisation and the seed
// data, shared by api/fam.js (`?resource=fishtrips`) and test-fish.mjs.
//
// Shape of one trip (the Trips admin card edits exactly this):
//   { id, year, date, location,
//     days:    [{ first: 'Jeff', biggest: 'Gary', biggestInches: 15.5,
//                 species: [{ name: 'Walleye', count: 6 }] }],
//     anglers: [{ name: 'Braden', days: [{ caught: 15, kept: 8 }] }] }
// `date` is the first day as 'YYYY-MM-DD', or null when unknown; its year must be
// the trip's `year`. With a date, the page calls a trip Upcoming while the date is
// still ahead and played once it arrives, whether or not any stats were kept;
// without one it falls back on the year (see tripStatus in fish.html).
// `days[i]` and every angler's `days[i]` line up by index. A caught/kept of
// null means "not recorded" (an upcoming trip, or a day nobody counted) and is
// kept apart from a real 0: totals skip the nulls, they never count them as 0.
// Species counts are fish KEPT (the 2025 sheet's Walleye + Sauger add up to that
// day's Fish Kept), and are optional: 2022-2024 never recorded them.
//
// Where it lives: Upstash key `fish:trips` (api/fam.js). Until the first Save
// there is nothing stored and the GET answers with SEED_TRIPS, which is the
// original Google Sheet transcribed, so the page works from day one and a first
// Save from the Trips tab writes the whole list. The list is replaced as one
// document, never patched.

export const MAX_TRIPS = 60;
export const MAX_DAYS = 6;
export const MAX_ANGLERS = 12;
export const MAX_SPECIES = 8;
const MAX_TEXT = 60;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanText = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
// A count: a whole number 0..999, or null for "not recorded".
const isCount = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 999);
// A real calendar date written YYYY-MM-DD (2025-02-30 is refused, not rolled over).
export function isRealDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const isInches = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100);

export function validateTrips(body) {
  const errors = [];
  if (!isObj(body) || !Array.isArray(body.trips)) return { errors: ['`trips` must be an array.'] };
  if (body.trips.length > MAX_TRIPS) errors.push(`More than ${MAX_TRIPS} trips.`);
  const ids = new Set();
  body.trips.forEach((t, i) => {
    const at = `Trip ${i + 1}`;
    if (!isObj(t)) { errors.push(`${at}: must be an object.`); return; }
    if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(t.id)) errors.push(`${at}: id must be letters, digits, - or _ (max 40).`);
    else if (ids.has(t.id)) errors.push(`${at}: duplicate id "${t.id}".`);
    else ids.add(t.id);
    if (!Number.isInteger(t.year) || t.year < 1990 || t.year > 2100) errors.push(`${at}: year must be a four-digit year.`);
    if (t.date != null && t.date !== '') {
      if (!isRealDate(t.date)) errors.push(`${at}: date must be a real date written YYYY-MM-DD.`);
      else if (Number(t.date.slice(0, 4)) !== t.year) errors.push(`${at}: the date is in ${t.date.slice(0, 4)} but the year is ${t.year}.`);
    }
    if (cleanText(t.location).length > MAX_TEXT) errors.push(`${at}: location is over ${MAX_TEXT} characters.`);
    if (!Array.isArray(t.days) || t.days.length < 1 || t.days.length > MAX_DAYS) { errors.push(`${at}: days must hold 1 to ${MAX_DAYS} entries.`); return; }
    if (!Array.isArray(t.anglers) || t.anglers.length > MAX_ANGLERS) { errors.push(`${at}: anglers must be a list of at most ${MAX_ANGLERS}.`); return; }
    t.days.forEach((d, j) => {
      const day = `${at}, day ${j + 1}`;
      if (!isObj(d)) { errors.push(`${day}: must be an object.`); return; }
      for (const k of ['first', 'biggest']) if (d[k] != null && (typeof d[k] !== 'string' || cleanText(d[k]).length > MAX_TEXT)) errors.push(`${day}: ${k} must be text up to ${MAX_TEXT} characters.`);
      if (d.biggestInches != null && !isInches(d.biggestInches)) errors.push(`${day}: biggest fish length must be a number of inches.`);
      if (d.species != null) {
        if (!Array.isArray(d.species) || d.species.length > MAX_SPECIES) errors.push(`${day}: species must be a list of at most ${MAX_SPECIES}.`);
        else d.species.forEach((s) => {
          if (!isObj(s) || !cleanText(s.name) || cleanText(s.name).length > 30) errors.push(`${day}: every species needs a name (up to 30 characters).`);
          else if (!isCount(s.count)) errors.push(`${day}: ${cleanText(s.name)} count must be a whole number.`);
        });
      }
    });
    const names = new Set();
    t.anglers.forEach((a, k) => {
      const who = `${at}, angler ${k + 1}`;
      if (!isObj(a)) { errors.push(`${who}: must be an object.`); return; }
      const name = cleanText(a.name);
      if (!name || name.length > 30) errors.push(`${who}: name is required (up to 30 characters).`);
      else if (names.has(name.toLowerCase())) errors.push(`${at}: ${name} is listed twice.`);
      else names.add(name.toLowerCase());
      if (!Array.isArray(a.days) || a.days.length !== t.days.length) { errors.push(`${who}: needs one caught/kept entry per day (${t.days.length}).`); return; }
      a.days.forEach((d, j) => {
        if (!isObj(d) || !isCount(d.caught ?? null) || !isCount(d.kept ?? null)) errors.push(`${who}, day ${j + 1}: caught and kept must be whole numbers or blank.`);
        else if (d.caught != null && d.kept != null && d.kept > d.caught) errors.push(`${who}, day ${j + 1}: kept (${d.kept}) is more than caught (${d.caught}).`);
      });
    });
  });
  return { errors };
}

// Trimmed, with blanks as null and empty optional fields dropped, so what is
// stored (and what the page diffs against) is canonical.
export function normalizeTrips(trips) {
  return trips.map((t) => ({
    id: t.id,
    year: t.year,
    date: t.date || null,
    location: cleanText(t.location),
    days: t.days.map((d) => {
      const out = { first: cleanText(d.first), biggest: cleanText(d.biggest), biggestInches: d.biggestInches ?? null };
      const species = (d.species || []).map((s) => ({ name: cleanText(s.name), count: s.count ?? null }));
      if (species.length) out.species = species;
      return out;
    }),
    anglers: t.anglers.map((a) => ({ name: cleanText(a.name), days: a.days.map((d) => ({ caught: d.caught ?? null, kept: d.kept ?? null })) })),
  }));
}

const trip = (id, year, location, anglers, days) => ({
  id, year, date: null, location,
  days: days.map(([first, biggest, biggestInches, species]) => ({ first, biggest, biggestInches, ...(species ? { species } : {}) })),
  anglers: anglers.map(([name, ...pairs]) => ({ name, days: pairs.map(([caught, kept]) => ({ caught, kept })) })),
});
const blank = [null, null];

// The original spreadsheet ("Ice Fishing", Lake of the Woods), 2022-2026. 2026 is
// the upcoming trip, so its counts are blank. None has a date: the sheet only
// had years, and a date is not invented for a trip that was never recorded with one. 2023's Day 2 biggest fish is
// credited to Braden although the sheet lists only Jason and Jeff that year; it is
// kept as the sheet has it. 2022 never recorded a biggest fish.
export const SEED_TRIPS = [
  trip('2026', 2026, 'River Bend', [['Braden', blank, blank], ['Jason', blank, blank], ['Jeff', blank, blank], ['Gary', blank, blank]],
    [['', '', null, [{ name: 'Walleye', count: null }, { name: 'Sauger', count: null }]], ['', '', null, [{ name: 'Walleye', count: null }, { name: 'Sauger', count: null }]]]),
  trip('2025', 2025, 'River Bend', [['Braden', [15, 8], [16, 6]], ['Jason', [17, 3], [12, 4]], ['Jeff', [23, 5], [9, 3]], ['Gary', [4, 2], [4, 0]]],
    [['Jeff', 'Gary', 15.5, [{ name: 'Walleye', count: 6 }, { name: 'Sauger', count: 12 }]], ['Jason', 'Braden', 16, [{ name: 'Walleye', count: 7 }, { name: 'Sauger', count: 6 }]]]),
  trip('2024', 2024, 'River Bend', [['Braden', [14, 3], [20, 6]], ['Jason', [11, 3], [9, 4]], ['Jeff', [11, 2], [5, 1]], ['Gary', [15, 5], [17, 4]]],
    [['Jason', 'Jeff', 15, null], ['Jason', 'Jason', 14.25, null]]),
  trip('2023', 2023, 'Ken-Mar-Ke', [['Jason', [17, 7], [14, 8]], ['Jeff', [10, 5], [9, 4]]],
    [['Jeff', 'Jason', 16, null], ['Jason', 'Braden', 19, null]]),
  trip('2022', 2022, 'Zippel Bay', [['Braden', [1, 1], [8, 0]], ['Jason', [2, 1], [8, 1]], ['Jeff', [14, 7], [7, 3]], ['Gary', [5, 1], [3, 2]]],
    [['Gary', '', null, null], ['Jeff', '', null, null]]),
];
