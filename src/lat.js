import { Router } from 'express';
import { z } from 'zod';
import { pool, tx, wrap, uuidParam, notFound, conflict, forbidden, unprocessable } from './core.js';
import { adminOnly } from './auth.js';

export const lat = Router();

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw unprocessable('Some fields need attention.', 'validation_failed',
      r.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message })));
  }
  return r.data;
};

const setSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  words: z.array(z.object({
    word: z.string().trim().min(1).max(60),
    meaning: z.string().trim().min(1).max(300),
    example: z.string().trim().max(300).optional(),
  })).min(1).max(50),
}).strict();

/* ─────────────────────────────────────────────────────── employee side */

/**
 * One endpoint for the whole day, because the screen is one flow. The
 * stage tells the client what to render, and the payload deliberately
 * differs: once an attempt is open the spellings stop being sent, so the
 * answers are not sitting in the page while the test is being taken.
 */
lat.get('/lat/today', wrap(async (req, res) => {
  const out = await tx(req.user, async (c) => {
    const set = (await c.query(
      `SELECT set_id, set_date FROM lat_sets
        WHERE set_date = ist_today() AND published_at IS NOT NULL`)).rows[0];
    if (!set) return { stage: 'none' };

    const attempt = (await c.query(
      `SELECT attempt_id, started_at, submitted_at, score, total
         FROM lat_attempts WHERE set_id=$1 AND employee_id=$2`,
      [set.set_id, req.user.id])).rows[0];

    const words = (await c.query(
      `SELECT word_id, position, word, meaning, example FROM lat_words
        WHERE set_id=$1 ORDER BY position`, [set.set_id])).rows;

    if (!attempt) {
      // Reading stage: the words are the point, so they are all here.
      return { stage: 'read', setId: set.set_id, date: set.set_date, words };
    }

    if (!attempt.submitted_at) {
      return {
        stage: 'test', setId: set.set_id, date: set.set_date, attemptId: attempt.attempt_id,
        // Meanings only. The spelling is what is being asked for.
        prompts: words.map((w) => ({
          word_id: w.word_id, position: w.position, meaning: w.meaning,
          length: w.word.length, initial: w.word[0].toUpperCase(),
        })),
      };
    }

    const answers = (await c.query(
      `SELECT a.word_id, a.given, a.is_correct, w.word, w.meaning, w.position
         FROM lat_answers a JOIN lat_words w ON w.word_id = a.word_id
        WHERE a.attempt_id=$1 ORDER BY w.position`, [attempt.attempt_id])).rows;

    return {
      stage: 'done', setId: set.set_id, date: set.set_date,
      score: attempt.score, total: attempt.total,
      submittedAt: attempt.submitted_at, answers,
    };
  });
  res.json(out);
}));

lat.post('/lat/attempts', wrap(async (req, res) => {
  const out = await tx(req.user, async (c) => {
    const set = (await c.query(
      `SELECT set_id FROM lat_sets WHERE set_date = ist_today() AND published_at IS NOT NULL`)).rows[0];
    if (!set) throw notFound('No words have been published for today yet.');

    // One attempt per person per day, decided by the unique index rather
    // than by a check that a second request could slip past.
    const ins = await c.query(
      `INSERT INTO lat_attempts (set_id, employee_id) VALUES ($1,$2)
       ON CONFLICT (set_id, employee_id) DO NOTHING RETURNING attempt_id, started_at`,
      [set.set_id, req.user.id]);
    if (!ins.rowCount) throw conflict('You have already started today\'s test.', 'attempt_exists');
    return ins.rows[0];
  });
  res.status(201).json(out);
}));

lat.post('/lat/attempts/:id/submit', uuidParam('id'), wrap(async (req, res) => {
  const f = parse(z.object({
    answers: z.array(z.object({
      wordId: z.string().uuid(),
      given: z.string().max(120),
    })).min(1).max(50),
  }).strict(), req.body);

  const out = await tx(req.user, async (c) => {
    const attempt = (await c.query(
      `SELECT attempt_id, set_id, employee_id, submitted_at FROM lat_attempts
        WHERE attempt_id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!attempt) throw notFound('That test does not exist.');
    if (attempt.employee_id !== req.user.id) throw forbidden('That test is not yours.');
    if (attempt.submitted_at) throw conflict('You have already submitted today\'s test.', 'already_submitted');

    const words = (await c.query(
      `SELECT word_id, word FROM lat_words WHERE set_id=$1`, [attempt.set_id])).rows;
    const byId = new Map(words.map((w) => [w.word_id, w.word]));

    // Grading happens here and nowhere else. A score posted by a client
    // would be a number the client chose.
    let score = 0;
    for (const a of f.answers) {
      const correctWord = byId.get(a.wordId);
      if (!correctWord) throw unprocessable('That answer does not belong to today\'s words.', 'unknown_word');
      const isCorrect = (await c.query(
        `SELECT lat_normalise($1) = lat_normalise($2) AS ok`, [a.given, correctWord])).rows[0].ok;
      if (isCorrect) score += 1;
      await c.query(
        `INSERT INTO lat_answers (attempt_id, word_id, given, is_correct) VALUES ($1,$2,$3,$4)
         ON CONFLICT (attempt_id, word_id) DO NOTHING`,
        [attempt.attempt_id, a.wordId, a.given, isCorrect]);
    }

    await c.query(
      `UPDATE lat_attempts SET submitted_at = now(), score = $2, total = $3 WHERE attempt_id = $1`,
      [attempt.attempt_id, score, words.length]);

    const answers = (await c.query(
      `SELECT a.word_id, a.given, a.is_correct, w.word, w.meaning, w.position
         FROM lat_answers a JOIN lat_words w ON w.word_id=a.word_id
        WHERE a.attempt_id=$1 ORDER BY w.position`, [attempt.attempt_id])).rows;

    return { score, total: words.length, answers };
  });
  res.json(out);
}));

lat.get('/lat/me', wrap(async (req, res) => {
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT s.set_date, a.score, a.total, a.submitted_at
       FROM lat_attempts a JOIN lat_sets s ON s.set_id = a.set_id
      WHERE a.employee_id = $1 AND a.submitted_at IS NOT NULL
      ORDER BY s.set_date DESC LIMIT 60`, [req.user.id]));

  // A streak is consecutive days ending today or yesterday; missing a day
  // resets it. Counting in JS keeps the SQL readable.
  let streak = 0;
  const done = new Set(rows.map((r) => new Date(r.set_date).toISOString().slice(0, 10)));
  const cursor = new Date();
  for (let i = 0; i < 400; i++) {
    const key = cursor.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (done.has(key)) streak += 1;
    else if (i > 0 || !done.size) break;
    cursor.setDate(cursor.getDate() - 1);
  }

  const scored = rows.filter((r) => r.total > 0);
  const average = scored.length
    ? Math.round((scored.reduce((s, r) => s + (r.score / r.total), 0) / scored.length) * 100)
    : null;

  res.json({ history: rows, streak, averagePercent: average });
}));

/* ────────────────────────────────────────────────────────── admin side */

lat.post('/admin/lat/sets', adminOnly, wrap(async (req, res) => {
  const f = parse(setSchema, req.body);
  const out = await tx(req.user, async (c) => {
    const dupes = new Set(f.words.map((w) => w.word.trim().toLowerCase()));
    if (dupes.size !== f.words.length) {
      throw unprocessable('The same word appears more than once.', 'duplicate_word');
    }
    let set;
    try {
      set = (await c.query(
        `INSERT INTO lat_sets (set_date, created_by, published_at)
         VALUES (COALESCE($1::date, ist_today()), $2, now()) RETURNING *`,
        [f.date ?? null, req.user.id])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('Words have already been published for that day.', 'set_exists');
      throw e;
    }
    for (const [i, w] of f.words.entries()) {
      await c.query(
        `INSERT INTO lat_words (set_id, position, word, meaning, example) VALUES ($1,$2,$3,$4,$5)`,
        [set.set_id, i + 1, w.word.trim(), w.meaning.trim(), w.example?.trim() ?? null]);
    }
    await c.query(
      `INSERT INTO notifications (recipient_id, kind, body)
       SELECT employee_id, 'lat', $1 FROM employees WHERE status='Active'`,
      [`Today's ${f.words.length} words are ready.`]);
    return { ...set, wordCount: f.words.length };
  });
  res.status(201).json(out);
}));

lat.get('/admin/lat/results', adminOnly, wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT e.employee_id, e.name, e.role,
            s.set_date, a.score, a.total, a.submitted_at, a.started_at
       FROM employees e
       LEFT JOIN lat_sets s ON s.set_date = COALESCE($1::date, ist_today())
       LEFT JOIN lat_attempts a ON a.set_id = s.set_id AND a.employee_id = e.employee_id
      WHERE e.status = 'Active'
      ORDER BY a.score DESC NULLS LAST, e.name`, [date]));
  res.json(rows);
}));
