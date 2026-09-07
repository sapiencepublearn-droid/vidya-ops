import crypto from 'node:crypto';
import { pool, ApiError, conflict, logger } from './core.js';

/* ─────────────────────────────────────────────────────── idempotency */

const hashBody = (body) =>
  crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');

/**
 * Makes a write safe to repeat.
 *
 * The client sends `Idempotency-Key` once per user action. If the response
 * is lost and the request is retried, the second call returns the first
 * result instead of doing the work again.
 *
 * Deliberately simple: one table, no queue, no external service. At ten
 * employees the volume is trivial and the failure mode we care about is a
 * phone on weak signal, not distributed consensus.
 *
 * The key is optional. Without one the request behaves exactly as before,
 * so this cannot break an existing client.
 */
export function idempotent(handler) {
  return async (req, res, next) => {
    const key = (req.headers['idempotency-key'] || '').trim();
    if (!key) return handler(req, res, next);

    if (key.length > 200) {
      return next(new ApiError(400, 'bad_idempotency_key', 'That request key is too long.'));
    }

    const employeeId = req.user.id;
    const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
    const fingerprint = hashBody(req.body);

    // Claim the key. Losing this race means another copy of the same
    // request is already in flight or finished.
    let claimed;
    try {
      claimed = await pool.query(
        `INSERT INTO idempotency_keys (key, employee_id, endpoint, request_hash)
         VALUES ($1,$2,$3,$4) ON CONFLICT (employee_id, key) DO NOTHING
         RETURNING key`,
        [key, employeeId, endpoint, fingerprint]);
    } catch (e) {
      return next(e);
    }

    if (!claimed.rowCount) {
      const { rows } = await pool.query(
        `SELECT endpoint, request_hash, status_code, response_body, completed_at
           FROM idempotency_keys WHERE employee_id=$1 AND key=$2`, [employeeId, key]);
      const prior = rows[0];

      // Same key, different request. That is a client bug, and returning
      // the earlier answer would hide it.
      if (prior.request_hash !== fingerprint || prior.endpoint !== endpoint) {
        return next(new ApiError(422, 'idempotency_key_reused',
          'That request key was already used for a different request.'));
      }

      if (!prior.completed_at) {
        // The first attempt is still running. Telling the client to wait is
        // safer than starting the work a second time.
        return next(conflict('That request is still being processed. Try again in a moment.',
          'request_in_progress'));
      }

      logger.info({ reqId: req.id, key, endpoint }, 'idempotent replay');
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(prior.status_code).json(prior.response_body);
    }

    // First time through: run the handler, remembering what it answered.
    const originalJson = res.json.bind(res);
    let recorded = false;
    res.json = (body) => {
      if (!recorded) {
        recorded = true;
        // Only successful results are replayable. A failure should be
        // retryable in the ordinary way.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          pool.query(
            `UPDATE idempotency_keys SET status_code=$3, response_body=$4, completed_at=now()
              WHERE employee_id=$1 AND key=$2`,
            [employeeId, key, res.statusCode, JSON.stringify(body)]
          ).catch((e) => logger.error({ err: e, reqId: req.id }, 'could not record idempotent result'));
        } else {
          pool.query(`DELETE FROM idempotency_keys WHERE employee_id=$1 AND key=$2`, [employeeId, key])
            .catch(() => {});
        }
      }
      return originalJson(body);
    };

    // If the handler throws, release the key so a retry can genuinely retry.
    try {
      await handler(req, res, next);
    } catch (e) {
      await pool.query(`DELETE FROM idempotency_keys WHERE employee_id=$1 AND key=$2`, [employeeId, key]).catch(() => {});
      next(e);
    }
  };
}

/* ──────────────────────────────────────────────────────── notifications */

/**
 * Writes a notification without risking the business transaction.
 *
 * Previously these inserts ran inline, so a failure while announcing a
 * task would roll back the task itself. A SAVEPOINT isolates the attempt:
 * if it fails, only the notification is discarded and the approval,
 * submission or claim still commits.
 *
 * The notification is still written in the same transaction on the happy
 * path, so it cannot announce something that was later rolled back.
 */
export async function notify(client, { recipientId = null, kind, body, taskId = null, reqId }) {
  const sp = `notify_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    await client.query(
      `INSERT INTO notifications (recipient_id, kind, body, task_id) VALUES ($1,$2,$3,$4)`,
      [recipientId, kind, body, taskId]);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    logger.error({ err: e, reqId, kind }, 'notification failed, business action kept');
  }
}

/** Same, addressed to every admin (recipient_id NULL is the broadcast form). */
export const notifyAdmins = (client, opts) => notify(client, { ...opts, recipientId: null });

/** Fan-out to every active employee, used when the CEO publishes LAT words. */
export async function notifyEveryone(client, { kind, body, reqId }) {
  const sp = `notifyall_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    await client.query(
      `INSERT INTO notifications (recipient_id, kind, body)
       SELECT employee_id, $1, $2 FROM employees WHERE status='Active'`, [kind, body]);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    logger.error({ err: e, reqId, kind }, 'broadcast notification failed, business action kept');
  }
}


/** Create the two daily attendance reminders once, in IST. The unique run
 * row makes this safe if the Render service briefly starts twice. */
export async function runAttendanceReminders() {
  const result = await pool.query(`
    SELECT ist_today() AS business_date,
           (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time AS local_time`);
  const { business_date: day, local_time: localTime } = result.rows[0];
  const hhmm = String(localTime).slice(0, 5);
  let type = null;
  if (hhmm === '09:00') type = 'check_in';
  if (hhmm === '18:00') type = 'check_out';
  if (!type) return { sent: false };

  const claimed = await pool.query(
    `INSERT INTO attendance_reminder_runs (reminder_date, reminder_type)
     VALUES ($1,$2) ON CONFLICT (reminder_date, reminder_type) DO NOTHING
     RETURNING run_id`, [day, type]);
  if (!claimed.rowCount) return { sent: false, duplicate: true };

  if (type === 'check_in') {
    await pool.query(`
      INSERT INTO notifications (recipient_id, kind, body)
      SELECT e.employee_id, 'attendance_reminder',
             'Good morning. Please record your Punch In before starting today''s work. This keeps attendance and work records accurate.'
        FROM employees e
       WHERE e.status='Active'
         AND NOT EXISTS (
           SELECT 1 FROM attendance a
            WHERE a.employee_id=e.employee_id
              AND a.work_date=ist_today()
              AND a.check_in_time IS NOT NULL
         )`);
  } else {
    await pool.query(`
      INSERT INTO notifications (recipient_id, kind, body)
      SELECT e.employee_id, 'attendance_reminder',
             'Workday reminder: if you have finished today''s work, please complete End Day. If a school visit is active, check out from the school first.'
        FROM employees e
       WHERE e.status='Active'
         AND EXISTS (
           SELECT 1 FROM attendance a
            WHERE a.employee_id=e.employee_id
              AND a.work_date=ist_today()
              AND a.check_in_time IS NOT NULL
              AND a.check_out_time IS NULL
         )`);
  }
  return { sent: true, type };
}
