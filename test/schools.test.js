import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api, tokenFor, db } from './helpers.js';

let fx;
const key = () => `s-${Math.random().toString(36).slice(2)}`;

// Office in the fixtures sits at 13.0418, 80.2341.
const AT_OFFICE = { latitude: 13.0418, longitude: 80.2341, accuracy: 8 };
const ABC = { latitude: 13.0827, longitude: 80.2707 };
const AT_ABC = { ...ABC, accuracy: 8 };
const NOWHERE = { latitude: 12.5000, longitude: 79.5000, accuracy: 8 };

before(async () => { await boot(); });
beforeEach(async () => {
  fx = await reset();
  await db.query(`TRUNCATE idempotency_keys, attendance_incidents CASCADE`);
  await db.query(`DELETE FROM trainer_assignments`);
  await db.query(`UPDATE locations SET zone='Thiruporur' WHERE kind='school'`);
});
after(async () => { await shutdown(); });

/** Alice is a Trainer; assignment is required by the existing policy. */
async function assignAliceToSchool(schoolId) {
  // Through the admin API, which is how it happens in reality and keeps
  // the fixture honest about who is allowed to do it.
  const admin = await tokenFor('boss@x.in');
  const id = schoolId || (await db.query(`SELECT location_id FROM locations WHERE kind='school' LIMIT 1`)).rows[0].location_id;
  const r = await api(`/api/admin/schools/${id}/assign`, { method: 'POST', token: admin,
    body: { employeeId: fx.alice.employee_id } });
  assert.equal(r.status, 200, 'fixture assignment must succeed');
}

/* ───────────────────────────────── 1-5, 19-20  admin school management */

test('admin can create a school', async () => {
  const token = await tokenFor('boss@x.in');
  const r = await api('/api/admin/schools', { method: 'POST', token, body: {
    name: 'XYZ Matriculation', zone: 'Kelambakkam',
    latitude: 12.7900, longitude: 80.2200, radiusMetres: 100 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.kind, 'school');
  assert.equal(r.body.zone, 'Kelambakkam');
  assert.equal(r.body.is_active, true);
});

test('an employee cannot create a school', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/admin/schools', { method: 'POST', token, body: {
    name: 'Fake School', zone: 'Anywhere', latitude: 13.0, longitude: 80.0 } });
  assert.equal(r.status, 403);
});

test('an employee cannot edit a school or move its coordinates', async () => {
  const school = (await db.query(`SELECT location_id FROM locations WHERE kind='school' LIMIT 1`)).rows[0];
  const token = await tokenFor('alice@x.in');
  const r = await api(`/api/admin/schools/${school.location_id}`, { method: 'PATCH', token,
    body: { latitude: 13.0418, longitude: 80.2341, radiusMetres: 2000 } });
  assert.equal(r.status, 403);

  const after = (await db.query(`SELECT latitude, radius_metres FROM locations WHERE location_id=$1`,
    [school.location_id])).rows[0];
  assert.equal(Number(after.latitude), 13.0827, 'coordinates untouched');
  assert.equal(after.radius_metres, 100);
});

test('RLS: an employee cannot insert a location directly', async () => {
  const { tx } = await import('../src/core.js');
  await assert.rejects(
    () => tx({ id: fx.alice.employee_id, isAdmin: false }, (c) => c.query(
      `INSERT INTO locations (kind,name,zone,latitude,longitude,radius_metres)
       VALUES ('school','Backdoor','Zone',13.0,80.0,2000)`)),
    /permission|row-level/i);
});

test('admin can deactivate a school without deleting it', async () => {
  const token = await tokenFor('boss@x.in');
  const school = (await db.query(`SELECT location_id FROM locations WHERE kind='school' LIMIT 1`)).rows[0];
  const r = await api(`/api/admin/schools/${school.location_id}`, { method: 'PATCH', token,
    body: { isActive: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.is_active, false);

  const still = await db.query(`SELECT count(*)::int n FROM locations WHERE location_id=$1`, [school.location_id]);
  assert.equal(still.rows[0].n, 1, 'the record survives so history still resolves');
});

test('a school cannot be deleted at all', async () => {
  const school = (await db.query(`SELECT location_id FROM locations WHERE kind='school' LIMIT 1`)).rows[0];
  await assert.rejects(
    () => db.query(`DELETE FROM locations WHERE location_id=$1`, [school.location_id]),
    /append-only/);
});

test('school changes are audited with a reason', async () => {
  const token = await tokenFor('boss@x.in');
  const s = (await api('/api/admin/schools', { method: 'POST', token, body: {
    name: 'Audited School', zone: 'Zone A', latitude: 12.9, longitude: 80.1 } })).body;

  const { rows } = await db.query(
    `SELECT a.action, a.reason, a.request_id, e.name AS actor
       FROM audit_log a LEFT JOIN employees e ON e.employee_id=a.actor_id
      WHERE a.entity='locations' AND a.record_id=$1`, [s.location_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'school created');
  assert.equal(rows[0].actor, 'Boss');
  assert.ok(rows[0].request_id);
});

test('duplicate active school names are refused', async () => {
  const token = await tokenFor('boss@x.in');
  const body = { name: 'Same Name School', zone: 'Z', latitude: 12.8, longitude: 80.3 };
  assert.equal((await api('/api/admin/schools', { method: 'POST', token, body })).status, 201);
  const dup = await api('/api/admin/schools', { method: 'POST', token, body });
  assert.equal(dup.status, 409);
});

test('a repeated create with the same key makes one school', async () => {
  const token = await tokenFor('boss@x.in');
  const k = key();
  const body = { name: 'Idempotent School', zone: 'Z', latitude: 12.8, longitude: 80.31 };
  const a = await api('/api/admin/schools', { method: 'POST', token, body, idempotencyKey: k });
  const b = await api('/api/admin/schools', { method: 'POST', token, body, idempotencyKey: k });
  assert.equal(a.status, 201);
  assert.equal(b.body.location_id, a.body.location_id);
  const { rows } = await db.query(`SELECT count(*)::int n FROM locations WHERE name='Idempotent School'`);
  assert.equal(rows[0].n, 1);
});

/* ─────────────────────────── 7-12  location detection is server-side */

test('inside the office radius is detected as OFFICE, with no manual choice', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  assert.equal(r.status, 201);
  assert.equal(r.body.locationType, 'OFFICE');
  assert.equal(r.body.zone, null, 'an office has no zone');
});

test('outside the office but inside an assigned school is detected as SCHOOL, with its zone', async () => {
  await assignAliceToSchool();
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });
  assert.equal(r.status, 201);
  assert.equal(r.body.locationType, 'SCHOOL');
  assert.equal(r.body.location, 'ABC School');
  assert.equal(r.body.zone, 'Thiruporur');

  // The matched school is stored on the attendance row, and GPS evidence kept.
  const { rows } = await db.query(
    `SELECT a.check_in_location_id, a.check_in_latitude, a.check_in_accuracy, l.name, l.zone
       FROM attendance a JOIN locations l ON l.location_id=a.check_in_location_id
      WHERE a.employee_id=$1`, [fx.alice.employee_id]);
  assert.equal(rows[0].name, 'ABC School');
  assert.equal(rows[0].zone, 'Thiruporur');
  assert.equal(Number(rows[0].check_in_latitude), 13.0827);
  assert.equal(Number(rows[0].check_in_accuracy), 8);
});

test('SECURITY: a client-supplied school id cannot override GPS', async () => {
  await assignAliceToSchool();
  const school = (await db.query(`SELECT location_id FROM locations WHERE kind='school' LIMIT 1`)).rows[0];
  const token = await tokenFor('alice@x.in');

  // Sitting at the office but claiming to be at the school.
  const r = await api('/api/attendance/check-in', { method: 'POST', token,
    body: { ...AT_OFFICE, school_id: school.location_id, locationType: 'SCHOOL' } });
  assert.equal(r.status, 422, 'unknown fields are rejected outright');
  assert.equal(r.body.error, 'validation_failed');
});

test('SECURITY: GPS decides, even when the payload is clean', async () => {
  await assignAliceToSchool();
  const token = await tokenFor('alice@x.in');
  // Physically at the office: the server must say OFFICE regardless of intent.
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  assert.equal(r.body.locationType, 'OFFICE');
});

test('outside every approved location is rejected, and the incident path works', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: NOWHERE });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'outside_radius');

  const incident = await api('/api/attendance/incidents', { method: 'POST', token,
    body: { kind: 'check_in', reason: 'outside_radius', note: 'At the school gate' } });
  assert.equal(incident.status, 201);

  const { rows } = await db.query(`SELECT count(*)::int n FROM attendance`);
  assert.equal(rows[0].n, 0, 'no attendance is fabricated by reporting a problem');
});

test('an inactive school cannot be punched into', async () => {
  await assignAliceToSchool();
  await db.query(`UPDATE locations SET is_active=false WHERE kind='school'`);
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });
  assert.equal(r.status, 422, 'an inactive school is not an approved location');
});

test('historical attendance survives a school being deactivated', async () => {
  await assignAliceToSchool();
  const token = await tokenFor('alice@x.in');
  await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });
  await db.query(`UPDATE locations SET is_active=false WHERE kind='school'`);

  const { rows } = await db.query(
    `SELECT l.name, l.zone FROM attendance a JOIN locations l ON l.location_id=a.check_in_location_id
      WHERE a.employee_id=$1`, [fx.alice.employee_id]);
  assert.equal(rows[0].name, 'ABC School', 'the visit still resolves to its school');
});

test('an unassigned employee cannot punch in at a school', async () => {
  // Bob has no trainer assignment. The existing policy is preserved.
  const token = await tokenFor('bob@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'outside_radius');
});

/* ───────────────────────────────── 14  overlapping schools */

test('two overlapping schools produce a deterministic answer, never a guess', async () => {
  const admin = await tokenFor('boss@x.in');
  // A second school 40m from ABC: both contain the point, neither clearly nearer.
  const near = await api('/api/admin/schools', { method: 'POST', token: admin, body: {
    name: 'Overlap School', zone: 'Thiruporur',
    latitude: 13.0827 + 0.00036, longitude: 80.2707, radiusMetres: 100 } });
  assert.equal(near.status, 201);

  await assignAliceToSchool();
  await assignAliceToSchool(near.body.location_id);

  const token = await tokenFor('alice@x.in');
  // Standing midway: the server must refuse rather than pick one.
  const r = await api('/api/attendance/check-in', { method: 'POST', token,
    body: { latitude: 13.0827 + 0.00018, longitude: 80.2707, accuracy: 8 } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'ambiguous_location');
  assert.ok(r.body.details.candidates.length >= 2);

  const { rows } = await db.query(`SELECT count(*)::int n FROM attendance`);
  assert.equal(rows[0].n, 0, 'nothing is recorded while the location is unclear');
});

test('a clearly nearer school still wins outright', async () => {
  const admin = await tokenFor('boss@x.in');
  const far = await api('/api/admin/schools', { method: 'POST', token: admin, body: {
    name: 'Far School', zone: 'Thiruporur',
    latitude: 13.0827 + 0.0007, longitude: 80.2707, radiusMetres: 100 } });
  await assignAliceToSchool();
  await assignAliceToSchool(far.body.location_id);

  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });
  assert.equal(r.status, 201);
  assert.equal(r.body.location, 'ABC School');
});

/* ───────────────────────────────── 16-17  race safety preserved */

test('RACE: simultaneous punch-ins create one attendance record', async () => {
  await assignAliceToSchool();
  const token = await tokenFor('alice@x.in');
  const results = await Promise.all(
    Array.from({ length: 6 }, () => api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status >= 500).length, 0);
  const { rows } = await db.query(`SELECT count(*)::int n FROM attendance`);
  assert.equal(rows[0].n, 1);
});

test('RACE: simultaneous punch-outs close the session once', async () => {
  await assignAliceToSchool();
  const token = await tokenFor('alice@x.in');
  await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => api('/api/attendance/check-out', { method: 'POST', token, body: AT_ABC })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status >= 500).length, 0);
});

/* ───────────────────────────────── WhatsApp draft (§56) */

test('a school punch-out produces a reviewable draft with the right details', async () => {
  await assignAliceToSchool();
  const token = await tokenFor('alice@x.in');
  await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });
  const out = await api('/api/attendance/check-out', { method: 'POST', token, body: AT_ABC });

  assert.equal(out.status, 200);
  const d = out.body.visitDraft;
  assert.ok(d, 'a school visit gets a draft');
  assert.match(d, /School Visit Update/);
  assert.match(d, /ABC School/);
  assert.match(d, /Thiruporur/);
  assert.match(d, /Punch In: \d+:\d\d [AP]M/);
  assert.match(d, /Punch Out: \d+:\d\d [AP]M/);
  // en-IN abbreviates some months to four letters ("Sept"), which is fine.
  assert.match(d, /\d{2} \w{3,4} \d{4}/, 'carries the date');
});

test('office attendance does not generate a school visit message', async () => {
  const token = await tokenFor('alice@x.in');
  await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  const out = await api('/api/attendance/check-out', { method: 'POST', token, body: AT_OFFICE });
  assert.equal(out.status, 200);
  assert.equal(out.body.visitDraft, null);
});

test('nothing is sent, and no WhatsApp credentials are required', async () => {
  const fs = await import('node:fs');
  // Strip comments first: the source explains *why* there is no WhatsApp
  // API, and matching that prose would fail a file that is actually correct.
  const src = ['../src/routes.js', '../src/core.js', '../src/app.js']
    .map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/WHATSAPP_TOKEN|graph\.facebook|whatsapp.*api|business_account/i.test(src), false,
    'no WhatsApp API dependency');
  // The draft is text handed back to the client; the server never delivers it.
  assert.equal(/fetch\(['"`]https:\/\/(api\.)?wa/i.test(src), false, 'the server never sends');
});

/* ───────────────────────────────── directory reads */

test('an employee can read the school directory but not change it', async () => {
  const token = await tokenFor('alice@x.in');
  const list = await api('/api/schools', { token });
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 1);
  assert.ok(list.body[0].zone, 'zone is exposed for display');
});

test('the directory searches by name and zone', async () => {
  const admin = await tokenFor('boss@x.in');
  await api('/api/admin/schools', { method: 'POST', token: admin, body: {
    name: 'Government Higher Secondary', zone: 'Chengalpattu', latitude: 12.69, longitude: 79.98 } });

  const byName = await api('/api/schools?q=Government', { token: admin });
  assert.equal(byName.body.length, 1);
  const byZone = await api('/api/schools?q=Chengalpattu', { token: admin });
  assert.equal(byZone.body.length, 1);
});

test('school detail shows assigned employees and visits from existing attendance', async () => {
  await assignAliceToSchool();
  const token = await tokenFor('alice@x.in');
  await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC });

  const school = (await db.query(`SELECT location_id FROM locations WHERE name='ABC School'`)).rows[0];
  const admin = await tokenFor('boss@x.in');
  const r = await api(`/api/schools/${school.location_id}`, { token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.assignedEmployees.length, 1);
  assert.equal(r.body.assignedEmployees[0].name, 'Alice');
  assert.equal(r.body.recentVisits.length, 1);
  assert.equal(r.body.recentVisits[0].employee_name, 'Alice');
});

test('admin can assign and unassign an employee to a school', async () => {
  const school = (await db.query(`SELECT location_id FROM locations WHERE kind='school' LIMIT 1`)).rows[0];
  const admin = await tokenFor('boss@x.in');

  const on = await api(`/api/admin/schools/${school.location_id}/assign`, { method: 'POST', token: admin,
    body: { employeeId: fx.alice.employee_id } });
  assert.equal(on.body.assigned, true);

  const token = await tokenFor('alice@x.in');
  assert.equal((await api('/api/attendance/check-in', { method: 'POST', token, body: AT_ABC })).status, 201);

  const off = await api(`/api/admin/schools/${school.location_id}/assign`, { method: 'POST', token: admin,
    body: { employeeId: fx.alice.employee_id, remove: true } });
  assert.equal(off.body.assigned, false);
});

test('an employee cannot assign themselves to a school', async () => {
  const school = (await db.query(`SELECT location_id FROM locations WHERE kind='school' LIMIT 1`)).rows[0];
  const token = await tokenFor('alice@x.in');
  const r = await api(`/api/admin/schools/${school.location_id}/assign`, { method: 'POST', token,
    body: { employeeId: fx.alice.employee_id } });
  assert.equal(r.status, 403);
});
