// Reads a public iCloud calendar (Calendar app -> share -> "Public Calendar")
// for index.html's Calendar card. Unlike the shared-album endpoint this is a
// standard iCalendar (RFC 5545) feed: the `webcal://` link with `https://` in
// its place serves a plain .ics file, no login. Apple's real output was probed:
// it uses `DTSTART;TZID=America/Chicago:...` with a full VTIMEZONE block (not
// used here: the IANA name goes straight to Intl), folded lines, `\n` / `\,`
// text escapes, and `RRULE`s for repeats.
//
// What is handled, and what is deliberately not:
//  - timed, all-day and multi-day events; UTC, TZID and floating (read as UTC)
//    start times;
//  - repeats: FREQ DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL,
//    BYDAY (with an ordinal for monthly/yearly), BYMONTHDAY, BYMONTH, WKST;
//    occurrences keep their wall-clock time across daylight saving;
//  - EXDATE, single edited occurrences (RECURRENCE-ID) and STATUS:CANCELLED.
//  - NOT handled: BYSETPOS, BYWEEKNO, BYYEARDAY, sub-daily FREQs and
//    THISANDFUTURE overrides. Such an event shows once, at its first start,
//    flagged `partialRepeat: true`, rather than being dropped or guessed at.
//
// Nothing here touches the network except fetchCalendar, and that takes its
// fetch as an argument so the test can fake Apple.

const MS_DAY = 86400000;
const MAX_EVENTS = 300;
const MAX_PERIODS = 20000;

// ---- fetching ----------------------------------------------------------------

// The URL comes from a Vercel variable, but it is still constrained to Apple's
// published-calendar shape so a bad value can't turn this into an open proxy.
export function normalizeCalendarUrl(raw) {
  if (typeof raw !== 'string') return null;
  const url = raw.trim().replace(/^webcal:/i, 'https:');
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !/^p\d+-caldav\.icloud\.com$/.test(u.hostname) || !u.pathname.startsWith('/published/')) return null;
  return u.toString();
}

export async function fetchCalendar(rawUrl, fetchFn = fetch, window) {
  const url = normalizeCalendarUrl(rawUrl);
  if (!url) throw new Error('Calendar link is not configured or is not an iCloud public calendar link');
  const res = await fetchFn(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`Apple answered HTTP ${res.status}`);
  const text = await res.text();
  if (!/^BEGIN:VCALENDAR/m.test(text)) throw new Error('Apple did not return a calendar');
  return buildCalendar(text, window);
}

// The page browses one month at a time. The window is the month plus a day
// either side, so the browser's own time zone (up to +/-14h from UTC) can still
// place an event on the right local day; the page filters to the month itself.
// Years outside the range are refused, which also bounds the route's cache.
export const MONTH_MIN_YEAR = 2020;
export const MONTH_MAX_YEAR = 2035;
export function monthWindow(monthParam, now = Date.now()) {
  let y, m;
  if (monthParam == null || monthParam === '') {
    const t = new Date(now);
    y = t.getUTCFullYear(); m = t.getUTCMonth() + 1;
  } else {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(monthParam));
    if (!match) return null;
    y = +match[1]; m = +match[2];
  }
  if (y < MONTH_MIN_YEAR || y > MONTH_MAX_YEAR) return null;
  return { month: `${y}-${String(m).padStart(2, '0')}`, from: Date.UTC(y, m - 1, 1) - MS_DAY, to: Date.UTC(y, m, 1) + MS_DAY };
}

// ---- parsing -----------------------------------------------------------------

// First ':' outside double quotes splits "NAME;PARAM=x:value".
function splitLine(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

function parseParams(head) {
  const parts = head.split(';');
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params };
}

export function unescapeText(s) {
  return String(s).replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// Returns each VEVENT as { name -> [{ params, value }] }. VALARMs inside an
// event are skipped.
export function parseEvents(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  let alarmDepth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; alarmDepth = 0; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (line === 'BEGIN:VALARM') { alarmDepth++; continue; }
    if (line === 'END:VALARM') { alarmDepth--; continue; }
    if (alarmDepth > 0) continue;
    const split = splitLine(line);
    if (!split) continue;
    const { name, params } = parseParams(split[0]);
    (cur[name] = cur[name] || []).push({ params, value: split[1] });
  }
  return events;
}

// ---- dates -------------------------------------------------------------------

const formatters = new Map();
function zoneParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
function tzOffsetMs(ms, tz) {
  const p = zoneParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// A wall-clock time in `tz` as an instant. Two passes settle the offset around a
// daylight-saving change. An unknown zone name reads as UTC rather than failing
// the whole feed.
function wallToInstant(w, tz) {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (!tz) return guess;
  try {
    let ms = guess - tzOffsetMs(guess, tz);
    ms = guess - tzOffsetMs(ms, tz);
    return ms;
  } catch (e) { return guess; }
}

// "20261114T150000[Z]" or "20261114" -> { y, m, d, h, mi, s, allDay, utc, tz }.
function parseDateProp(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  let m = /^(\d{4})(\d\d)(\d\d)$/.exec(v);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], h: 0, mi: 0, s: 0, allDay: true };
  m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/.exec(v);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], allDay: false, utc: m[7] === 'Z', tz: prop.params.TZID };
}
const instantOf = (w) => (w.utc ? Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) : wallToInstant(w, w.tz));
const pad = (n, l = 2) => String(n).padStart(l, '0');
const dateStr = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const dateStrOfMs = (ms) => { const t = new Date(ms); return dateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

// A duration like PT1H30M / P1D / P1W, in ms.
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * MS_DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---- repeat rules ------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const UNSUPPORTED_RULE_KEYS = ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'];

export function parseRrule(value) {
  const rule = {};
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const out = {
    freq: rule.FREQ,
    interval: Math.max(1, parseInt(rule.INTERVAL, 10) || 1),
    count: rule.COUNT ? parseInt(rule.COUNT, 10) : null,
    until: rule.UNTIL || null,
    byDay: rule.BYDAY ? rule.BYDAY.split(',').map((s) => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim()); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2]) } : null; }).filter(Boolean) : null,
    byMonthDay: rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number).filter(Number.isFinite) : null,
    byMonth: rule.BYMONTH ? rule.BYMONTH.split(',').map(Number).filter(Number.isFinite) : null,
    wkst: Math.max(0, WEEKDAYS.indexOf(rule.WKST || 'MO')),
    unsupported: UNSUPPORTED_RULE_KEYS.some((k) => k in rule) || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ),
  };
  if (out.freq === 'YEARLY' && out.byDay && !out.byMonth) out.unsupported = true; // "nth weekday of the year"
  return out;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

// Day numbers in (y, m) matching BYMONTHDAY / BYDAY, or the fallback day.
function monthDays(rule, y, m, fallbackDay) {
  const dim = daysInMonth(y, m);
  const days = new Set();
  if (rule.byMonthDay) for (const n of rule.byMonthDay) { const d = n > 0 ? n : dim + 1 + n; if (d >= 1 && d <= dim) days.add(d); }
  if (rule.byDay) {
    for (const { n, wd } of rule.byDay) {
      const all = [];
      for (let d = 1; d <= dim; d++) if (weekdayOf(y, m, d) === wd) all.push(d);
      if (!n) all.forEach((d) => days.add(d));
      else { const d = n > 0 ? all[n - 1] : all[all.length + n]; if (d) days.add(d); }
    }
  }
  if (!rule.byMonthDay && !rule.byDay && fallbackDay <= dim) days.add(fallbackDay);
  return [...days].sort((a, b) => a - b);
}

// Calendar dates ({y,m,d}) of the `k`th period of the rule, ascending.
function periodDates(rule, start, k) {
  const startMs = Date.UTC(start.y, start.m - 1, start.d);
  const step = k * rule.interval;
  if (rule.freq === 'DAILY') {
    const t = new Date(startMs + step * MS_DAY);
    return [{ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }];
  }
  if (rule.freq === 'WEEKLY') {
    const wd = new Date(startMs).getUTCDay();
    const weekStart = startMs - ((wd - rule.wkst + 7) % 7) * MS_DAY + step * 7 * MS_DAY;
    const wds = rule.byDay ? rule.byDay.map((b) => b.wd) : [wd];
    return wds.map((w) => (w - rule.wkst + 7) % 7).sort((a, b) => a - b).map((off) => {
      const t = new Date(weekStart + off * MS_DAY);
      return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
    });
  }
  if (rule.freq === 'MONTHLY') {
    const idx = start.y * 12 + (start.m - 1) + step;
    const y = Math.floor(idx / 12), m = (idx % 12) + 1;
    return monthDays(rule, y, m, start.d).map((d) => ({ y, m, d }));
  }
  // YEARLY
  const y = start.y + step;
  const months = rule.byMonth || [start.m];
  const out = [];
  for (const m of [...months].sort((a, b) => a - b)) for (const d of monthDays(rule, y, m, start.d)) out.push({ y, m, d });
  return out;
}

// Wall-clock occurrences of a repeating event in order, up to `toMs`. Stops at
// COUNT, UNTIL or the window end. `rule.byMonth` also filters DAILY/WEEKLY/MONTHLY.
function* occurrences(rule, start, untilMs, toMs) {
  let emitted = 0;
  for (let k = 0; k < MAX_PERIODS; k++) {
    const dates = periodDates(rule, start, k).filter((dt) => !(rule.byMonth && rule.freq !== 'YEARLY' && !rule.byMonth.includes(dt.m)));
    let pastWindow = false;
    for (const dt of dates) {
      const w = { y: dt.y, m: dt.m, d: dt.d, h: start.h, mi: start.mi, s: start.s, allDay: start.allDay, utc: start.utc, tz: start.tz };
      if (Date.UTC(dt.y, dt.m - 1, dt.d, start.h, start.mi, start.s) < Date.UTC(start.y, start.m - 1, start.d, start.h, start.mi, start.s)) continue;
      const ms = start.allDay ? Date.UTC(dt.y, dt.m - 1, dt.d) : instantOf(w);
      if (untilMs != null && ms > untilMs) return;
      if (rule.count != null && emitted >= rule.count) return;
      emitted++;
      if (ms > toMs) { pastWindow = true; break; }
      yield { w, ms };
    }
    if (pastWindow) return;
  }
}

// ---- events -> occurrences ---------------------------------------------------

const keyOf = (w) => (w.allDay ? dateStr(w.y, w.m, w.d) : String(instantOf(w)));

function textOf(ev, name) {
  const p = ev[name] && ev[name][0];
  return p ? unescapeText(p.value).trim() : '';
}

// The calendar holds U.S. holidays imported from Google's public holiday feed,
// whose events carry DESCRIPTION "Public holiday" or "Observance" (the latter
// followed by a note on hiding observances). That is the only marker they have,
// so it is what the page uses to keep them on the month grid but out of the
// "Events this month" list. A family event is unlikely to start with either phrase.
function isHoliday(ev) {
  return /^(public holiday|observance)\b/i.test(textOf(ev, 'DESCRIPTION'));
}

// One occurrence as the page's event shape.
function shape(ev, startW, startMs, durationMs, extra = {}) {
  const base = { id: `${textOf(ev, 'UID')}@${keyOf(startW)}`, title: textOf(ev, 'SUMMARY') || '(No title)', location: textOf(ev, 'LOCATION').split('\n')[0].trim(), ...(isHoliday(ev) ? { holiday: true } : {}) };
  if (startW.allDay) {
    const days = Math.max(1, Math.round(durationMs / MS_DAY));
    return { ...base, allDay: true, start: dateStr(startW.y, startW.m, startW.d), end: dateStrOfMs(startMs + days * MS_DAY), ...extra };
  }
  return { ...base, allDay: false, start: new Date(startMs).toISOString(), end: new Date(startMs + durationMs).toISOString(), ...extra };
}

// Pure: the events inside [fromMs, toMs], repeats expanded, newest-edit
// overrides applied. Exported for the test.
export function expandEvents(rawEvents, fromMs, toMs) {
  const infoOf = (ev) => {
    const startW = parseDateProp(ev.DTSTART && ev.DTSTART[0]);
    if (!startW) return null;
    const startMs = startW.allDay ? Date.UTC(startW.y, startW.m - 1, startW.d) : instantOf(startW);
    const endW = parseDateProp(ev.DTEND && ev.DTEND[0]);
    let duration = 0;
    if (endW) duration = (endW.allDay ? Date.UTC(endW.y, endW.m - 1, endW.d) : instantOf(endW)) - startMs;
    else if (ev.DURATION) duration = parseDuration(ev.DURATION[0].value) || 0;
    else if (startW.allDay) duration = MS_DAY;
    return { startW, startMs, duration: Math.max(0, duration) };
  };
  const cancelled = (ev) => /^CANCELLED$/i.test(textOf(ev, 'STATUS'));

  // Edited single occurrences, keyed by the original slot they replace.
  const overrides = new Map();
  for (const ev of rawEvents) {
    if (!ev['RECURRENCE-ID']) continue;
    const rid = parseDateProp(ev['RECURRENCE-ID'][0]);
    if (rid) overrides.set(`${textOf(ev, 'UID')}|${keyOf(rid)}`, ev);
  }

  const out = [];
  const inWindow = (startMs, duration, allDay) => (allDay ? startMs + Math.max(duration, MS_DAY) > fromMs : startMs + duration >= fromMs) && startMs <= toMs;
  const push = (ev, info, extra) => {
    if (inWindow(info.startMs, info.duration, info.startW.allDay)) out.push(shape(ev, info.startW, info.startMs, info.duration, extra));
  };

  for (const ev of rawEvents) {
    const info = infoOf(ev);
    if (!info) continue;
    const uid = textOf(ev, 'UID');
    if (ev['RECURRENCE-ID']) { if (!cancelled(ev)) push(ev, info); continue; }
    if (cancelled(ev)) continue;
    if (!ev.RRULE) { push(ev, info); continue; }

    const rule = parseRrule(ev.RRULE[0].value);
    if (rule.unsupported) { push(ev, info, { partialRepeat: true }); continue; }
    const excluded = new Set();
    for (const ex of ev.EXDATE || []) for (const v of ex.value.split(',')) { const w = parseDateProp({ value: v, params: ex.params }); if (w) excluded.add(keyOf(w)); }
    let untilMs = null;
    if (rule.until) { const u = parseDateProp({ value: rule.until, params: { TZID: info.startW.tz } }); if (u) untilMs = u.allDay ? Date.UTC(u.y, u.m - 1, u.d) : instantOf({ ...u, utc: u.utc || false, tz: u.tz }); }
    for (const occ of occurrences(rule, info.startW, untilMs, toMs)) {
      const key = keyOf(occ.w);
      if (excluded.has(key) || overrides.has(`${uid}|${key}`)) continue;
      push(ev, { startW: occ.w, startMs: occ.ms, duration: info.duration });
    }
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
  return out;
}

// Text of a whole feed -> { name, events } inside { from, to } (ms).
export function buildCalendar(text, { from, to }) {
  const name = (/^X-WR-CALNAME:(.*)$/m.exec(text) || [])[1] || '';
  const events = expandEvents(parseEvents(text), from, to);
  return { name: unescapeText(name).trim(), events: events.slice(0, MAX_EVENTS) };
}
