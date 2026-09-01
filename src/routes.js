import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  config, pool, tx, ApiError, badRequest, forbidden, notFound, conflict,
  unprocessable, wrap, uuidParam, metresBetween, logger,
} from './core.js';
import { login, revoke, authenticate, adminOnly, hashPassword, assertPasswordPolicy } from './auth.js';
import { putObject, getObject, sniff, safeName, storageKey, sha256, signDownload, verifyDownload } from './storage.js';
import { lat } from './lat.js';

export const router = Router();

/* ───────────────────────────────────────────────────────── validation */

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw unprocessable('Some fields need attention.', 'validation_failed',
      r.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message })));
  }
  return r.data;
};

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

// .strict() rejects unexpected keys, so a client cannot smuggle
// employee_id or status into a create call and pick its own owner.
const fixSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(10000),
  isMocked: z.boolean().optional().default(false),
  device: z.object({}).passthrough().optional(),
}).strict();

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  assignedTo: uuid,
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).default('Medium'),
  dueDate: isoDate,
  dueTime: hhmm.default('18:00'),
}).strict();

const claimSchema = z.object({
  date: isoDate,
  category: z.enum(['Travel', 'Food', 'Stay', 'Others']),
  // Rupees in, paise stored. Integers only: floats and money do not mix.
  amount: z.number().positive().max(100000).multipleOf(0.01),
  attachmentId: uuid,
  place: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

const employeeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(['Trainer', 'Admin', 'Accountant', 'Content Writer', 'Designer', 'CEO']),
  email: z.string().email().max(160),
  phone: z.string().trim().max(30).optional(),
  password: z.string(),
  isAdmin: z.boolean().default(false),
  officeLocationId: uuid.optional(),
  claimsEnabled: z.boolean().default(false),
  capFood: z.number().int().min(0).max(100000).default(500),
  capStay: z.number().int().min(0).max(100000).default(1500),
}).strict();

const page = (q) => ({
  limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200),
  offset: Math.max(Number(q.offset) || 0, 0),
});

/* ───────────────────────────────────────────────────────────── public */

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  const out = await login(email, password, req.ip);
  logger.info({ employeeId: out.employee.id, reqId: req.id }, 'login ok');
  res.json({ token: out.token, employee: out.employee });
}));

/* ──────────────────────────────────────────── everything below is auth */

router.use(authenticate);

// LAT lives in its own module; everything past this point is authenticated.
router.use(lat);

router.post('/auth/logout', wrap(async (req, res) => {
  await revoke({ jti: req.user.jti, sub: req.user.id, exp: req.user.exp });
  res.status(204).end();
}));

router.get('/me', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.employee_id, e.employee_code, e.name, e.role, e.phone, e.email, e.is_admin,
            e.claims_enabled, e.cap_food, e.cap_stay, e.shift_start,
            l.location_id, l.name AS site_name, l.latitude, l.longitude, l.radius_metres
       FROM employees e LEFT JOIN locations l ON l.location_id = e.office_location_id
      WHERE e.employee_id = $1`, [req.user.id]);
  res.json(rows[0]);
}));

/* ───────────────────────────────────────────────────────── attendance */

async function permittedSites(employeeId) {
  const { rows } = await pool.query(
    `SELECT l.location_id, l.kind, l.name, l.latitude, l.longitude, l.radius_metres
       FROM locations l JOIN employees e ON e.office_location_id = l.location_id
      WHERE e.employee_id = $1 AND l.is_active
      UNION
     SELECT l.location_id, l.kind, l.name, l.latitude, l.longitude, l.radius_metres
       FROM trainer_assignments ta JOIN locations l ON l.location_id = ta.location_id
      WHERE ta.employee_id = $1 AND l.is_active AND ta.valid_from <= ist_today()
        AND (ta.valid_to IS NULL OR ta.valid_to >= ist_today())`, [employeeId]);
  return rows.map((r) => ({
    id: r.location_id, kind: r.kind, name: r.name,
    lat: Number(r.latitude), lng: Number(r.longitude), radius: r.radius_metres,
  }));
}

/** The server decides whether a fix is acceptable. The client never does. */
function verifyFix(sites, fix) {
  if (fix.isMocked) {
    throw unprocessable('This device is reporting a mock location. Turn off the mock location app and try again.', 'mock_location');
  }
  if (fix.accuracy > config.maxAccuracyMetres) {
    throw unprocessable(`The GPS reading is accurate to only ${Math.round(fix.accuracy)} m. Move outside and try again.`, 'poor_accuracy');
  }
  if (!sites.length) {
    throw unprocessable('No check-in location is registered for you. Ask your admin to set one.', 'no_site');
  }
  const nearest = sites
    .map((s) => ({ site: s, distance: metresBetween({ lat: fix.latitude, lng: fix.longitude }, s) }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (nearest.distance > nearest.site.radius) {
    throw unprocessable(
      `You are ${nearest.distance} m from ${nearest.site.name}. Check-in is allowed within ${nearest.site.radius} m.`,
      'outside_radius');
  }
  return nearest;
}

router.get('/attendance/sites', wrap(async (req, res) => {
  res.json(await permittedSites(req.user.id));
}));

router.post('/attendance/check-in', wrap(async (req, res) => {
  const fix = parse(fixSchema, req.body);
  const sites = await permittedSites(req.user.id);
  const { site, distance } = verifyFix(sites, fix);

  const result = await tx(req.user, async (c) => {
    const emp = (await c.query(
      `SELECT role, shift_start, late_grace_minutes FROM employees WHERE employee_id = $1`,
      [req.user.id])).rows[0];

    const late = (await c.query(
      `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::time > ($1::time + make_interval(mins => $2)) AS late`,
      [emp.shift_start, emp.late_grace_minutes])).rows[0].late;

    const status = emp.role === 'Trainer' ? 'Field Work' : late ? 'Late' : 'Present';

    // Single atomic statement. Two concurrent requests cannot both win:
    // the unique index on (employee_id, work_date) decides, and the loser
    // gets zero rows rather than a 500 from the immutability trigger.
    const ins = await c.query(
      `INSERT INTO attendance (employee_id, work_date, check_in_time, check_in_latitude,
         check_in_longitude, check_in_accuracy, check_in_location_id, check_in_distance_m,
         check_in_device, status)
       VALUES ($1, ist_today(), now(), $2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (employee_id, work_date) DO NOTHING
       RETURNING *`,
      [req.user.id, fix.latitude, fix.longitude, fix.accuracy, site.id, distance,
       fix.device ?? {}, status]);

    if (!ins.rowCount) return null;

    if (late) {
      const name = (await c.query(`SELECT name FROM employees WHERE employee_id=$1`, [req.user.id])).rows[0].name;
      await c.query(`INSERT INTO notifications (recipient_id, kind, body) VALUES (NULL,'attendance',$1)`,
        [`${name} checked in late.`]);
    }
    return ins.rows[0];
  });

  if (!result) throw conflict('You have already checked in today.', 'already_checked_in');
  res.status(201).json({ attendance: result, site: site.name, distanceMetres: distance });
}));

router.post('/attendance/check-out', wrap(async (req, res) => {
  const fix = parse(fixSchema, req.body);
  const sites = await permittedSites(req.user.id);
  const { site, distance } = verifyFix(sites, fix);

  const row = await tx(req.user, async (c) => {
    const cur = (await c.query(
      `SELECT attendance_id, check_in_time, check_out_time FROM attendance
        WHERE employee_id = $1 AND work_date = ist_today() FOR UPDATE`, [req.user.id])).rows[0];
    if (!cur?.check_in_time) throw conflict('You have not checked in today.', 'not_checked_in');
    if (cur.check_out_time) throw conflict('You have already checked out today.', 'already_checked_out');

    return (await c.query(
      `UPDATE attendance SET check_out_time = now(), check_out_latitude=$2, check_out_longitude=$3,
              check_out_accuracy=$4, check_out_location_id=$5, check_out_distance_m=$6, check_out_device=$7
        WHERE attendance_id = $1 RETURNING *`,
      [cur.attendance_id, fix.latitude, fix.longitude, fix.accuracy, site.id, distance, fix.device ?? {}])).rows[0];
  });
  res.json({ attendance: row, site: site.name, distanceMetres: distance });
}));

router.get('/attendance/me', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT a.*, l.name AS site_name FROM attendance a
       LEFT JOIN locations l ON l.location_id = a.check_in_location_id
      WHERE a.employee_id = $1 AND ($2::text IS NULL OR to_char(a.work_date,'YYYY-MM') = $2)
      ORDER BY a.work_date DESC LIMIT $3 OFFSET $4`,
    [req.user.id, month, limit, offset]));
  res.json(rows);
}));

/* ────────────────────────────────────────────────────────────── tasks */

router.get('/tasks/me', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const views = {
    today: `t.due_date = ist_today() AND t.effective_status <> 'Completed'`,
    upcoming: `t.due_date > ist_today()`,
    completed: `t.status = 'Completed'`,
    overdue: `t.effective_status = 'Overdue'`,
  };
  const clause = views[req.query.view] ?? 'true';
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT * FROM v_tasks t WHERE t.assigned_to = $1 AND ${clause}
      ORDER BY t.due_date, t.due_time LIMIT $2 OFFSET $3`, [req.user.id, limit, offset]));
  res.json(rows);
}));

router.get('/tasks/:id', uuidParam('id'), wrap(async (req, res) => {
  const out = await tx(req.user, async (c) => {
    const t = (await c.query(`SELECT * FROM v_tasks WHERE task_id = $1`, [req.params.id])).rows[0];
    if (!t) return null;
    if (!req.user.isAdmin && t.assigned_to !== req.user.id) throw forbidden('That task is not assigned to you.');
    const subs = (await c.query(
      `SELECT * FROM work_submissions WHERE task_id = $1 ORDER BY attempt_no`, [req.params.id])).rows;
    return { ...t, submissions: subs };
  });
  if (!out) throw notFound('That task does not exist.');
  res.json(out);
}));

router.post('/tasks', adminOnly, wrap(async (req, res) => {
  const f = parse(taskSchema, req.body);
  const task = await tx(req.user, async (c) => {
    const exists = await c.query(`SELECT 1 FROM employees WHERE employee_id=$1 AND status='Active'`, [f.assignedTo]);
    if (!exists.rowCount) throw unprocessable('That employee does not exist.', 'unknown_employee');
    const t = (await c.query(
      `INSERT INTO tasks (title, description, assigned_to, assigned_by, priority, due_date, due_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [f.title, f.description ?? null, f.assignedTo, req.user.id, f.priority, f.dueDate, f.dueTime])).rows[0];
    await c.query(`INSERT INTO notifications (recipient_id, kind, body, task_id) VALUES ($1,'task_assigned',$2,$3)`,
      [f.assignedTo, `New task ${t.task_code}: ${t.title}`, t.task_id]);
    return t;
  });
  res.status(201).json(task);
}));

/** Only these transitions exist. Anything else is a 409, not a silent write. */
const TRANSITIONS = {
  start: { from: ['Not Started', 'Returned'], to: 'In Progress' },
  submit: { from: ['In Progress'], to: 'Submitted' },
};

router.post('/tasks/:id/start', uuidParam('id'), wrap(async (req, res) => {
  const task = await tx(req.user, async (c) => {
    const t = (await c.query(
      `SELECT task_id, status, assigned_to FROM tasks WHERE task_id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [req.params.id])).rows[0];
    if (!t) throw notFound('That task does not exist.');
    if (t.assigned_to !== req.user.id) throw forbidden('That task is not assigned to you.');
    if (!TRANSITIONS.start.from.includes(t.status)) {
      throw conflict(`A task that is ${t.status.toLowerCase()} cannot be started.`, 'bad_transition');
    }
    return (await c.query(
      `UPDATE tasks SET status='In Progress', started_at=COALESCE(started_at, now())
        WHERE task_id=$1 RETURNING *`, [t.task_id])).rows[0];
  });
  res.json(task);
}));

router.post('/tasks/:id/submit', uuidParam('id'), wrap(async (req, res) => {
  const f = parse(z.object({
    description: z.string().trim().min(1).max(5000),
    remarks: z.string().max(2000).optional(),
    attachmentIds: z.array(uuid).max(5).default([]),
  }).strict(), req.body);

  const sub = await tx(req.user, async (c) => {
    const t = (await c.query(
      `SELECT task_id, task_code, title, status, assigned_to FROM tasks
        WHERE task_id=$1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id])).rows[0];
    if (!t) throw notFound('That task does not exist.');
    if (t.assigned_to !== req.user.id) throw forbidden('That task is not assigned to you.');
    if (!TRANSITIONS.submit.from.includes(t.status)) throw conflict('Start the task before submitting it.', 'bad_transition');

    const attempt = (await c.query(
      `SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM work_submissions WHERE task_id=$1`, [t.task_id])).rows[0].n;
    const s = (await c.query(
      `INSERT INTO work_submissions (task_id, employee_id, attempt_no, description, remarks)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [t.task_id, req.user.id, attempt, f.description, f.remarks ?? null])).rows[0];

    if (f.attachmentIds.length) {
      // The ownership filter is what stops one employee attaching another's file.
      const upd = await c.query(
        `UPDATE attachments SET submission_id=$1
          WHERE attachment_id = ANY($2::uuid[]) AND uploaded_by=$3
            AND submission_id IS NULL AND claim_id IS NULL AND task_id IS NULL`,
        [s.submission_id, f.attachmentIds, req.user.id]);
      if (upd.rowCount !== f.attachmentIds.length) {
        throw forbidden('One of those attachments is not yours or is already used.');
      }
    }
    await c.query(`UPDATE tasks SET status='Submitted', submitted_at=now() WHERE task_id=$1`, [t.task_id]);
    await c.query(`INSERT INTO notifications (recipient_id, kind, body, task_id) VALUES (NULL,'review',$1,$2)`,
      [`${t.task_code} submitted for review.`, t.task_id]);
    return s;
  });
  res.status(201).json(sub);
}));

router.post('/admin/submissions/:id/approve', uuidParam('id'), adminOnly, wrap(async (req, res) => {
  const out = await tx(req.user, async (c) => {
    const s = (await c.query(
      `SELECT s.submission_id, s.task_id, s.employee_id, s.review_status, t.task_code
         FROM work_submissions s JOIN tasks t ON t.task_id=s.task_id
        WHERE s.submission_id=$1 FOR UPDATE OF s`, [req.params.id])).rows[0];
    if (!s) throw notFound('That submission does not exist.');
    if (s.review_status !== 'Pending') throw conflict('This submission was already reviewed.', 'already_reviewed');
    await c.query(`UPDATE work_submissions SET review_status='Approved', reviewed_by=$2, reviewed_at=now()
                    WHERE submission_id=$1`, [s.submission_id, req.user.id]);
    await c.query(`UPDATE tasks SET status='Completed', completed_at=now() WHERE task_id=$1`, [s.task_id]);
    await c.query(`INSERT INTO notifications (recipient_id, kind, body, task_id) VALUES ($1,'approved',$2,$3)`,
      [s.employee_id, `Your work on ${s.task_code} was approved.`, s.task_id]);
    return { taskId: s.task_id, status: 'Completed' };
  });
  res.json(out);
}));

router.post('/admin/submissions/:id/return', uuidParam('id'), adminOnly, wrap(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(2000) }).strict(), req.body);
  const out = await tx(req.user, async (c) => {
    const s = (await c.query(
      `SELECT s.submission_id, s.task_id, s.employee_id, s.review_status, t.task_code
         FROM work_submissions s JOIN tasks t ON t.task_id=s.task_id
        WHERE s.submission_id=$1 FOR UPDATE OF s`, [req.params.id])).rows[0];
    if (!s) throw notFound('That submission does not exist.');
    if (s.review_status !== 'Pending') throw conflict('This submission was already reviewed.', 'already_reviewed');
    await c.query(`UPDATE work_submissions SET review_status='Returned', return_reason=$2,
                     reviewed_by=$3, reviewed_at=now() WHERE submission_id=$1`,
      [s.submission_id, reason, req.user.id]);
    await c.query(`UPDATE tasks SET status='Returned', submitted_at=NULL WHERE task_id=$1`, [s.task_id]);
    await c.query(`INSERT INTO notifications (recipient_id, kind, body, task_id) VALUES ($1,'returned',$2,$3)`,
      [s.employee_id, `Work returned on ${s.task_code}: ${reason}`, s.task_id]);
    return { taskId: s.task_id, status: 'Returned' };
  });
  res.json(out);
}));

/* ───────────────────────────────────────────────────────────── claims */

const CAP_COLUMN = { Food: 'cap_food', Stay: 'cap_stay' };

router.post('/claims', wrap(async (req, res) => {
  const f = parse(claimSchema, req.body);
  const paise = Math.round(f.amount * 100);

  const claim = await tx(req.user, async (c) => {
    const emp = (await c.query(
      `SELECT claims_enabled, cap_food, cap_stay FROM employees WHERE employee_id=$1`, [req.user.id])).rows[0];
    if (!emp.claims_enabled) throw forbidden('Reimbursement is not enabled on your account.');

    const today = (await c.query(`SELECT ist_today() AS d`)).rows[0].d;
    if (f.date > today.toISOString().slice(0, 10)) {
      throw unprocessable('You cannot claim for a future date.', 'future_date');
    }

    // The cap is a daily total, so read-then-write must be serialised per
    // (employee, date, category). Row locks are not usable here: on the
    // first claim of the day there are no rows to lock, which is exactly
    // when two parallel requests could both see "nothing claimed yet".
    // A transaction advisory lock covers that case and is released on
    // COMMIT or ROLLBACK automatically.
    const capCol = CAP_COLUMN[f.category];
    if (capCol) {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`claim:${req.user.id}:${f.date}:${f.category}`]);

      const cap = emp[capCol] * 100;
      const used = Number((await c.query(
        `SELECT COALESCE(SUM(amount_paise),0) AS used FROM claims
          WHERE employee_id=$1 AND claim_date=$2 AND category=$3 AND status <> 'Rejected'`,
        [req.user.id, f.date, f.category])).rows[0].used);
      if (used + paise > cap) {
        const left = Math.max(0, cap - used) / 100;
        throw unprocessable(
          f.category === 'Food'
            ? `Max limit reached for the day. ₹${cap / 100} is the daily food limit and ₹${used / 100} is already claimed, so ₹${left} remains.`
            : `Max limit crossed. ₹${cap / 100} is the daily stay limit and ₹${used / 100} is already claimed, so ₹${left} remains.`,
          'daily_limit_exceeded',
          { cap: cap / 100, used: used / 100, remaining: left });
      }
    }

    const row = (await c.query(
      `INSERT INTO claims (employee_id, claim_date, category, amount_paise, place, location, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, f.date, f.category, paise, f.place ?? null, f.location ?? null, f.note ?? null])).rows[0];

    const upd = await c.query(
      `UPDATE attachments SET claim_id=$1 WHERE attachment_id=$2 AND uploaded_by=$3
         AND claim_id IS NULL AND submission_id IS NULL AND task_id IS NULL`,
      [row.claim_id, f.attachmentId, req.user.id]);
    if (!upd.rowCount) throw forbidden('That bill is not yours or is already attached to another claim.');

    await c.query(`INSERT INTO notifications (recipient_id, kind, body) VALUES (NULL,'claim',$1)`,
      [`A ${f.category.toLowerCase()} claim of ₹${f.amount} was submitted.`]);
    return row;
  });
  res.status(201).json(claim);
}));

router.get('/claims/me', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT * FROM claims WHERE employee_id=$1
       AND ($2::text IS NULL OR to_char(claim_date,'YYYY-MM')=$2)
     ORDER BY claim_date DESC, created_at DESC LIMIT $3 OFFSET $4`,
    [req.user.id, month, limit, offset]));
  res.json(rows);
}));

router.get('/claims/:id', uuidParam('id'), wrap(async (req, res) => {
  const { rows } = await tx(req.user, (c) => c.query(`SELECT * FROM claims WHERE claim_id=$1`, [req.params.id]));
  // RLS already filtered; an employee asking for someone else's claim sees a 404,
  // which avoids confirming that the record exists at all.
  if (!rows[0]) throw notFound('That claim does not exist.');
  res.json(rows[0]);
}));

router.get('/admin/claims', adminOnly, wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const status = ['Pending', 'Approved', 'Rejected'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT c.*, e.name AS employee_name FROM claims c JOIN employees e ON e.employee_id=c.employee_id
      WHERE ($1::text IS NULL OR c.status::text=$1)
      ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`, [status, limit, offset]));
  res.json(rows);
}));

router.post('/admin/claims/:id/decide', uuidParam('id'), adminOnly, wrap(async (req, res) => {
  const f = parse(z.object({
    decision: z.enum(['Approved', 'Rejected']),
    reason: z.string().trim().max(2000).optional(),
  }).strict(), req.body);
  if (f.decision === 'Rejected' && !f.reason) {
    throw unprocessable('Give a reason so the employee knows what to correct.', 'reason_required');
  }
  const out = await tx(req.user, async (c) => {
    const cur = (await c.query(`SELECT claim_id, employee_id, status, amount_paise FROM claims
                                 WHERE claim_id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!cur) throw notFound('That claim does not exist.');
    if (cur.status !== 'Pending') throw conflict('This claim was already reviewed.', 'already_reviewed');
    const row = (await c.query(
      `UPDATE claims SET status=$2, reject_reason=$3, reviewed_by=$4, reviewed_at=now()
        WHERE claim_id=$1 RETURNING *`,
      [cur.claim_id, f.decision, f.decision === 'Rejected' ? f.reason : null, req.user.id])).rows[0];
    await c.query(`INSERT INTO notifications (recipient_id, kind, body) VALUES ($1,$2,$3)`,
      [cur.employee_id, f.decision === 'Approved' ? 'approved' : 'returned',
       `Your claim of ₹${cur.amount_paise / 100} was ${f.decision.toLowerCase()}.`]);
    return row;
  });
  res.json(out);
}));

/* ────────────────────────────────────────────────────────────── files */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

router.post('/files', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw badRequest('No file was uploaded.');
  // Content decides the type. req.file.mimetype is client-supplied and ignored.
  const mime = sniff(req.file.buffer, req.file.originalname);
  const key = storageKey(req.user.id);
  await putObject(key, req.file.buffer);
  const { rows } = await tx(req.user, (c) => c.query(
    `INSERT INTO attachments (uploaded_by, file_name, storage_key, mime_type, size_bytes, checksum_sha256)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING attachment_id, file_name, mime_type, size_bytes`,
    [req.user.id, safeName(req.file.originalname), key, mime, req.file.size, sha256(req.file.buffer)]));
  res.status(201).json(rows[0]);
}));

router.get('/files/:id/link', uuidParam('id'), wrap(async (req, res) => {
  const att = await loadAttachmentForViewer(req.params.id, req.user);
  const { exp, sig } = signDownload(att.attachment_id, req.user.id);
  res.json({ url: `/api/files/${att.attachment_id}/download?exp=${exp}&sig=${sig}`, expiresAt: exp });
}));

router.get('/files/:id/download', uuidParam('id'), wrap(async (req, res) => {
  verifyDownload(req.params.id, req.user.id, req.query.exp, req.query.sig);
  const att = await loadAttachmentForViewer(req.params.id, req.user);
  const body = await getObject(att.storage_key);
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${att.file_name}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
}));

/**
 * Uploader or admin only, re-checked on every download rather than only
 * when the link is minted. The query must run inside tx() so the RLS
 * actor context is set: a bare pool.query() here would see a NULL actor
 * and hide the row from its own owner.
 */
async function loadAttachmentForViewer(id, user) {
  const { rows } = await tx(user, (c) => c.query(
    `SELECT attachment_id, uploaded_by, storage_key, mime_type, file_name
       FROM attachments WHERE attachment_id=$1`, [id]));
  const att = rows[0];
  // RLS has already removed other people's rows, so a miss here means
  // either "no such file" or "not yours". Both answer 404 so the endpoint
  // cannot be used to probe which attachment ids exist.
  if (!att) throw notFound('That file does not exist.');
  if (!user.isAdmin && att.uploaded_by !== user.id) throw forbidden('That file is not yours.');
  return att;
}

/* ─────────────────────────────────────────────────────────────── admin */

router.get('/admin/dashboard', adminOnly, wrap(async (req, res) => {
  const [board, work] = await Promise.all([
    tx(req.user, (c) => c.query(`SELECT * FROM v_today_board ORDER BY name`)),
    tx(req.user, (c) => c.query(
      `SELECT COUNT(*) AS assigned,
              COUNT(*) FILTER (WHERE effective_status='Completed') AS completed,
              COUNT(*) FILTER (WHERE effective_status='Overdue')   AS overdue,
              COUNT(*) FILTER (WHERE effective_status='Submitted') AS submitted
         FROM v_tasks WHERE due_date = ist_today()`)),
  ]);
  res.json({ businessDate: (await pool.query('SELECT ist_today() AS d')).rows[0].d, work: work.rows[0], board: board.rows });
}));

router.post('/admin/employees', adminOnly, wrap(async (req, res) => {
  const f = parse(employeeSchema, req.body);
  assertPasswordPolicy(f.password);
  const hash = await hashPassword(f.password);
  const out = await tx(req.user, async (c) => {
    const code = (await c.query(
      `SELECT 'EMP-' || lpad((COALESCE(MAX(substring(employee_code from 5)::int),0)+1)::text,3,'0') AS code
         FROM employees WHERE employee_code ~ '^EMP-[0-9]+$'`)).rows[0].code;
    try {
      return (await c.query(
        `INSERT INTO employees (employee_code,name,role,email,phone,password_hash,is_admin,
            office_location_id,claims_enabled,cap_food,cap_stay)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING employee_id, employee_code, name, role, email, is_admin, claims_enabled, cap_food, cap_stay`,
        [code, f.name, f.role, f.email, f.phone ?? null, hash, f.isAdmin,
         f.officeLocationId ?? null, f.claimsEnabled, f.capFood, f.capStay])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('An account with that email already exists.', 'email_taken');
      throw e;
    }
  });
  res.status(201).json(out);
}));

router.get('/admin/employees', adminOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT employee_id, employee_code, name, role, email, is_admin, status, claims_enabled,
            cap_food, cap_stay FROM employees ORDER BY employee_code`);
  res.json(rows);
}));

router.get('/admin/audit', adminOnly, wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const { rows } = await pool.query(
    `SELECT a.audit_id, a.action, a.entity, a.record_id, a.created_at, e.name AS actor_name
       FROM audit_log a LEFT JOIN employees e ON e.employee_id=a.actor_id
      ORDER BY a.audit_id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json(rows);
}));

router.get('/notifications', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]));
  res.json(rows);
}));
