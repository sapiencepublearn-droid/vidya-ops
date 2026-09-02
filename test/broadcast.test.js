import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api, tokenFor, db } from './helpers.js';

let fx;
const key = () => `b-${Math.random().toString(36).slice(2)}`;
const HOLIDAY = {
  title: 'Office Holiday',
  message: 'Tomorrow will be a holiday. The office will remain closed.',
  priority: 'Important',
};

before(async () => { await boot(); });
beforeEach(async () => {
  fx = await reset();
  await db.query(`TRUNCATE broadcast_reads, broadcasts CASCADE`);
  await db.query(`TRUNCATE idempotency_keys CASCADE`);
});
after(async () => { await shutdown(); });

/* 1 */
test('admin can create and publish a broadcast', async () => {
  const token = await tokenFor('boss@x.in');
  const r = await api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY });
  assert.equal(r.status, 201);
  assert.equal(r.body.title, 'Office Holiday');
  assert.equal(r.body.priority, 'Important');
  assert.ok(r.body.published_at, 'publishing is the act of creating it');
});

/* 2 */
test('an employee cannot create a broadcast', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY });
  assert.equal(r.status, 403);
  const { rows } = await db.query(`SELECT count(*)::int n FROM broadcasts`);
  assert.equal(rows[0].n, 0);
});

/* 12 — the database refuses even if a future route forgets to check */
test('RLS blocks an employee from inserting a broadcast directly', async () => {
  const { pool } = await import('../src/core.js');
  const { tx } = await import('../src/core.js');
  await assert.rejects(
    () => tx({ id: fx.alice.employee_id, isAdmin: false }, (c) => c.query(
      `INSERT INTO broadcasts (title, message, created_by) VALUES ('x','y',$1)`,
      [fx.alice.employee_id])),
    /row-level security|permission/i);
});

/* 4, 5 — every active employee sees it */
test('every active employee can retrieve the published broadcast', async () => {
  const admin = await tokenFor('boss@x.in');
  await api('/api/admin/broadcasts', { method: 'POST', token: admin, body: HOLIDAY });

  for (const email of ['alice@x.in', 'bob@x.in', 'boss@x.in']) {
    const token = await tokenFor(email);
    const list = await api('/api/broadcasts', { token });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1, `${email} must see the broadcast`);
    assert.equal(list.body[0].title, 'Office Holiday');
    assert.equal(list.body[0].message, HOLIDAY.message, 'the full message is readable');
    assert.equal(list.body[0].published_by, 'Boss');
    assert.equal(list.body[0].read, false, 'it starts unread');
  }
});

/* 10 — read/unread tracking, which is what the employee UI renders */
test('opening a broadcast marks it read for that employee only', async () => {
  const admin = await tokenFor('boss@x.in');
  const b = (await api('/api/admin/broadcasts', { method: 'POST', token: admin, body: HOLIDAY })).body;

  const aliceT = await tokenFor('alice@x.in');
  assert.equal((await api(`/api/broadcasts/${b.broadcast_id}/read`, { method: 'POST', token: aliceT })).status, 204);

  const alice = await api('/api/broadcasts', { token: aliceT });
  assert.equal(alice.body[0].read, true);

  const bobT = await tokenFor('bob@x.in');
  const bob = await api('/api/broadcasts', { token: bobT });
  assert.equal(bob.body[0].read, false, 'Bob\'s copy is still unread');
});

test('marking read twice is harmless', async () => {
  const admin = await tokenFor('boss@x.in');
  const b = (await api('/api/admin/broadcasts', { method: 'POST', token: admin, body: HOLIDAY })).body;
  const token = await tokenFor('alice@x.in');
  await api(`/api/broadcasts/${b.broadcast_id}/read`, { method: 'POST', token });
  assert.equal((await api(`/api/broadcasts/${b.broadcast_id}/read`, { method: 'POST', token })).status, 204);
  const { rows } = await db.query(`SELECT count(*)::int n FROM broadcast_reads`);
  assert.equal(rows[0].n, 1);
});

/* 6 — inactive employees are excluded from the notification fan-out */
test('inactive employees do not receive the broadcast notification', async () => {
  await db.query(`UPDATE employees SET status='Inactive' WHERE email='bob@x.in'`);
  const admin = await tokenFor('boss@x.in');
  await api('/api/admin/broadcasts', { method: 'POST', token: admin, body: HOLIDAY });

  const { rows } = await db.query(
    `SELECT count(*)::int n FROM notifications WHERE kind='broadcast' AND recipient_id=$1`,
    [fx.bob.employee_id]);
  assert.equal(rows[0].n, 0, 'an inactive account is not notified');

  const active = await db.query(`SELECT count(*)::int n FROM notifications WHERE kind='broadcast'`);
  assert.equal(active.rows[0].n, 2, 'the two active employees are');
});

/* 7 — idempotency */
test('a repeated publish with the same key does not duplicate the broadcast', async () => {
  const token = await tokenFor('boss@x.in');
  const k = key();
  const first = await api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY, idempotencyKey: k });
  assert.equal(first.status, 201);

  const replay = await api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY, idempotencyKey: k });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.broadcast_id, first.body.broadcast_id);

  const { rows } = await db.query(`SELECT count(*)::int n FROM broadcasts`);
  assert.equal(rows[0].n, 1, 'clicking Publish twice sends one announcement');
});

test('RACE: simultaneous publishes with one key create one broadcast', async () => {
  const token = await tokenFor('boss@x.in');
  const k = key();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY, idempotencyKey: k })));
  assert.equal(results.filter((r) => r.status >= 500).length, 0, 'no 500s');
  const { rows } = await db.query(`SELECT count(*)::int n FROM broadcasts`);
  assert.equal(rows[0].n, 1);
});

/* 8 — the P1 reliability rule */
test('a notification failure does not roll back the broadcast', async () => {
  const token = await tokenFor('boss@x.in');
  await db.query(`ALTER TABLE notifications ADD CONSTRAINT tmp_break CHECK (false) NOT VALID`);
  await db.query(`ALTER TABLE notifications VALIDATE CONSTRAINT tmp_break`).catch(() => {});
  try {
    const r = await api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY });
    assert.equal(r.status, 201, 'the announcement is published even though notifying failed');

    const { rows } = await db.query(`SELECT count(*)::int n FROM broadcasts`);
    assert.equal(rows[0].n, 1);
    const notif = await db.query(`SELECT count(*)::int n FROM notifications WHERE kind='broadcast'`);
    assert.equal(notif.rows[0].n, 0);

    // And it is still retrievable, which is why it is not stored only as a notification.
    const alice = await api('/api/broadcasts', { token: await tokenFor('alice@x.in') });
    assert.equal(alice.body.length, 1, 'employees can still read it');
  } finally {
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT tmp_break`);
  }
});

/* 9 — no modification path for anyone, admin included */
test('a published broadcast cannot be deleted', async () => {
  const token = await tokenFor('boss@x.in');
  const b = (await api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY })).body;
  await assert.rejects(
    () => db.query(`DELETE FROM broadcasts WHERE broadcast_id=$1`, [b.broadcast_id]),
    /append-only/);
});

test('an employee cannot reach the admin broadcast list', async () => {
  const admin = await tokenFor('boss@x.in');
  await api('/api/admin/broadcasts', { method: 'POST', token: admin, body: HOLIDAY });
  const token = await tokenFor('alice@x.in');
  assert.equal((await api('/api/admin/broadcasts', { token })).status, 403);
});

/* 11 — audit */
test('publishing is audited with the actor', async () => {
  const token = await tokenFor('boss@x.in');
  const b = (await api('/api/admin/broadcasts', { method: 'POST', token, body: HOLIDAY })).body;
  const { rows } = await db.query(
    `SELECT a.action, e.name AS actor FROM audit_log a
       LEFT JOIN employees e ON e.employee_id = a.actor_id
      WHERE a.entity='broadcasts' AND a.record_id=$1`, [b.broadcast_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'insert');
  assert.equal(rows[0].actor, 'Boss', 'the audit names who sent it');
});

/* admin visibility */
test('admin sees how many people have read each broadcast', async () => {
  const admin = await tokenFor('boss@x.in');
  const b = (await api('/api/admin/broadcasts', { method: 'POST', token: admin, body: HOLIDAY })).body;

  const before = await api('/api/admin/broadcasts', { token: admin });
  assert.equal(before.body[0].read_count, 0);
  assert.equal(before.body[0].audience, 3, 'all active employees');

  await api(`/api/broadcasts/${b.broadcast_id}/read`, { method: 'POST', token: await tokenFor('alice@x.in') });
  const after = await api('/api/admin/broadcasts', { token: admin });
  assert.equal(after.body[0].read_count, 1);
});

/* validation */
test('a broadcast needs a title and a message', async () => {
  const token = await tokenFor('boss@x.in');
  for (const body of [{ title: '', message: 'x' }, { title: 'x', message: '' }, { title: 'x' }]) {
    const r = await api('/api/admin/broadcasts', { method: 'POST', token, body });
    assert.equal(r.status, 422, `${JSON.stringify(body)} must be refused`);
  }
});

test('an unknown priority is refused', async () => {
  const token = await tokenFor('boss@x.in');
  const r = await api('/api/admin/broadcasts', { method: 'POST', token,
    body: { ...HOLIDAY, priority: 'Catastrophic' } });
  assert.equal(r.status, 422);
});

test('unauthenticated callers cannot read broadcasts', async () => {
  const admin = await tokenFor('boss@x.in');
  await api('/api/admin/broadcasts', { method: 'POST', token: admin, body: HOLIDAY });
  assert.equal((await api('/api/broadcasts')).status, 401);
});
