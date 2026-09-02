import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api, tokenFor, uploadFile, db, PDF } from './helpers.js';

let fx;
const AT_OFFICE = { latitude: 13.0418, longitude: 80.2341, accuracy: 8 };
const key = () => `k-${Math.random().toString(36).slice(2)}`;

before(async () => { await boot(); });
beforeEach(async () => {
  fx = await reset();
  await db.query(`TRUNCATE idempotency_keys, attendance_incidents CASCADE`);
});
after(async () => { await shutdown(); });

/* ───────────────────────────────────────────────────────── idempotency */

test('a repeated check-in with the same key does not create a second record', async () => {
  const token = await tokenFor('alice@x.in');
  const k = key();

  const first = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE, idempotencyKey: k });
  assert.equal(first.status, 201);

  // The lost-response case: identical request, identical key.
  const replay = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE, idempotencyKey: k });
  assert.equal(replay.status, 201, 'the replay returns the original result, not an error');
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(replay.body.attendance.attendance_id, first.body.attendance.attendance_id);

  const { rows } = await db.query(`SELECT count(*)::int n FROM attendance WHERE employee_id=$1`, [fx.alice.employee_id]);
  assert.equal(rows[0].n, 1);
});

test('a repeated claim with the same key files only one claim', async () => {
  const token = await tokenFor('alice@x.in');
  const bill = (await uploadFile(token, 'b.pdf', PDF)).body.attachment_id;
  const today = (await db.query('SELECT ist_today() AS d')).rows[0].d.toISOString().slice(0, 10);
  const body = { date: today, category: 'Food', amount: 200, attachmentId: bill };
  const k = key();

  const first = await api('/api/claims', { method: 'POST', token, body, idempotencyKey: k });
  assert.equal(first.status, 201);
  const replay = await api('/api/claims', { method: 'POST', token, body, idempotencyKey: k });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.claim_id, first.body.claim_id, 'same claim returned, not a new one');

  const { rows } = await db.query(`SELECT count(*)::int n, sum(amount_paise)::int total FROM claims`);
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].total, 20000, 'the employee is not reimbursed twice');
});

test('the same key with a different body is refused, not silently replayed', async () => {
  const token = await tokenFor('alice@x.in');
  const today = (await db.query('SELECT ist_today() AS d')).rows[0].d.toISOString().slice(0, 10);
  const k = key();
  const b1 = (await uploadFile(token, 'a.pdf', PDF)).body.attachment_id;
  const b2 = (await uploadFile(token, 'b.pdf', PDF)).body.attachment_id;

  const first = await api('/api/claims', { method: 'POST', token,
    body: { date: today, category: 'Food', amount: 100, attachmentId: b1 }, idempotencyKey: k });
  assert.equal(first.status, 201);

  const different = await api('/api/claims', { method: 'POST', token,
    body: { date: today, category: 'Food', amount: 300, attachmentId: b2 }, idempotencyKey: k });
  assert.equal(different.status, 422);
  assert.equal(different.body.error, 'idempotency_key_reused');
});

test('a failed request releases its key so a genuine retry can succeed', async () => {
  const token = await tokenFor('alice@x.in');
  const k = key();

  // Outside the radius: this fails, so the key must not be held.
  const bad = await api('/api/attendance/check-in', { method: 'POST', token,
    body: { latitude: 13.0827, longitude: 80.2707, accuracy: 8 }, idempotencyKey: k });
  assert.equal(bad.status, 422);

  const good = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE, idempotencyKey: k });
  assert.equal(good.status, 201, 'the same key works once the employee reaches the office');
});

test('requests without a key behave exactly as before', async () => {
  const token = await tokenFor('alice@x.in');
  const first = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  assert.equal(first.status, 201);
  const second = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  assert.equal(second.status, 409, 'the unique constraint remains the final protection');
});

test('one employee cannot replay another employee\'s key', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const bobT = await tokenFor('bob@x.in');
  const k = 'shared-key';

  const a = await api('/api/attendance/check-in', { method: 'POST', token: aliceT, body: AT_OFFICE, idempotencyKey: k });
  assert.equal(a.status, 201);
  const b = await api('/api/attendance/check-in', { method: 'POST', token: bobT, body: AT_OFFICE, idempotencyKey: k });
  assert.equal(b.status, 201, 'keys are scoped per employee');
  assert.notEqual(b.body.attendance.attendance_id, a.body.attendance.attendance_id);
});

/* ─────────────────────────────────────── notifications must not roll back */

test('a notification failure does not roll back the business action', async () => {
  const adminT = await tokenFor('boss@x.in');
  const today = (await db.query('SELECT ist_today() AS d')).rows[0].d.toISOString().slice(0, 10);

  // Force every notification insert to fail, the way a constraint problem
  // or a statement timeout would.
  await db.query(`ALTER TABLE notifications ADD CONSTRAINT tmp_break CHECK (false) NOT VALID`);
  await db.query(`ALTER TABLE notifications VALIDATE CONSTRAINT tmp_break`).catch(() => {});
  try {
    const r = await api('/api/tasks', { method: 'POST', token: adminT,
      body: { title: 'Must survive', assignedTo: fx.alice.employee_id, dueDate: today, dueTime: '23:59' } });
    assert.equal(r.status, 201, 'the task is created even though announcing it failed');
    const { rows } = await db.query(`SELECT count(*)::int n FROM tasks WHERE title='Must survive'`);
    assert.equal(rows[0].n, 1);
    const notif = await db.query(`SELECT count(*)::int n FROM notifications`);
    assert.equal(notif.rows[0].n, 0, 'and no notification was written');
  } finally {
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT tmp_break`);
  }
});

/* ──────────────────────────────────────────────────────────── health */

test('health reports healthy with all checks present', async () => {
  const r = await api('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'healthy');
  assert.equal(r.body.checks.database.ok, true);
  assert.equal(r.body.checks.migrations.ok, true);
  assert.equal(r.body.checks.storage.ok, true);
  assert.ok(r.body.version, 'version is reported');
  assert.ok(typeof r.body.checks.database.latencyMs === 'number');
});

/* ──────────────────────────────────────────── attendance incidents */

test('an employee can report a failed check-in without creating attendance', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/incidents', { method: 'POST', token,
    body: { kind: 'check_in', reason: 'outside_radius', note: 'School gate, GPS says 300m',
            latitude: 13.0827, longitude: 80.2707, accuracy: 12, distanceMetres: 300 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.state, 'Open');

  // The core promise: reporting a problem does not fabricate attendance.
  const { rows } = await db.query(`SELECT count(*)::int n FROM attendance`);
  assert.equal(rows[0].n, 0, 'no attendance record may be created by an incident');
});

test('repeated reports on the same day do not queue duplicates', async () => {
  const token = await tokenFor('alice@x.in');
  const body = { kind: 'check_in', reason: 'gps_unavailable' };
  assert.equal((await api('/api/attendance/incidents', { method: 'POST', token, body })).status, 201);
  const again = await api('/api/attendance/incidents', { method: 'POST', token, body });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'incident_exists');
});

test('admins see open incidents and employees see only their own', async () => {
  const aliceT = await tokenFor('alice@x.in');
  await api('/api/attendance/incidents', { method: 'POST', token: aliceT,
    body: { kind: 'check_in', reason: 'poor_accuracy' } });

  const adminT = await tokenFor('boss@x.in');
  const adminView = await api('/api/admin/incidents', { token: adminT });
  assert.equal(adminView.status, 200);
  assert.equal(adminView.body.length, 1);
  assert.equal(adminView.body[0].employee_name, 'Alice');

  const bobT = await tokenFor('bob@x.in');
  assert.equal((await api('/api/admin/incidents', { token: bobT })).status, 403);
  const bobOwn = await api('/api/attendance/incidents/me', { token: bobT });
  assert.equal(bobOwn.body.length, 0, 'Bob must not see Alice\'s report');
});

test('resolving an incident records the decision and never edits attendance', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const inc = (await api('/api/attendance/incidents', { method: 'POST', token: aliceT,
    body: { kind: 'check_in', reason: 'outside_radius' } })).body;

  const adminT = await tokenFor('boss@x.in');
  const r = await api(`/api/admin/incidents/${inc.incident_id}/resolve`, {
    method: 'POST', token: adminT,
    body: { decision: 'Resolved', resolution: 'School coordinates were wrong. Corrected the location record.' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'Resolved');
  assert.ok(r.body.resolved_at);

  const att = await db.query(`SELECT count(*)::int n FROM attendance`);
  assert.equal(att.rows[0].n, 0, 'resolution must not manufacture attendance');

  const again = await api(`/api/admin/incidents/${inc.incident_id}/resolve`, {
    method: 'POST', token: adminT, body: { decision: 'Dismissed', resolution: 'changed mind' } });
  assert.equal(again.status, 409, 'a handled report cannot be re-decided');
});

test('resolving requires a written reason', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const inc = (await api('/api/attendance/incidents', { method: 'POST', token: aliceT,
    body: { kind: 'check_in', reason: 'other' } })).body;
  const adminT = await tokenFor('boss@x.in');
  const r = await api(`/api/admin/incidents/${inc.incident_id}/resolve`, {
    method: 'POST', token: adminT, body: { decision: 'Resolved' } });
  assert.equal(r.status, 422);
});

test('an employee cannot resolve their own incident', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const inc = (await api('/api/attendance/incidents', { method: 'POST', token: aliceT,
    body: { kind: 'check_in', reason: 'other' } })).body;
  const r = await api(`/api/admin/incidents/${inc.incident_id}/resolve`, {
    method: 'POST', token: aliceT, body: { decision: 'Resolved', resolution: 'let me in' } });
  assert.equal(r.status, 403);
});

test('incidents are audited and cannot be deleted', async () => {
  const token = await tokenFor('alice@x.in');
  const inc = (await api('/api/attendance/incidents', { method: 'POST', token,
    body: { kind: 'check_in', reason: 'network_unavailable' } })).body;

  const audit = await db.query(
    `SELECT count(*)::int n FROM audit_log WHERE entity='attendance_incidents' AND record_id=$1`,
    [inc.incident_id]);
  assert.ok(audit.rows[0].n >= 1, 'the report is in the audit trail');

  await assert.rejects(
    () => db.query(`DELETE FROM attendance_incidents WHERE incident_id=$1`, [inc.incident_id]),
    /append-only/);
});
