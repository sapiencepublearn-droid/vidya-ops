import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from '../web/api-client.js';

/**
 * These check the UI layer without a browser: that the screens exist, call
 * only real client methods, and never do the things the security model
 * forbids. Browser rendering is verified separately, by a person.
 */
const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const App = read('../web/App.jsx');
const Schools = read('../web/Schools.jsx');
const Punch = read('../web/Punch.jsx');
const client = read('../web/api-client.js');
const ui = [App, Schools, Punch].join('\n');
const uiCode = strip(ui);

/* ─────────────────────────────────────────── 1-3  Schools screen */

test('the Schools screen exists and is reachable from admin navigation', () => {
  assert.match(App, /\['schools', 'Schools'\]/, 'Schools appears in the admin nav');
  assert.match(App, /page === 'schools' && <ASchools/, 'and renders a screen');
  assert.ok(Schools.includes('export function AdminSchools'), 'the screen is implemented');
});

test('school management lives only in the admin shell', () => {
  // The employee shell must not render school management anywhere.
  const employeeShell = App.slice(App.indexOf('function EmployeeApp'), App.indexOf('function Admin('));
  assert.equal(/AdminSchools|createSchool|updateSchool|assignSchool/.test(employeeShell), false,
    'no school controls in the employee app');
});

test('the Schools list offers search, zone filter and active filter', () => {
  assert.match(Schools, /Search name, zone or address/);
  assert.match(Schools, /All zones/);
  assert.match(Schools, /value="inactive"/);
});

/* ─────────────────────────────────────────── 4-7  add, edit, deactivate */

test('add and edit use the existing Prompt 44 endpoints', () => {
  assert.match(Schools, /api\.admin\.createSchool\(/);
  assert.match(Schools, /api\.admin\.updateSchool\(/);
  const c = createClient({ baseUrl: '/api' });
  assert.equal(typeof c.admin.createSchool, 'function');
  assert.equal(typeof c.admin.updateSchool, 'function');
});

test('the school form validates coordinates and radius before submitting', () => {
  assert.match(Schools, /lat >= -90 && lat <= 90/);
  assert.match(Schools, /lng >= -180 && lng <= 180/);
  assert.match(Schools, /radius >= 20 && radius <= 2000/);
});

test('the form never fills in coordinates for the admin', () => {
  // A guessed coordinate silently breaks attendance at that school.
  assert.equal(/latitude:\s*1[23]\.\d/.test(strip(Schools)), false, 'no default latitude');
  assert.equal(/longitude:\s*[78]\d\.\d/.test(strip(Schools)), false, 'no default longitude');
  assert.match(Schools, /Do not estimate/, 'and it says where to get them');
});

test('the UI deactivates rather than deletes', () => {
  assert.match(Schools, /isActive: !f\.isActive/);
  assert.equal(/deleteSchool|method: 'DELETE'/.test(uiCode), false, 'no delete path in the UI');
  assert.equal(/deleteSchool/.test(client), false, 'and none in the client');
});

/* ─────────────────────────────────────────── 8-10  assignments */

test('assignment management uses the existing assignment API', () => {
  assert.match(Schools, /api\.admin\.assignSchool\(id, employeeId, remove\)/);
  assert.match(client, /\/admin\/schools\/\$\{id\}\/assign/);
});

test('the employee app offers no way to change assignments', () => {
  assert.equal(/assignSchool/.test(Punch), false);
  const employeeShell = App.slice(App.indexOf('function EmployeeApp'), App.indexOf('function Admin('));
  assert.equal(/assignSchool/.test(employeeShell), false);
});

test('the assignment restriction is explained rather than hidden', () => {
  assert.match(Schools, /Only these people can punch in here/);
});

/* ─────────────────────────── 11-12  punch UI never classifies location */

test('the employee sees Punch In and Punch Out', () => {
  assert.match(Punch, /label="Punch In"/);
  assert.match(Punch, /label="Punch Out"/);
});

test('SECURITY: the UI never asks the employee where they are', () => {
  assert.equal(/Select School|Select Zone|Office or School\?|Where are you/i.test(ui), false,
    'no manual location choice anywhere');
  // No school picker in the punch flow at all.
  assert.equal(/<select[^>]*school/i.test(Punch), false);
});

test('SECURITY: the client never sends a location classification', () => {
  const punchCode = strip(Punch);
  assert.equal(/school_id|schoolId\s*:|locationType\s*:\s*['"]/.test(punchCode), false,
    'no client-declared school or type is submitted');
  // Only the raw fix from readFix() goes to the server.
  assert.match(punchCode, /const fix = await readFix\(\)/);
  assert.match(punchCode, /api\.checkIn\(fix, actionKey\.current\)/);
});

test('SECURITY: the client does not compute distance or decide a match', () => {
  const code = strip(ui);
  assert.equal(/haversine|metresBetween|R_EARTH|6371/.test(code), false,
    'no distance maths in the browser');
});

/* ─────────────────────────── 13-17  results come from the server */

test('office and school results are rendered from server fields', () => {
  assert.match(Punch, /result\?\.locationType \|\| att\?\.location_type/);
  assert.match(Punch, /result\?\.location \|\| att\?\.site_name/);
  assert.match(Punch, /result\?\.zone \|\| att\?\.site_zone/);
  assert.match(Punch, /type === 'SCHOOL' \? 'School visit' : 'Office attendance'/);
});

test('the ambiguity message is the safe one, and picks nothing', () => {
  assert.match(Punch, /too close to multiple approved school locations/);
  assert.match(Punch, /Attendance was not recorded/);
  assert.equal(/candidates\[0\]|pickSchool|chooseSchool/.test(Punch), false,
    'the UI must not resolve an ambiguity itself');
});

test('outside an approved location is explained without leaking policy', () => {
  assert.match(Punch, /not currently inside an approved attendance location/);
});

/* ─────────────────────────────────────────── 18  GPS error handling */

test('every GPS failure has a specific, actionable message', () => {
  for (const code of ['location_denied', 'poor_accuracy', 'outside_radius',
                      'ambiguous_location', 'no_geolocation', 'network_error']) {
    assert.ok(Punch.includes(`case '${code}':`), `${code} is handled`);
  }
  assert.match(Punch, /Location permission is required to record attendance/);
  assert.match(Punch, /location accuracy is currently too low/);
});

test('SECURITY: the spoofing message reveals nothing about detection', () => {
  const block = Punch.slice(Punch.indexOf("case 'mock_location'"), Punch.indexOf("case 'network_error'"));
  // Check the strings the user actually sees, not the comment that explains
  // why they are vague — the comment naming "spoofing" is the point.
  // Drop the case label: 'mock_location' is the server's error code, not
  // anything a user reads.
  const shown = [...strip(block).replace(/case '[^']+':/g, '').matchAll(/'([^']{12,})'/g)]
    .map((m) => m[1]).join(' ');
  assert.equal(/mock|spoof|fake|emulat|detect/i.test(shown), false,
    `user-facing text must be generic, got: ${shown}`);
  assert.match(block, /could not be recorded from this device/);
});

/* ─────────────────────────── 20-23  WhatsApp is manual and server-sourced */

test('the WhatsApp draft comes from the server, not rebuilt in the browser', () => {
  assert.match(Punch, /const draft = result\?\.visitDraft \|\| null/);
  // No attendance facts reassembled client-side into a message.
  assert.equal(/School Visit Update/.test(Punch), false,
    'the message text is never composed in the UI');
});

test('the draft appears only for a completed school visit', () => {
  assert.match(Punch, /type === 'SCHOOL' && draft && <WhatsAppDraft/);
});

test('SECURITY: nothing is sent automatically and no credentials exist', () => {
  const code = strip(ui);
  assert.equal(/WHATSAPP_TOKEN|graph\.facebook|business_account|messages\/send/i.test(code), false,
    'no WhatsApp API usage');
  // wa.me only opens a chat with prefilled text; the person presses Send.
  assert.match(Punch, /https:\/\/wa\.me\/\?text=\$\{encodeURIComponent\(draft\)\}/);
  assert.equal(/Message sent|Sent to the group|WhatsApp sent/i.test(code), false,
    'the UI never claims a message was sent');
});

test('there is a fallback when WhatsApp cannot open', () => {
  assert.match(Punch, /Copy message/);
  assert.match(Punch, /could not be opened from here/);
  assert.match(Punch, /Show text/);
});

test('office attendance offers no WhatsApp action', () => {
  const completed = Punch.slice(Punch.indexOf('function Completed'), Punch.indexOf('function WhatsAppDraft'));
  assert.match(completed, /type === 'SCHOOL' && draft/);
  assert.equal(/^\s*<WhatsAppDraft/m.test(completed.replace(/type === 'SCHOOL' && draft && /, '')), false);
});

/* ─────────────────────────── 20-21  history and admin view */

test('attendance history shows type, location and zone from stored data', () => {
  const hist = App.slice(App.indexOf('function EAttendance'), App.indexOf('function EClaims'));
  assert.match(hist, /a\.location_type === 'SCHOOL'/);
  assert.match(hist, /a\.site_name/);
  assert.match(hist, /a\.site_zone/);
  assert.equal(/const sample|placeholder|example|dummy/i.test(strip(hist)), false,
    'no invented rows');
});

test('the admin attendance view shows who was where', () => {
  const view = App.slice(App.indexOf('function AAttendance'), App.indexOf('function ANews'));
  assert.match(view, /r\.employee_name/);
  assert.match(view, /r\.location_type === 'SCHOOL' \? 'School' : 'Office'/);
  assert.match(view, /r\.site_zone/);
  assert.match(view, /api\.admin\.attendance\(date\)/);
});

/* ─────────────────────────── 23  loading and double-submit */

test('the punch flow shows progress and blocks double submission', () => {
  assert.match(Punch, /Getting location…/);
  assert.match(Punch, /Checking attendance location…/);
  assert.match(Punch, /Completing attendance…/);
  assert.match(Punch, /disabled=\{busy\}/);
  // One idempotency key per tap, reused across retries of that same tap.
  assert.match(Punch, /if \(!actionKey\.current\) actionKey\.current = newActionKey\(\)/);
});

/* ─────────────────────────── 25  location privacy */

test('location is read only at punch time, never continuously', () => {
  const code = strip(ui);
  assert.equal(/watchPosition|setInterval\([^)]*readFix|navigator\.geolocation\.watch/.test(code), false,
    'no continuous tracking');
  assert.equal((code.match(/readFix\(\)/g) || []).length, 1,
    'location is read in exactly one place');
});

/* ─────────────────────────── 26  19:00 auto-close stays deferred */

test('no automatic 19:00 punch-out exists in the UI', () => {
  const code = strip(ui);
  assert.equal(/19:00|autoClose|auto_close|AUTO_CLOSED/.test(code), false);
});

/* ─────────────────────────────────────────── school map */

test('the map renders a real basemap, not a drawn grid', () => {
  const Map = read('../web/SchoolMap.jsx');
  assert.match(Map, /tile\.openstreetmap\.org/, 'uses real map tiles');
  assert.match(Map, /L\.map\(/, 'uses a map library rather than hand-drawn SVG');
  assert.equal(/Degree grid|strokeDasharray="3 5"/.test(Map), false,
    'the coordinate-grid placeholder is gone');
});

test('the basemap needs no API key or paid account', () => {
  const Map = strip(read('../web/SchoolMap.jsx'));
  assert.equal(/api[_-]?key|apiKey|access_token|mapbox|googleapis\.com\/maps\/api/i.test(Map), false,
    'no keyed or paid map provider');
});

test('only schools with coordinates get a marker', () => {
  const Map = read('../web/SchoolMap.jsx');
  assert.match(Map, /const hasCoords = \(s\) => s\.latitude !== null && s\.longitude !== null/);
  assert.match(Map, /\.filter\(hasCoords\)/);
  assert.match(Map, /Location not set \(\{missing\.length\}\)/,
    'schools without coordinates are listed rather than plotted');
});

test('a marker shows the school name, zone and details', () => {
  const Map = read('../web/SchoolMap.jsx');
  assert.match(Map, /bindTooltip\(s\.name/);
  assert.match(Map, /\{selected\.zone\}/);
  assert.match(Map, /View Details/);
});

test('directions open Google Maps, with an origin only when shared', () => {
  const Map = read('../web/SchoolMap.jsx');
  assert.match(Map, /google\.com\/maps\/dir/);
  assert.match(Map, /params\.set\('origin'/);
  assert.match(Map, /if \(school\.latitude === null \|\| school\.longitude === null\) return null/,
    'a school with no position gets no directions link');
});

test('SECURITY: the map reads location once and never watches it', () => {
  const Map = read('../web/SchoolMap.jsx');
  assert.equal(/watchPosition/.test(Map), false, 'no continuous tracking');
  assert.equal((Map.match(/getCurrentPosition/g) || []).length, 1,
    'location is requested in exactly one place, on an explicit tap');
});

test('the referrer policy allows OSM tiles to load', () => {
  // OpenStreetMap's tile policy (since March 2026) blocks requests whose
  // Referrer-Policy is no-referrer or same-origin. Helmet's default is
  // no-referrer, which silently blocks every tile with no visible error.
  const app = read('../src/app.js');
  assert.match(app, /referrerPolicy:\s*\{\s*policy:\s*'strict-origin-when-cross-origin'\s*\}/);
});

test('the tile layer itself also sets a compatible referrer policy', () => {
  const Map = read('../web/SchoolMap.jsx');
  const occurrences = (Map.match(/referrerPolicy: 'strict-origin-when-cross-origin'/g) || []).length;
  assert.equal(occurrences, 2, 'both the school map and the evidence map set it');
});

test('SECURITY: the tile exception does not loosen scripts or connections', () => {
  // Raw source, not stripped: the tile URL contains "/*", which a naive
  // comment-stripper mistakes for the start of a block comment.
  const app = read('../src/app.js');
  const block = app.slice(app.indexOf('contentSecurityPolicy'), app.indexOf('app.use(express.json'));
  assert.match(block, /'img-src':/, 'img-src is widened');
  assert.equal(/'script-src'|'connect-src'|'default-src'|'frame-ancestors'/.test(block), false,
    'every other directive is left at its default');
  assert.match(block, /useDefaults: true/, 'the rest of the default policy still applies');
});

/* ─────────────────────────── plumbing */

test('every client method the new screens call exists', () => {
  const c = createClient({ baseUrl: '/api' });
  const called = new Set();
  for (const m of ui.matchAll(/\bapi\.(admin\.)?([a-zA-Z]+)\s*\(/g)) {
    called.add(`${m[1] ? 'admin.' : ''}${m[2]}`);
  }
  const missing = [...called].filter((n) => {
    const t = n.startsWith('admin.') ? c.admin?.[n.slice(6)] : c[n];
    return typeof t !== 'function';
  });
  assert.deepEqual(missing, [], `missing client methods: ${missing.join(', ')}`);
});

test('the new screens never call fetch directly', () => {
  assert.equal(/[^.\w]fetch\s*\(/.test(strip(Schools)), false);
  assert.equal(/[^.\w]fetch\s*\(/.test(strip(Punch)), false);
});

test('the new screens render loading, error and empty states', () => {
  for (const [name, src] of [['Schools', Schools], ['Punch', Punch]]) {
    assert.match(src, /loading/, `${name} handles loading`);
    assert.match(src, /error/, `${name} handles errors`);
  }
  assert.match(Schools, /Blank title=/);
  assert.match(Schools, /onRetry=/);
});
