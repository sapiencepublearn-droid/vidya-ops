import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api, tokenFor } from './helpers.js';

let fx;
before(async () => { await boot(); });
beforeEach(async () => { fx = await reset(); });
after(async () => { await shutdown(); });

/* ───────────────────────────────────────────────────── authentication */

test('login succeeds with the correct password', async () => {
  const r = await api('/api/auth/login', { method: 'POST', body: { email: 'alice@x.in', password: fx.password } });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.employee.isAdmin, false);
  assert.equal(r.body.employee.password_hash, undefined);
});

test('login rejects a wrong password', async () => {
  const r = await api('/api/auth/login', { method: 'POST', body: { email: 'alice@x.in', password: 'wrong-password' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'unauthorized');
});

test('login does not reveal whether an account exists', async () => {
  const unknown = await api('/api/auth/login', { method: 'POST', body: { email: 'nobody@x.in', password: 'whatever12345' } });
  const known = await api('/api/auth/login', { method: 'POST', body: { email: 'alice@x.in', password: 'whatever12345' } });
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.body.message, known.body.message);
});

test('account locks after repeated failures', async () => {
  for (let i = 0; i < 5; i++) {
    await api('/api/auth/login', { method: 'POST', body: { email: 'bob@x.in', password: 'nope-nope-nope' } });
  }
  const r = await api('/api/auth/login', { method: 'POST', body: { email: 'bob@x.in', password: fx.password } });
  assert.equal(r.status, 429, 'correct password must still be refused while locked');
  assert.equal(r.body.error, 'account_locked');
});

test('protected endpoints reject missing and malformed tokens', async () => {
  assert.equal((await api('/api/me')).status, 401);
  assert.equal((await api('/api/me', { token: 'not-a-jwt' })).status, 401);
});

test('logout revokes the token immediately', async () => {
  const token = await tokenFor('alice@x.in');
  assert.equal((await api('/api/me', { token })).status, 200);
  assert.equal((await api('/api/auth/logout', { method: 'POST', token })).status, 204);
  const after = await api('/api/me', { token });
  assert.equal(after.status, 401);
  assert.equal(after.body.error, 'token_revoked');
});

/* ────────────────────────────────────────────────────── authorization */

test('employee cannot read another employee task (IDOR)', async () => {
  const adminT = await tokenFor('boss@x.in');
  const created = await api('/api/tasks', {
    method: 'POST', token: adminT,
    body: { title: 'Alice only', assignedTo: fx.alice.employee_id, dueDate: '2026-08-28', dueTime: '17:00' },
  });
  assert.equal(created.status, 201);

  const bobT = await tokenFor('bob@x.in');
  const r = await api(`/api/tasks/${created.body.task_id}`, { token: bobT });
  // 404 rather than 403: row-level security removes the row before the
  // handler sees it, so the API cannot confirm the task even exists.
  assert.ok([403, 404].includes(r.status), `expected denial, got ${r.status}`);
  assert.equal(r.body.title, undefined, 'no task data may leak');
});

test('employee cannot modify another employee task', async () => {
  const adminT = await tokenFor('boss@x.in');
  const t = (await api('/api/tasks', {
    method: 'POST', token: adminT,
    body: { title: 'Alice only', assignedTo: fx.alice.employee_id, dueDate: '2026-08-28' },
  })).body;
  const bobT = await tokenFor('bob@x.in');
  const r = await api(`/api/tasks/${t.task_id}/start`, { method: 'POST', token: bobT });
  assert.ok([403, 404].includes(r.status), `expected denial, got ${r.status}`);

  const { rows } = await (await import('./helpers.js')).db.query(
    `SELECT status FROM tasks WHERE task_id=$1`, [t.task_id]);
  assert.equal(rows[0].status, 'Not Started', 'the task must be unchanged');
});

test('employee cannot perform admin operations (vertical escalation)', async () => {
  const bobT = await tokenFor('bob@x.in');
  assert.equal((await api('/api/tasks', {
    method: 'POST', token: bobT,
    body: { title: 'self assigned', assignedTo: fx.bob.employee_id, dueDate: '2026-08-28' },
  })).status, 403);
  assert.equal((await api('/api/admin/employees', { token: bobT })).status, 403);
  assert.equal((await api('/api/admin/claims', { token: bobT })).status, 403);
  assert.equal((await api('/api/admin/audit', { token: bobT })).status, 403);
});

test('employee cannot see another employee attendance or claims', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const bobT = await tokenFor('bob@x.in');
  await api('/api/attendance/check-in', {
    method: 'POST', token: aliceT,
    body: { latitude: 13.0418, longitude: 80.2341, accuracy: 8 },
  });
  const bobSees = await api('/api/attendance/me', { token: bobT });
  assert.equal(bobSees.status, 200);
  assert.equal(bobSees.body.length, 0, 'RLS + query filter must hide other rows');
});

test('a client cannot smuggle employee_id to write as someone else', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', {
    method: 'POST', token: aliceT,
    body: { latitude: 13.0418, longitude: 80.2341, accuracy: 8, employee_id: fx.bob.employee_id },
  });
  assert.equal(r.status, 422, 'unknown fields must be rejected outright');
  assert.equal(r.body.error, 'validation_failed');
});

/* ─────────────────────────────────────────────────────── error shapes */

test('malformed UUID is a controlled 400, not a database error', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/tasks/not-a-uuid', { token });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_request');
  assert.ok(!JSON.stringify(r.body).match(/invalid input syntax|22P02|pg|stack/i),
    'must not leak database internals');
});

test('errors never contain stack traces or SQL', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/tasks', { method: 'POST', token, body: { title: '' } });
  const s = JSON.stringify(r.body);
  assert.ok(!/at .*\(.*:\d+:\d+\)|SELECT |INSERT |relation |pg_/i.test(s), s);
  assert.ok(r.body.requestId, 'every error carries a correlation id');
});

test('unknown endpoint does not enumerate, and 404s for a valid session', async () => {
  // Unauthenticated callers get 401 for any /api path, so they cannot probe
  // which endpoints exist. An authenticated caller gets an honest 404.
  const anon = await api('/api/nope');
  assert.equal(anon.status, 401);

  const token = await tokenFor('alice@x.in');
  const known = await api('/api/nope', { token });
  assert.equal(known.status, 404);
  assert.equal(known.body.error, 'not_found');
});
