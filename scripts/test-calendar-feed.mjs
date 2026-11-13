// Pins api/_lib/calendarfeed.mjs and the public `?resource=calendar` route of
// api/fam.js (the Calendar card on index.html). What can drift silently:
//  - repeat expansion: COUNT is not extended by EXDATE, weekly BYDAY, "second
//    Tuesday", all-day yearly (birthdays);
//  - wall-clock time across daylight saving (a 3pm practice stays 3pm);
//  - edited and cancelled single occurrences (RECURRENCE-ID);
//  - a rule we don't support showing once, flagged, never dropped or guessed;
//  - the feed URL being bent into an open proxy;
//  - the feed link leaking into an error the page shows.
// The sample is the shape of Apple's real feed (TZID events, folded lines,
// escaped text, an X-APPLE property with a quoted colon, a VTIMEZONE block),
// with invented content.
//
// Run: node scripts/test-calendar-feed.mjs

import assert from 'node:assert/strict';
import { parseEvents, expandEvents, buildCalendar, normalizeCalendarUrl, fetchCalendar, unescapeText } from '../api/_lib/calendarfeed.mjs';
import handler, { resetPhotosCache } from '../api/fam.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

const NOW = Date.UTC(2026, 10, 13, 21, 0, 0); // Fri 13 Nov 2026 21:00Z
const FROM = NOW - 86400000;
const TO = NOW + 90 * 86400000;

const ev = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const feed = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Test cal', ...events, 'BEGIN:VTIMEZONE', 'TZID:America/Chicago', 'END:VTIMEZONE', 'END:VCALENDAR', ''].join('\r\n');
const run = (...events) => expandEvents(parseEvents(feed(...events)), FROM, TO);
const starts = (list) => list.map((e) => e.start);

const dinner = ev([
  'DTSTART;TZID=America/Chicago:20261113T200000', 'DTEND;TZID=America/Chicago:20261113T210000',
  'LOCATION:Test Grill\\n1 Main St\\, Town\\, MN  55426\\, ', ' United States',
  'SUMMARY:Dinner\\, drinks', 'UID:dinner',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="1 Main St, Town, MN";X-TITLE=Test Grill:geo:44.9,-93.3',
]);
const practice = ev(['DTSTART;TZID=America/Chicago:20261114T150000', 'DTEND;TZID=America/Chicago:20261114T160000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Practice', 'UID:practice', 'LOCATION:School']);

await check('a timed one-off: folded and escaped text, TZID converted to UTC, junk X- property ignored', () => {
  const [d] = run(dinner);
  assert.equal(d.title, 'Dinner, drinks');
  assert.equal(d.location, 'Test Grill', 'location is the first line only');
  assert.equal(d.start, '2026-11-14T02:00:00.000Z'); // 20:00 CST
  assert.equal(d.end, '2026-11-14T03:00:00.000Z');
  assert.equal(d.allDay, false);
});
await check('a weekly COUNT=4 repeat gives four occurrences at the same wall-clock time', () => {
  assert.deepEqual(starts(run(practice)), ['2026-11-14T21:00:00.000Z', '2026-11-21T21:00:00.000Z', '2026-11-28T21:00:00.000Z', '2026-12-05T21:00:00.000Z']);
});
await check('wall-clock time survives the end of daylight saving (CDT -> CST on 1 Nov 2026)', () => {
  const out = expandEvents(parseEvents(feed(ev(['DTSTART;TZID=America/Chicago:20261025T150000', 'DTEND;TZID=America/Chicago:20261025T160000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:S', 'UID:dst']))), Date.UTC(2026, 9, 24), Date.UTC(2026, 11, 1));
  assert.deepEqual(starts(out), ['2026-10-25T20:00:00.000Z', '2026-11-01T21:00:00.000Z', '2026-11-08T21:00:00.000Z']);
});
await check('EXDATE skips an occurrence without extending COUNT', () => {
  const e = ev(['DTSTART;TZID=America/Chicago:20261114T150000', 'DTEND;TZID=America/Chicago:20261114T160000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=America/Chicago:20261121T150000', 'SUMMARY:X', 'UID:ex']);
  assert.deepEqual(starts(run(e)), ['2026-11-14T21:00:00.000Z', '2026-11-28T21:00:00.000Z', '2026-12-05T21:00:00.000Z']);
});
await check('an edited occurrence replaces its slot; a cancelled one disappears', () => {
  const master = ev(['DTSTART;TZID=America/Chicago:20261116T180000', 'DTEND;TZID=America/Chicago:20261116T190000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Class', 'UID:cls']);
  const moved = ev(['RECURRENCE-ID;TZID=America/Chicago:20261123T180000', 'DTSTART;TZID=America/Chicago:20261123T190000', 'DTEND;TZID=America/Chicago:20261123T200000', 'SUMMARY:Class (moved)', 'UID:cls']);
  const gone = ev(['RECURRENCE-ID;TZID=America/Chicago:20261130T180000', 'DTSTART;TZID=America/Chicago:20261130T180000', 'STATUS:CANCELLED', 'SUMMARY:Class', 'UID:cls']);
  const out = run(master, moved, gone);
  assert.deepEqual(out.map((e) => [e.title, e.start]), [['Class', '2026-11-17T00:00:00.000Z'], ['Class (moved)', '2026-11-24T01:00:00.000Z']]);
});
await check('weekly BYDAY=MO,WE', () => {
  const e = ev(['DTSTART;TZID=America/Chicago:20261116T060000', 'DTEND;TZID=America/Chicago:20261116T070000', 'RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE', 'SUMMARY:Gym', 'UID:gym']);
  assert.deepEqual(starts(run(e)), ['2026-11-16T12:00:00.000Z', '2026-11-18T12:00:00.000Z', '2026-11-23T12:00:00.000Z', '2026-11-25T12:00:00.000Z']);
});
await check('monthly "second Tuesday" (BYDAY=2TU), including January across the year end', () => {
  const e = ev(['DTSTART;TZID=America/Chicago:20261110T190000', 'DTEND;TZID=America/Chicago:20261110T200000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'SUMMARY:Board', 'UID:board']);
  assert.deepEqual(starts(run(e)), ['2026-12-09T01:00:00.000Z', '2027-01-13T01:00:00.000Z', '2027-02-10T01:00:00.000Z']);
});
await check('an all-day yearly repeat (birthday) lands on the right date, with an exclusive end', () => {
  const e = ev(['DTSTART;VALUE=DATE:20151225', 'DTEND;VALUE=DATE:20151226', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday', 'UID:bday']);
  const [b] = run(e);
  assert.deepEqual([b.start, b.end, b.allDay], ['2026-12-25', '2026-12-26', true]);
  assert.equal(run(e).length, 1);
});
await check('a multi-day all-day event keeps its exclusive end', () => {
  const [t] = run(ev(['DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261123', 'SUMMARY:Trip', 'UID:trip']));
  assert.deepEqual([t.start, t.end], ['2026-11-20', '2026-11-23']);
});
await check('an all-day event with no DTEND lasts one day', () => {
  const [t] = run(ev(['DTSTART;VALUE=DATE:20261120', 'SUMMARY:One', 'UID:one']));
  assert.equal(t.end, '2026-11-21');
});
await check('a rule we do not support shows once and is flagged, never dropped', () => {
  const [u] = run(ev(['DTSTART;TZID=America/Chicago:20261127T120000', 'DTEND;TZID=America/Chicago:20261127T130000', 'RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR', 'SUMMARY:Last Friday', 'UID:u']));
  assert.equal(u.partialRepeat, true);
  assert.equal(u.start, '2026-11-27T18:00:00.000Z');
});
await check('events outside the window are left out; one in progress yesterday evening is kept', () => {
  const old = ev(['DTSTART;TZID=America/Chicago:20261001T100000', 'DTEND;TZID=America/Chicago:20261001T110000', 'SUMMARY:Old', 'UID:old']);
  const far = ev(['DTSTART;TZID=America/Chicago:20270601T100000', 'DTEND;TZID=America/Chicago:20270601T110000', 'SUMMARY:Far', 'UID:far']);
  assert.deepEqual(run(old, far), []);
});
await check('output is sorted by start', () => {
  assert.equal(run(practice, dinner)[0].title, 'Dinner, drinks');
});
await check('buildCalendar names the calendar and tolerates an empty feed (real, not an error)', () => {
  assert.equal(buildCalendar(feed(dinner), NOW).name, 'Test cal');
  assert.deepEqual(buildCalendar(feed(), NOW).events, []);
});
await check('unescapeText handles \\n \\, \; \\\\', () => assert.equal(unescapeText('a\\nb\\,c\;d\\\\e'), 'a\nb,c;d\\e'));

await check('the feed URL: webcal becomes https; only Apple published-calendar links pass', () => {
  assert.equal(normalizeCalendarUrl('webcal://p119-caldav.icloud.com/published/2/ABC'), 'https://p119-caldav.icloud.com/published/2/ABC');
  for (const bad of [undefined, '', 'http://p119-caldav.icloud.com/published/2/A', 'https://evil.example/published/2/A', 'https://p119-caldav.icloud.com.evil.example/published/2/A', 'https://p119-caldav.icloud.com/other/2/A', 'not a url']) assert.equal(normalizeCalendarUrl(bad), null, String(bad));
});

const URL_OK = 'webcal://p119-caldav.icloud.com/published/2/FAKEFAKEFAKEFAKE';
const fakeFeed = (text, status = 200) => { const f = async (url) => { f.urls.push(url); return { ok: status === 200, status, text: async () => text }; }; f.urls = []; return f; };

await check('fetchCalendar asks for the https URL and rejects a non-calendar answer', async () => {
  const f = fakeFeed(feed(dinner));
  await fetchCalendar(URL_OK, f, NOW);
  assert.equal(f.urls[0], 'https://p119-caldav.icloud.com/published/2/FAKEFAKEFAKEFAKE');
  await assert.rejects(fetchCalendar(URL_OK, fakeFeed('<html>nope</html>'), NOW), /did not return a calendar/);
  await assert.rejects(fetchCalendar(URL_OK, fakeFeed('', 404), NOW), /HTTP 404/);
});

async function call(fetchFn) {
  const res = { code: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, end() { return this; } };
  res.json = function (b) { this.body = b; return this; };
  await handler({ method: 'GET', query: { resource: 'calendar' }, body: {}, headers: {} }, res, fetchFn);
  return res;
}
const saved = process.env.FAM_CALENDAR_ICS;
await check('the calendar route is public: 503 when not configured', async () => {
  delete process.env.FAM_CALENDAR_ICS; resetPhotosCache();
  assert.equal((await call(fakeFeed(feed()))).code, 503);
});
await check('the calendar route serves events and caches them', async () => {
  process.env.FAM_CALENDAR_ICS = URL_OK; resetPhotosCache();
  const f = fakeFeed(feed(ev(['DTSTART;VALUE=DATE:20991231', 'SUMMARY:Far future', 'UID:f'])));
  const r1 = await call(f); const r2 = await call(f);
  assert.equal(r1.code, 200); assert.equal(r2.code, 200);
  assert.equal(f.urls.length, 1, 'second request should come from the cache');
  assert.ok(Array.isArray(r1.body.events));
});
await check('a failed read is a 502 that never contains the feed link', async () => {
  process.env.FAM_CALENDAR_ICS = URL_OK; resetPhotosCache();
  const r = await call(async () => { throw new Error(`boom ${URL_OK} ${'https://p119-caldav.icloud.com/published/2/FAKEFAKEFAKEFAKE'}`); });
  assert.equal(r.code, 502);
  assert.ok(!JSON.stringify(r.body).includes('FAKEFAKEFAKEFAKE'));
});

if (saved === undefined) delete process.env.FAM_CALENDAR_ICS; else process.env.FAM_CALENDAR_ICS = saved;
if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
