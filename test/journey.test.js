import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, db } from './helpers.js';
import { createClient, ApiError } from '../web/api-client.js';

/**
 * Drives the full Phase 1 journey through the same client module the
 * frontend imports. This verifies the client/API contract end to end:
 * login, session, real data, business rules, logout.
 * It does not verify React rendering, which needs a browser.
 */
let fx, base, unauth;
before(async () => { base = await boot(); });
beforeEach(async () => { fx = await reset(); unauth = 0; });
after(async () => { await shutdown(); });

const client = () => createClient({ baseUrl: `${base}/api`, onUnauthenticated: () => { unauth += 1; } });
const AT_OFFICE = { latitude: 13.0418, longitude: 80.2341, accuracy: 8 };
const today = async () => (await db.query('SELECT ist_today() AS d')).rows[0].d.toISOString().slice(0, 10);

test('JOURNEY: employee logs in, checks in, works a task, claims, logs out', async () => {
  const employee = client();
  const admin = client();

  // 1. login with real credentials against the real database
  const me = await employee.login('alice@x.in', fx.password);
  assert.equal(me.name, 'Alice');
  assert.equal(employee.isAuthenticated, true);
  await admin.login('boss@x.in', fx.password);

  // 2. profile comes from the database, not a fixture in the bundle
  const profile = await employee.me();
  assert.equal(profile.email, 'alice@x.in');
  assert.equal(profile.claims_enabled, true);

  // 3. GPS check-in, server-verified
  const ci = await employee.checkIn(AT_OFFICE);
  assert.ok(ci.distanceMetres < 100);

  // 4. admin assigns work; it appears for the employee
  const d = await today();
  const task = await admin.admin.createTask({
    title: 'Prepare KG Mathematics paper', assignedTo: fx.alice.employee_id,
    dueDate: d, dueTime: '23:59', priority: 'High',
  });
  const mine = await employee.myTasks('today');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].task_id, task.task_id);

  // 5. start, submit, approve
  await employee.startTask(task.task_id);
  const sub = await employee.submitTask(task.task_id, { description: '30 marks, house style followed.' });
  await admin.admin.approve(sub.submission_id);
  const done = await employee.task(task.task_id);
  assert.equal(done.status, 'Completed');

  // 6. claim with a bill, inside the cap
  const bill = new Blob([Buffer.from('%PDF-1.4\n' + ' '.repeat(300))], { type: 'application/pdf' });
  const uploaded = await employee.uploadFile(new File([bill], 'lunch.pdf'));
  const claim = await employee.createClaim({ date: d, category: 'Food', amount: 240, attachmentId: uploaded.attachment_id });
  assert.equal(claim.status, 'Pending');

  // 7. the cap is refused by the server, with a usable message
  const bill2 = new File([bill], 'dinner.pdf');
  const up2 = await employee.uploadFile(bill2);
  await assert.rejects(
    () => employee.createClaim({ date: d, category: 'Food', amount: 400, attachmentId: up2.attachment_id }),
    (e) => e instanceof ApiError && e.status === 422 && e.code === 'daily_limit_exceeded'
        && /Max limit reached for the day/.test(e.message));

  // 8. admin approves the good claim
  const pending = await admin.admin.claims('Pending');
  assert.equal(pending.length, 1);
  await admin.admin.decideClaim(pending[0].claim_id, { decision: 'Approved' });

  // 9. logout invalidates the session for real
  await employee.logout();
  assert.equal(employee.isAuthenticated, false);
  await assert.rejects(() => employee.me(), (e) => e.status === 401);
  assert.equal(unauth, 1, 'the client must signal the session ended');
});

test('JOURNEY: the client surfaces validation errors in a usable shape', async () => {
  const c = client();
  await c.login('boss@x.in', fx.password);
  const d = await today();
  await assert.rejects(
    () => c.admin.createTask({ title: '', assignedTo: fx.alice.employee_id, dueDate: d }),
    (e) => {
      assert.equal(e.status, 422);
      assert.ok(Array.isArray(e.details) && e.details[0].field, 'field-level errors for the form');
      return true;
    });
});

test('JOURNEY: a wrong password never yields a session', async () => {
  const c = client();
  await assert.rejects(() => c.login('alice@x.in', 'not-the-password'),
    (e) => e.status === 401 && e.code === 'unauthorized');
  assert.equal(c.isAuthenticated, false);
  await assert.rejects(() => c.myTasks(), (e) => e.status === 401);
});
