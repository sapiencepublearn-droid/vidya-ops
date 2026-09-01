import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api, tokenFor, db } from './helpers.js';

let fx;
before(async () => { await boot(); });
beforeEach(async () => {
  fx = await reset();
  await db.query(`TRUNCATE lat_answers, lat_attempts, lat_words, lat_sets CASCADE`);
});
after(async () => { await shutdown(); });

const WORDS = [
  { word: 'conscience', meaning: 'an inner sense of right and wrong' },
  { word: 'rhythm', meaning: 'a regular repeated pattern of sound' },
  { word: 'liaison', meaning: 'communication between groups' },
];

async function publish(words = WORDS) {
  const admin = await tokenFor('boss@x.in');
  const r = await api('/api/admin/lat/sets', { method: 'POST', token: admin, body: { words } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return admin;
}

test('CEO publishes the day\'s words and everyone is notified', async () => {
  await publish();
  const { rows } = await db.query(`SELECT count(*)::int n FROM notifications WHERE kind='lat'`);
  assert.equal(rows[0].n, 3, 'one notification per active employee');
});

test('an employee cannot publish words', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/admin/lat/sets', { method: 'POST', token, body: { words: WORDS } });
  assert.equal(r.status, 403);
});

test('words cannot be published twice for the same day', async () => {
  const admin = await publish();
  const again = await api('/api/admin/lat/sets', { method: 'POST', token: admin, body: { words: WORDS } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'set_exists');
});

test('duplicate words in one set are refused', async () => {
  const admin = await tokenFor('boss@x.in');
  const r = await api('/api/admin/lat/sets', {
    method: 'POST', token: admin,
    body: { words: [WORDS[0], { ...WORDS[0], meaning: 'again' }] } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'duplicate_word');
});

test('the reading stage shows the words', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/lat/today', { token });
  assert.equal(r.body.stage, 'read');
  assert.equal(r.body.words.length, 3);
  assert.equal(r.body.words[0].word, 'conscience');
});

test('SECURITY: once the test starts, the spellings are no longer sent', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  await api('/api/lat/attempts', { method: 'POST', token });

  const r = await api('/api/lat/today', { token });
  assert.equal(r.body.stage, 'test');
  assert.equal(r.body.words, undefined, 'the word list must not be present during the test');
  const raw = JSON.stringify(r.body);
  for (const w of WORDS) {
    assert.equal(raw.includes(w.word), false, `"${w.word}" must not appear in the test payload`);
  }
  // The hints that are sent are deliberate and insufficient to answer.
  assert.equal(r.body.prompts[0].initial, 'C');
  assert.equal(r.body.prompts[0].length, 10);
});

test('the mark is calculated by the server', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const start = await api('/api/lat/attempts', { method: 'POST', token });
  const prompts = (await api('/api/lat/today', { token })).body.prompts;

  const r = await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, {
    method: 'POST', token,
    body: {
      answers: [
        { wordId: prompts[0].word_id, given: 'Conscience' },  // case is not the test
        { wordId: prompts[1].word_id, given: 'rythm' },       // misspelt
        { wordId: prompts[2].word_id, given: '  liaison ' },  // spacing is not the test
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.score, 2);
  assert.equal(r.body.total, 3);
  assert.equal(r.body.answers.find((a) => a.word === 'rhythm').is_correct, false);
});

test('a client cannot post its own score', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const start = await api('/api/lat/attempts', { method: 'POST', token });
  const prompts = (await api('/api/lat/today', { token })).body.prompts;
  const r = await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, {
    method: 'POST', token,
    body: { score: 10, total: 10, answers: [{ wordId: prompts[0].word_id, given: 'wrong' }] },
  });
  assert.equal(r.status, 422, 'unexpected fields must be rejected');
  assert.equal(r.body.error, 'validation_failed');
});

test('the test can only be taken once', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const first = await api('/api/lat/attempts', { method: 'POST', token });
  assert.equal(first.status, 201);
  const second = await api('/api/lat/attempts', { method: 'POST', token });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'attempt_exists');
});

test('RACE: two simultaneous starts create one attempt', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const results = await Promise.all(
    Array.from({ length: 5 }, () => api('/api/lat/attempts', { method: 'POST', token })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status >= 500).length, 0);
  const { rows } = await db.query(`SELECT count(*)::int n FROM lat_attempts`);
  assert.equal(rows[0].n, 1);
});

test('a submitted test cannot be resubmitted or edited', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const start = await api('/api/lat/attempts', { method: 'POST', token });
  const prompts = (await api('/api/lat/today', { token })).body.prompts;
  const answers = prompts.map((p) => ({ wordId: p.word_id, given: 'x' }));

  await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, { method: 'POST', token, body: { answers } });
  const again = await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, { method: 'POST', token, body: { answers } });
  assert.equal(again.status, 409);

  await assert.rejects(
    () => db.query(`UPDATE lat_attempts SET score = 10 WHERE attempt_id=$1`, [start.body.attempt_id]),
    /cannot be changed/);
});

test('an employee cannot submit someone else\'s test', async () => {
  await publish();
  const aliceT = await tokenFor('alice@x.in');
  const start = await api('/api/lat/attempts', { method: 'POST', token: aliceT });
  const bobT = await tokenFor('bob@x.in');
  const r = await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, {
    method: 'POST', token: bobT, body: { answers: [{ wordId: fx.alice.employee_id, given: 'x' }] } });
  assert.ok([403, 404].includes(r.status), `expected denial, got ${r.status}`);
});

test('after submitting, the correct spellings come back for review', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const start = await api('/api/lat/attempts', { method: 'POST', token });
  const prompts = (await api('/api/lat/today', { token })).body.prompts;
  await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, {
    method: 'POST', token, body: { answers: prompts.map((p) => ({ wordId: p.word_id, given: 'nope' })) } });

  const r = await api('/api/lat/today', { token });
  assert.equal(r.body.stage, 'done');
  assert.equal(r.body.score, 0);
  assert.ok(r.body.answers.every((a) => a.word), 'the right answers are shown once the test is over');
});

test('the CEO sees every employee result, including who has not taken it', async () => {
  await publish();
  const aliceT = await tokenFor('alice@x.in');
  const start = await api('/api/lat/attempts', { method: 'POST', token: aliceT });
  const prompts = (await api('/api/lat/today', { token: aliceT })).body.prompts;
  await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, {
    method: 'POST', token: aliceT,
    body: { answers: [{ wordId: prompts[0].word_id, given: 'conscience' }] } });

  const admin = await tokenFor('boss@x.in');
  const r = await api('/api/admin/lat/results', { token: admin });
  assert.equal(r.status, 200);
  const alice = r.body.find((x) => x.name === 'Alice');
  assert.equal(alice.score, 1);
  const bob = r.body.find((x) => x.name === 'Bob');
  assert.equal(bob.submitted_at, null, 'employees who have not taken it must still be listed');
});

test('an employee cannot see another employee\'s results', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/admin/lat/results', { token });
  assert.equal(r.status, 403);
});

test('history reports a streak and an average', async () => {
  await publish();
  const token = await tokenFor('alice@x.in');
  const start = await api('/api/lat/attempts', { method: 'POST', token });
  const prompts = (await api('/api/lat/today', { token })).body.prompts;
  await api(`/api/lat/attempts/${start.body.attempt_id}/submit`, {
    method: 'POST', token,
    body: { answers: prompts.map((p, i) => ({ wordId: p.word_id, given: i === 0 ? 'conscience' : 'x' })) } });

  const r = await api('/api/lat/me', { token });
  assert.equal(r.body.streak, 1);
  assert.equal(r.body.averagePercent, 33);
  assert.equal(r.body.history.length, 1);
});

test('there is a calm answer when nothing has been published', async () => {
  const token = await tokenFor('alice@x.in');
  const r = await api('/api/lat/today', { token });
  assert.equal(r.body.stage, 'none');
  const start = await api('/api/lat/attempts', { method: 'POST', token });
  assert.equal(start.status, 404);
});
