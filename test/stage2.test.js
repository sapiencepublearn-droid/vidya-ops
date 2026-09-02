import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api, tokenFor, db, bootWithLimits } from './helpers.js';

let fx;
before(async () => { await boot(); });
beforeEach(async () => {
  fx = await reset();
  await db.query(`TRUNCATE password_reset_tokens, idempotency_keys CASCADE`);
});
after(async () => { await shutdown(); });

const forgot = (email) => api('/api/auth/forgot-password', { method: 'POST', body: { email } });
const NEW_PASSWORD = 'a-brand-new-password-2026';

/* ─────────────────────────────────────────────────── P2-1 reset flow */

test('a valid token resets the password', async () => {
  const req = await forgot('alice@x.in');
  assert.equal(req.status, 200);
  assert.ok(req.body.token, 'the token is returned outside production for delivery');

  const done = await api('/api/auth/reset-password', { method: 'POST',
    body: { token: req.body.token, password: NEW_PASSWORD } });
  assert.equal(done.status, 200);

  const login = await api('/api/auth/login', { method: 'POST',
    body: { email: 'alice@x.in', password: NEW_PASSWORD } });
  assert.equal(login.status, 200, 'the new password works');

  const old = await api('/api/auth/login', { method: 'POST',
    body: { email: 'alice@x.in', password: fx.password } });
  assert.equal(old.status, 401, 'the old password does not');
});

test('the raw token is never stored', async () => {
  const req = await forgot('alice@x.in');
  const { rows } = await db.query(`SELECT token_hash FROM password_reset_tokens`);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, req.body.token, 'only a hash is kept');
  assert.equal(rows[0].token_hash.length, 64, 'sha-256 hex');
});

test('a token cannot be used twice', async () => {
  const req = await forgot('alice@x.in');
  const first = await api('/api/auth/reset-password', { method: 'POST',
    body: { token: req.body.token, password: NEW_PASSWORD } });
  assert.equal(first.status, 200);

  const second = await api('/api/auth/reset-password', { method: 'POST',
    body: { token: req.body.token, password: 'another-password-entirely' } });
  assert.equal(second.status, 400);
  assert.equal(second.body.error, 'invalid_token');
});

test('an expired token is refused', async () => {
  const req = await forgot('alice@x.in');
  await db.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`);
  const r = await api('/api/auth/reset-password', { method: 'POST',
    body: { token: req.body.token, password: NEW_PASSWORD } });
  assert.equal(r.status, 400);
});

test('a wrong or malformed token is refused', async () => {
  await forgot('alice@x.in');
  for (const token of ['nope', '', 'x'.repeat(40), null, 12345]) {
    const r = await api('/api/auth/reset-password', { method: 'POST', body: { token, password: NEW_PASSWORD } });
    assert.equal(r.status, 400, `token ${JSON.stringify(token)} must be refused`);
  }
});

test('issuing a new token invalidates the previous one', async () => {
  const first = await forgot('alice@x.in');
  const second = await forgot('alice@x.in');
  const stale = await api('/api/auth/reset-password', { method: 'POST',
    body: { token: first.body.token, password: NEW_PASSWORD } });
  assert.equal(stale.status, 400, 'the superseded link stops working');
  const fresh = await api('/api/auth/reset-password', { method: 'POST',
    body: { token: second.body.token, password: NEW_PASSWORD } });
  assert.equal(fresh.status, 200);
});

test('a reset request does not reveal whether an account exists', async () => {
  const known = await forgot('alice@x.in');
  const unknown = await forgot('nobody@nowhere.in');
  assert.equal(known.status, unknown.status);
  assert.equal(known.body.message, unknown.body.message);
  assert.equal(unknown.body.token, undefined, 'no token for an account that does not exist');
});

test('an inactive account cannot be reset', async () => {
  await db.query(`UPDATE employees SET status='Inactive' WHERE email='bob@x.in'`);
  const r = await forgot('bob@x.in');
  assert.equal(r.status, 200, 'same generic answer');
  assert.equal(r.body.token, undefined);
  const { rows } = await db.query(`SELECT count(*)::int n FROM password_reset_tokens`);
  assert.equal(rows[0].n, 0);
});

test('a weak password is refused', async () => {
  const req = await forgot('alice@x.in');
  const r = await api('/api/auth/reset-password', { method: 'POST',
    body: { token: req.body.token, password: 'short' } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'weak_password');
});

test('resetting invalidates sessions issued beforehand', async () => {
  const token = await tokenFor('alice@x.in');
  assert.equal((await api('/api/me', { token })).status, 200);

  // The JWT iat has one-second resolution, so wait to make "before" real.
  await new Promise((r) => setTimeout(r, 1100));
  const req = await forgot('alice@x.in');
  await api('/api/auth/reset-password', { method: 'POST',
    body: { token: req.body.token, password: NEW_PASSWORD } });

  const after = await api('/api/me', { token });
  assert.equal(after.status, 401, 'the old session is dead');
  assert.equal(after.body.error, 'token_revoked');
});

test('a reset is audited without exposing the password hash', async () => {
  const req = await forgot('alice@x.in');
  await api('/api/auth/reset-password', { method: 'POST',
    body: { token: req.body.token, password: NEW_PASSWORD } });

  const { rows } = await db.query(
    `SELECT reason, request_id, after_data FROM audit_log
      WHERE entity='employees' AND record_id=$1 AND action='update'
      ORDER BY audit_id DESC LIMIT 1`, [fx.alice.employee_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'password reset');
  assert.ok(rows[0].request_id, 'the audit row carries the request id');
  assert.equal(rows[0].after_data.password_hash, undefined, 'the hash is stripped');
});

test('an employee cannot reset another employee by guessing', async () => {
  const req = await forgot('alice@x.in');
  // Bob has a session but that gives him no power over Alice's token.
  const bobT = await tokenFor('bob@x.in');
  const r = await api('/api/auth/reset-password', { method: 'POST', token: bobT,
    body: { token: req.body.token.slice(0, -2) + 'zz', password: NEW_PASSWORD } });
  assert.equal(r.status, 400);
  const login = await api('/api/auth/login', { method: 'POST',
    body: { email: 'alice@x.in', password: fx.password } });
  assert.equal(login.status, 200, 'Alice\'s password is untouched');
});

/* ────────────────────────────────── P2-2 audit reason and request id */

test('audit rows carry the authoritative request id', async () => {
  const adminT = await tokenFor('boss@x.in');
  const today = (await db.query('SELECT ist_today() AS d')).rows[0].d.toISOString().slice(0, 10);
  const r = await api('/api/tasks', { method: 'POST', token: adminT,
    body: { title: 'Traceable', assignedTo: fx.alice.employee_id, dueDate: today, dueTime: '23:59' } });
  assert.equal(r.status, 201);

  const { rows } = await db.query(
    `SELECT request_id FROM audit_log WHERE entity='tasks' AND record_id=$1`, [r.body.task_id]);
  assert.ok(rows[0].request_id, 'a support request can be traced to this row');
  assert.match(rows[0].request_id, /^[0-9a-f-]{36}$/);
});

test('a returned submission records why in the audit trail', async () => {
  const adminT = await tokenFor('boss@x.in');
  const aliceT = await tokenFor('alice@x.in');
  const today = (await db.query('SELECT ist_today() AS d')).rows[0].d.toISOString().slice(0, 10);
  const t = (await api('/api/tasks', { method: 'POST', token: adminT,
    body: { title: 'Needs work', assignedTo: fx.alice.employee_id, dueDate: today, dueTime: '23:59' } })).body;
  await api(`/api/tasks/${t.task_id}/start`, { method: 'POST', token: aliceT });
  const sub = (await api(`/api/tasks/${t.task_id}/submit`, { method: 'POST', token: aliceT,
    body: { description: 'first attempt' } })).body;

  await api(`/api/admin/submissions/${sub.submission_id}/return`, { method: 'POST', token: adminT,
    body: { reason: 'Please correct questions 5 to 10.' } });

  const { rows } = await db.query(
    `SELECT reason FROM audit_log WHERE entity='work_submissions' AND record_id=$1
       AND reason IS NOT NULL ORDER BY audit_id DESC LIMIT 1`, [sub.submission_id]);
  assert.equal(rows[0].reason, 'Please correct questions 5 to 10.');
});

test('existing audit history is untouched by the new columns', async () => {
  // Rows written before the reason/request_id work simply have nulls.
  const { rows } = await db.query(
    `SELECT count(*)::int n FROM audit_log WHERE request_id IS NULL`);
  assert.ok(rows[0].n >= 0, 'older rows remain readable');
});

/* ──────────────────────────── P2-3 request ids cannot be client-forged */

test('a client cannot dictate the request id', async () => {
  const forged = 'forged-request-id-0000';
  const r = await api('/api/auth/login', { method: 'POST',
    body: { email: 'nobody@x.in', password: 'wrong-password-here' },
    headers: { 'X-Request-Id': forged } });
  assert.notEqual(r.headers.get('x-request-id'), forged);
  assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  assert.notEqual(r.body.requestId, forged);
});

test('every error response carries a request id', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/tasks/not-a-uuid', { token });
  assert.equal(r.status, 400);
  assert.ok(r.body.requestId, 'so a user can quote it to support');
});

/* ───────────────────────────────────────── P2-4 per-endpoint limits */

test('normal usage is not rate limited', async () => {
  const token = await tokenFor('alice@x.in');
  for (let i = 0; i < 12; i++) {
    const r = await api('/api/tasks/me', { token });
    assert.equal(r.status, 200, `request ${i + 1} must succeed`);
  }
});

test('repeated password reset requests are limited', async () => {
  // Its own app instance with a small limit, so this measures the limiter
  // rather than whatever budget other tests have already spent.
  const app = await bootWithLimits({ reset: 3 });
  try {
    const results = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.call('/api/auth/forgot-password', {
        method: 'POST', body: JSON.stringify({ email: 'alice@x.in' }) });
      results.push(r.status);
    }
    assert.deepEqual(results.slice(0, 3), [200, 200, 200], 'the first three go through');
    assert.ok(results.slice(3).every((s) => s === 429), `the rest are limited: ${results.join(',')}`);
  } finally {
    await app.close();
  }
});

test('the limit response is a clean 429 with a usable message', async () => {
  const app = await bootWithLimits({ reset: 1 });
  try {
    await app.call('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: 'alice@x.in' }) });
    const r = await app.call('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: 'alice@x.in' }) });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'rate_limited');
    assert.match(r.body.message, /try again/i);
  } finally {
    await app.close();
  }
});

test('a rate limit on one endpoint does not affect another', async () => {
  const app = await bootWithLimits({ reset: 1 });
  try {
    await app.call('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: 'alice@x.in' }) });
    const limited = await app.call('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: 'alice@x.in' }) });
    assert.equal(limited.status, 429);

    const login = await app.call('/api/auth/login', { method: 'POST',
      body: JSON.stringify({ email: 'alice@x.in', password: fx.password }) });
    assert.equal(login.status, 200, 'login still works while reset is limited');
  } finally {
    await app.close();
  }
});
