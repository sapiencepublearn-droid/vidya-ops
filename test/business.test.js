import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api, tokenFor, uploadFile, db as pool, PDF, PNG, ELF } from './helpers.js';

let fx;
const AT_OFFICE = { latitude: 13.0418, longitude: 80.2341, accuracy: 8 };
const FAR_AWAY = { latitude: 13.0827, longitude: 80.2707, accuracy: 8 };

before(async () => { await boot(); });
beforeEach(async () => { fx = await reset(); });
after(async () => { await shutdown(); });

/* ─────────────────────────────────────────────────────────── attendance */

test('check-in inside the radius succeeds', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  assert.equal(r.status, 201);
  assert.ok(r.body.distanceMetres < 100);
});

test('check-in outside the radius is refused by the server', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', { method: 'POST', token, body: FAR_AWAY });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'outside_radius');
});

test('a vague GPS fix is refused', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', {
    method: 'POST', token, body: { ...AT_OFFICE, accuracy: 500 } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'poor_accuracy');
});

test('a mocked location is refused', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/attendance/check-in', {
    method: 'POST', token, body: { ...AT_OFFICE, isMocked: true } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'mock_location');
});

test('duplicate check-in is a clean 409', async () => {
  const token = await tokenFor('alice@x.in');
  assert.equal((await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE })).status, 201);
  const second = await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'already_checked_in');
});

test('RACE: eight simultaneous check-ins produce exactly one row and no 500', async () => {
  const token = await tokenFor('alice@x.in');
  const results = await Promise.all(
    Array.from({ length: 8 }, () => api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE }))
  );
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);
  const errors = results.filter((r) => r.status >= 500);

  assert.equal(created.length, 1, 'exactly one request may win');
  assert.equal(rejected.length, 7, 'the rest must be controlled 409s');
  assert.equal(errors.length, 0, 'no 500s under contention');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM attendance WHERE employee_id=$1`, [fx.alice.employee_id]);
  assert.equal(rows[0].n, 1, 'no duplicate attendance rows');
});

test('check-out requires a check-in and cannot repeat', async () => {
  const token = await tokenFor('alice@x.in');
  assert.equal((await api('/api/attendance/check-out', { method: 'POST', token, body: AT_OFFICE })).body.error, 'not_checked_in');
  await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  assert.equal((await api('/api/attendance/check-out', { method: 'POST', token, body: AT_OFFICE })).status, 200);
  assert.equal((await api('/api/attendance/check-out', { method: 'POST', token, body: AT_OFFICE })).body.error, 'already_checked_out');
});

test('captured GPS is immutable at the database level', async () => {
  const token = await tokenFor('alice@x.in');
  await api('/api/attendance/check-in', { method: 'POST', token, body: AT_OFFICE });
  await assert.rejects(
    () => pool.query(`UPDATE attendance SET check_in_latitude = 0 WHERE employee_id=$1`, [fx.alice.employee_id]),
    /immutable/);
});

/* ──────────────────────────────────────────────────────────────── IST */

test('business date is Asia/Kolkata even though the server runs UTC', async () => {
  const { rows } = await pool.query(`SHOW timezone`);
  assert.equal(rows[0].TimeZone, 'UTC', 'this test is only meaningful on a UTC server');

  // 20:00 UTC is already the next calendar day in India.
  const { rows: r2 } = await pool.query(`
    SELECT ('2026-08-28 20:00:00+00'::timestamptz)::date AS naive_utc_date,
           ('2026-08-28 20:00:00+00'::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AS ist_date`);
  assert.equal(r2[0].naive_utc_date.toISOString().slice(0, 10), '2026-08-28');
  assert.equal(r2[0].ist_date.toISOString().slice(0, 10), '2026-08-29',
    'the old CURRENT_DATE approach would have filed this under the wrong day');
});

test('ist_today() matches the Indian calendar date', async () => {
  const { rows } = await pool.query(
    `SELECT ist_today() AS d, to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS expected`);
  assert.equal(rows[0].d.toISOString().slice(0, 10), rows[0].expected);
});

/* ───────────────────────────────────────────────────────────── claims */

async function bill(token) {
  const up = await uploadFile(token, 'bill.pdf', PDF);
  assert.equal(up.status, 201);
  return up.body.attachment_id;
}
const today = async () => (await pool.query(`SELECT ist_today() AS d`)).rows[0].d.toISOString().slice(0, 10);

test('a valid claim is stored in the database', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/claims', {
    method: 'POST', token,
    body: { date: await today(), category: 'Food', amount: 240, attachmentId: await bill(token) },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.amount_paise, '24000', 'money is stored as integer paise');
  const { rows } = await pool.query(`SELECT count(*)::int n FROM claims`);
  assert.equal(rows[0].n, 1);
});

test('SECURITY: a claim over the daily food cap is refused by the API', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/claims', {
    method: 'POST', token,
    body: { date: await today(), category: 'Food', amount: 600, attachmentId: await bill(token) },
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'daily_limit_exceeded');
  assert.match(r.body.message, /Max limit reached for the day/);
  const { rows } = await pool.query(`SELECT count(*)::int n FROM claims`);
  assert.equal(rows[0].n, 0, 'nothing may be persisted when the cap is exceeded');
});

test('the cap is a daily total, not a per-bill limit', async () => {
  const token = await tokenFor('alice@x.in');
  const d = await today();
  const first = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Food', amount: 300, attachmentId: await bill(token) } });
  assert.equal(first.status, 201);
  const second = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Food', amount: 300, attachmentId: await bill(token) } });
  assert.equal(second.status, 422, 'two 300 claims must not both pass a 500 cap');
  assert.equal(second.body.details.remaining, 200);
});

test('RACE: parallel claims cannot together exceed the daily cap', async () => {
  const token = await tokenFor('alice@x.in');
  const d = await today();
  const bills = await Promise.all([bill(token), bill(token), bill(token), bill(token)]);
  // Four simultaneous 200 claims against a 500 cap: at most two may land.
  const results = await Promise.all(bills.map((att) =>
    api('/api/claims', { method: 'POST', token, body: { date: d, category: 'Food', amount: 200, attachmentId: att } })));

  assert.equal(results.filter((r) => r.status >= 500).length, 0, 'no 500s under contention');
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_paise),0)::int AS total FROM claims
      WHERE employee_id=$1 AND category='Food' AND status <> 'Rejected'`, [fx.alice.employee_id]);
  assert.ok(rows[0].total <= 50000, `daily total ${rows[0].total} paise must not exceed the 50000 cap`);
  assert.equal(results.filter((r) => r.status === 201).length, 2, 'exactly two of four may succeed');
});

test('stay cap is enforced separately at 1500', async () => {
  const token = await tokenFor('alice@x.in');
  const d = await today();
  const ok = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Stay', amount: 1450, location: 'Vellore', attachmentId: await bill(token) } });
  assert.equal(ok.status, 201);
  const over = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Stay', amount: 100, location: 'Vellore', attachmentId: await bill(token) } });
  assert.equal(over.status, 422);
  assert.match(over.body.message, /Max limit crossed/);
});

test('travel is uncapped but requires a place', async () => {
  const token = await tokenFor('alice@x.in');
  const d = await today();
  const noPlace = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Travel', amount: 5000, attachmentId: await bill(token) } });
  assert.equal(noPlace.status, 422, 'travel without a place must fail the check constraint');
  const ok = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Travel', amount: 5000, place: 'Office to ABC School', attachmentId: await bill(token) } });
  assert.equal(ok.status, 201);
});

test('claims are refused when reimbursement is not enabled on the account', async () => {
  const token = await tokenFor('bob@x.in');
  const r = await api('/api/claims', { method: 'POST', token,
    body: { date: await today(), category: 'Food', amount: 100, attachmentId: await bill(token) } });
  assert.equal(r.status, 403);
});

test('negative, zero and absurd amounts are refused', async () => {
  const token = await tokenFor('alice@x.in');
  const d = await today();
  for (const amount of [-100, 0, 999999999]) {
    const r = await api('/api/claims', { method: 'POST', token,
      body: { date: d, category: 'Food', amount, attachmentId: await bill(token) } });
    assert.equal(r.status, 422, `amount ${amount} must be refused`);
  }
});

test('an employee cannot read another employee claim', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const claim = await api('/api/claims', { method: 'POST', token: aliceT,
    body: { date: await today(), category: 'Food', amount: 100, attachmentId: await bill(aliceT) } });
  const bobT = await tokenFor('bob@x.in');
  const r = await api(`/api/claims/${claim.body.claim_id}`, { token: bobT });
  assert.equal(r.status, 404, 'must not confirm the record exists');
});

test('admin can approve and the decision is recorded once', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const claim = (await api('/api/claims', { method: 'POST', token: aliceT,
    body: { date: await today(), category: 'Food', amount: 100, attachmentId: await bill(aliceT) } })).body;
  const adminT = await tokenFor('boss@x.in');
  const ok = await api(`/api/admin/claims/${claim.claim_id}/decide`, {
    method: 'POST', token: adminT, body: { decision: 'Approved' } });
  assert.equal(ok.status, 200);
  const again = await api(`/api/admin/claims/${claim.claim_id}/decide`, {
    method: 'POST', token: adminT, body: { decision: 'Rejected', reason: 'changed my mind' } });
  assert.equal(again.status, 409);
});

test('rejection without a reason is refused', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const claim = (await api('/api/claims', { method: 'POST', token: aliceT,
    body: { date: await today(), category: 'Food', amount: 100, attachmentId: await bill(aliceT) } })).body;
  const adminT = await tokenFor('boss@x.in');
  const r = await api(`/api/admin/claims/${claim.claim_id}/decide`, {
    method: 'POST', token: adminT, body: { decision: 'Rejected' } });
  assert.equal(r.status, 422);
});

/* ─────────────────────────────────────────────────────────────── files */

test('a genuine PDF uploads and is typed by content', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await uploadFile(token, 'bill.pdf', PDF);
  assert.equal(r.status, 201);
  assert.equal(r.body.mime_type, 'application/pdf');
});

test('an executable renamed as .pdf is rejected', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await uploadFile(token, 'invoice.pdf', ELF);
  assert.equal(r.status, 415);
  assert.equal(r.body.error, 'unsupported_file');
});

test('a PNG renamed as .pdf is rejected on extension mismatch', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await uploadFile(token, 'receipt.pdf', PNG);
  assert.equal(r.status, 415);
  assert.equal(r.body.error, 'extension_mismatch');
});

test('an oversized file is rejected', async () => {
  const token = await tokenFor('alice@x.in');
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024, 0x20)]);
  const r = await uploadFile(token, 'huge.pdf', big);
  assert.equal(r.status, 413);
});

test('an employee cannot download another employee file', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const up = await uploadFile(aliceT, 'private.pdf', PDF);
  const bobT = await tokenFor('bob@x.in');
  const link = await api(`/api/files/${up.body.attachment_id}/link`, { token: bobT });
  assert.ok([403, 404].includes(link.status), `expected denial, got ${link.status}`);

  // and the owner must still be able to reach their own file
  const own = await api(`/api/files/${up.body.attachment_id}/link`, { token: aliceT });
  assert.equal(own.status, 200, 'RLS must not block legitimate access');
});

test('a download link signed for one employee does not work for another', async () => {
  const aliceT = await tokenFor('alice@x.in');
  const up = await uploadFile(aliceT, 'private.pdf', PDF);
  const link = (await api(`/api/files/${up.body.attachment_id}/link`, { token: aliceT })).body;
  const bobT = await tokenFor('bob@x.in');
  const r = await api(link.url, { token: bobT });
  assert.ok([403, 404].includes(r.status), `expected denial, got ${r.status}`);

  const ownerDownload = await api(link.url, { token: aliceT });
  assert.equal(ownerDownload.status, 200, 'the signing employee must still be able to download');
});

test('an attachment cannot be attached to two claims', async () => {
  const token = await tokenFor('alice@x.in');
  const d = await today();
  const att = await bill(token);
  const first = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Food', amount: 100, attachmentId: att } });
  assert.equal(first.status, 201);
  const second = await api('/api/claims', { method: 'POST', token,
    body: { date: d, category: 'Food', amount: 100, attachmentId: att } });
  assert.equal(second.status, 403, 'a reused bill must be refused');
});

/* ──────────────────────────────────────────────────────── tasks + audit */

test('task lifecycle writes audit rows at each step', async () => {
  const adminT = await tokenFor('boss@x.in');
  const aliceT = await tokenFor('alice@x.in');
  const t = (await api('/api/tasks', { method: 'POST', token: adminT,
    body: { title: 'Audit me', assignedTo: fx.alice.employee_id, dueDate: await today(), dueTime: '23:59' } })).body;

  assert.equal((await api(`/api/tasks/${t.task_id}/start`, { method: 'POST', token: aliceT })).status, 200);
  const sub = await api(`/api/tasks/${t.task_id}/submit`, { method: 'POST', token: aliceT,
    body: { description: 'done' } });
  assert.equal(sub.status, 201);
  assert.equal((await api(`/api/admin/submissions/${sub.body.submission_id}/approve`,
    { method: 'POST', token: adminT })).status, 200);

  const { rows } = await pool.query(
    `SELECT entity, action, count(*)::int n FROM audit_log GROUP BY 1,2 ORDER BY 1,2`);
  const tasks = rows.filter((r) => r.entity === 'tasks');
  assert.ok(tasks.find((r) => r.action === 'insert'), 'task creation audited');
  assert.ok(tasks.find((r) => r.action === 'update'), 'task transitions audited');
  assert.ok(rows.find((r) => r.entity === 'work_submissions'), 'submissions audited');

  // Fixture rows are inserted outside a request and legitimately have no
  // actor. Every audit row produced by an API call must name one.
  const actor = await pool.query(
    `SELECT count(*)::int n FROM audit_log
      WHERE actor_id IS NULL AND entity IN ('tasks','work_submissions','claims','attendance')`);
  assert.equal(actor.rows[0].n, 0, 'every API-driven audit row must name an actor');
});

test('illegal task transitions are refused', async () => {
  const adminT = await tokenFor('boss@x.in');
  const aliceT = await tokenFor('alice@x.in');
  const t = (await api('/api/tasks', { method: 'POST', token: adminT,
    body: { title: 'x', assignedTo: fx.alice.employee_id, dueDate: await today(), dueTime: '23:59' } })).body;
  const early = await api(`/api/tasks/${t.task_id}/submit`, { method: 'POST', token: aliceT, body: { description: 'skipping ahead' } });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'bad_transition');
});

test('health endpoint reports database state', async () => {
  const r = await api('/health');
  assert.equal(r.status, 200);
  // Shape changed in the hardening work: health now reports three states
  // and names each check, rather than a single db flag.
  assert.equal(r.body.status, 'healthy');
  assert.equal(r.body.checks.database.ok, true);
  assert.ok(r.body.checks.database.businessDate);
});
