// The favourite-lures list behind fish.html's Equipment tab (myFish): validation
// and normalisation, shared by api/fam.js (`?resource=fishlures`) and test-fish.mjs.
//
// Shape of one lure (the Lures admin card edits exactly this):
//   { id, name, fishingType, lureType, waterBody, location, notes }
// `fishingType` is one of FISHING_TYPES (the page's filter and grouping key);
// `lureType` (jig, spoon, crankbait...), `waterBody` (Lake of the Woods) and
// `location` (Baudette, MN) are free text and optional, as are the notes. The page
// filters on whatever values the saved list actually holds.
//
// Where it lives: Upstash key `fish:lures` (api/fam.js), replaced as one document
// on Save, like the trip log. Until the first Save the GET answers with an empty
// list: unlike trips there is no spreadsheet to seed from.

export const FISHING_TYPES = ['Ice', 'Open water', 'Fly', 'Other'];
export const MAX_LURES = 300;
const MAX_TEXT = 60;
const MAX_NOTES = 300;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanText = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

export function validateLures(body) {
  const errors = [];
  if (!isObj(body) || !Array.isArray(body.lures)) return { errors: ['`lures` must be an array.'] };
  if (body.lures.length > MAX_LURES) errors.push(`More than ${MAX_LURES} lures.`);
  const ids = new Set();
  body.lures.forEach((l, i) => {
    const at = `Lure ${i + 1}`;
    if (!isObj(l)) { errors.push(`${at}: must be an object.`); return; }
    if (typeof l.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(l.id)) errors.push(`${at}: id must be letters, digits, - or _ (max 40).`);
    else if (ids.has(l.id)) errors.push(`${at}: duplicate id "${l.id}".`);
    else ids.add(l.id);
    if (!cleanText(l.name) || cleanText(l.name).length > MAX_TEXT) errors.push(`${at}: name is required (up to ${MAX_TEXT} characters).`);
    if (!FISHING_TYPES.includes(l.fishingType)) errors.push(`${at}: type of fishing must be one of ${FISHING_TYPES.join(', ')}.`);
    for (const k of ['lureType', 'waterBody', 'location']) {
      if (l[k] != null && (typeof l[k] !== 'string' || cleanText(l[k]).length > MAX_TEXT)) errors.push(`${at}: ${k} must be text up to ${MAX_TEXT} characters.`);
    }
    if (l.notes != null && (typeof l.notes !== 'string' || cleanText(l.notes).length > MAX_NOTES)) errors.push(`${at}: notes must be text up to ${MAX_NOTES} characters.`);
  });
  return { errors };
}

export function normalizeLures(lures) {
  return lures.map((l) => ({
    id: l.id,
    name: cleanText(l.name),
    fishingType: l.fishingType,
    lureType: cleanText(l.lureType),
    waterBody: cleanText(l.waterBody),
    location: cleanText(l.location),
    notes: cleanText(l.notes),
  }));
}
