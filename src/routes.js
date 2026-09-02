import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  config, pool, tx, ApiError, badRequest, forbidden, notFound, conflict,
  unprocessable, wrap, uuidParam, metresBetween, logger,
} from './core.js';
import { login, revoke, authenticate, adminOnly, hashPassword, assertPasswordPolicy,
  requestPasswordReset, completePasswordReset } from './auth.js';
import { putObject, getObject, sniff, safeName, storageKey, sha256, signDownload, verifyDownload } from './storage.js';
import { lat } from './lat.js';
import { idempotent, notify, notifyAdmins, notifyEveryone } from './reliability.js';

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

/**
 * Always the same answer, whether or not the account exists.
 *
 * There is no mail service in this system and adding one is not justified
 * for a team of this size, so the link is delivered by the admin. In
 * development the token is returned to make the flow testable; in
 * production it is only written to the server log for the admin to pass on.
 */
router.post('/auth/forgot-password', wrap(async (req, res) => {
  const { email } = req.body ?? {};
  const out = await requestPasswordReset(email, req.ip);
  const body = {
    message: 'If that email belongs to an active account, a reset link has been created. Ask your admin for it.',
    requestId: req.id,
  };
  if (out.issued && !config.isProd) body.token = out.token;
  res.json(body);
}));

router.post('/auth/reset-password', wrap(async (req, res) => {
  const { token, password } = req.body ?? {};
  await completePasswordReset(token, password, req.id);
  res.json({ message: 'Your password has been changed. Sign in with it.', requestId: req.id });
}));

/* ──────────────────────────────────────────── everything below is auth */

router.use(authenticate);

// The authoritative request id travels with the actor so audit rows can be
// traced back to the exact request a user reported.
router.use((req, _res, next) => {
  if (req.user) req.user.reqId = req.id;
  next();
});

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

async function permittedSites(actor) {
  // Assignment-restricted, unchanged from the existing model: an employee
  // may punch in at their own office, or at a school explicitly assigned
  // to them. Widening this to "any active school" would weaken an existing
  // control, so it is a business decision, not an implementation detail.
  // Runs with actor context: trainer_assignments has forced RLS, so a bare
  // pool query would see no assignments and no school would ever match.
  const { rows } = await tx(actor, (c) => c.query(
    `SELECT l.location_id, l.kind, l.name, l.zone, l.latitude, l.longitude, l.radius_metres
       FROM locations l JOIN employees e ON e.office_location_id = l.location_id
      WHERE e.employee_id = $1 AND l.is_active
      UNION
     SELECT l.location_id, l.kind, l.name, l.zone, l.latitude, l.longitude, l.radius_metres
       FROM trainer_assignments ta JOIN locations l ON l.location_id = ta.location_id
      WHERE ta.employee_id = $1 AND l.is_active AND ta.valid_from <= ist_today()
        AND (ta.valid_to IS NULL OR ta.valid_to >= ist_today())`, [actor.id]));
  return rows.map((r) => ({
    id: r.location_id, kind: r.kind, name: r.name, zone: r.zone,
    lat: Number(r.latitude), lng: Number(r.longitude), radius: r.radius_metres,
  }));
}

/**
 * The server decides where the employee is. The client only reports GPS.
 *
 * Order matters: an office match wins outright, because an office and a
 * school could in principle overlap and the office is the more specific
 * answer. Only if no office matches are schools considered.
 *
 * Where two schools both contain the point, the nearer one wins — but only
 * if it is clearly nearer. A near-tie is reported as ambiguous rather than
 * guessed, because a wrong school on an attendance record is worse than
 * asking the employee to report it.
 */
const AMBIGUITY_MARGIN_M = 15;

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

  const measured = sites
    .map((s) => ({ site: s, distance: metresBetween({ lat: fix.latitude, lng: fix.longitude }, s) }))
    .sort((a, b) => a.distance - b.distance);

  const inside = measured.filter((m) => m.distance <= m.site.radius);

  // Step 1: office wins if the employee is inside one.
  const office = inside.find((m) => m.site.kind === 'office');
  if (office) return office;

  // Step 2: schools, nearest first.
  const schools = inside.filter((m) => m.site.kind === 'school');
  if (schools.length === 1) return schools[0];
  if (schools.length > 1) {
    const [first, second] = schools;
    if (second.distance - first.distance < AMBIGUITY_MARGIN_M) {
      throw unprocessable(
        `You appear to be between ${first.site.name} and ${second.site.name}. Move closer to the one you are visiting and try again.`,
        'ambiguous_location',
        { candidates: schools.slice(0, 3).map((m) => ({ name: m.site.name, zone: m.site.zone, distanceMetres: m.distance })) });
    }
    return first;
  }

  // Step 3: nothing matched. The nearest is named so the message is useful.
  const nearest = measured[0];
  throw unprocessable(
    `You are ${nearest.distance} m from ${nearest.site.name}. Check-in is allowed within ${nearest.site.radius} m.`,
    'outside_radius');
}

router.get('/attendance/sites', wrap(async (req, res) => {
  res.json(await permittedSites(req.user));
}));

router.post('/attendance/check-in', idempotent(wrap(async (req, res) => {
  const fix = parse(fixSchema, req.body);
  const sites = await permittedSites(req.user);
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
      await notifyAdmins(c, { kind: 'attendance', body: `${name} checked in late.`, reqId: req.id });
    }
    return ins.rows[0];
  });

  if (!result) throw conflict('You have already checked in today.', 'already_checked_in');
  // The server reports what it matched. The client never chose it.
  res.status(201).json({
    attendance: result,
    locationType: site.kind === 'office' ? 'OFFICE' : 'SCHOOL',
    location: site.name, zone: site.zone ?? null,
    site: site.name, distanceMetres: distance,
  });
})));

router.post('/attendance/check-out', idempotent(wrap(async (req, res) => {
  const fix = parse(fixSchema, req.body);
  const sites = await permittedSites(req.user);
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
  // A school visit gets a draft the employee can review and send. Office
  // attendance does not: there is no group expecting an update.
  const visit = row.check_in_location_id
    ? (await pool.query(`SELECT kind, name, zone FROM locations WHERE location_id = $1`,
        [row.check_in_location_id])).rows[0]
    : null;

  res.json({
    attendance: row,
    locationType: site.kind === 'office' ? 'OFFICE' : 'SCHOOL',
    location: site.name, zone: site.zone ?? null,
    site: site.name, distanceMetres: distance,
    visitDraft: visit?.kind === 'school'
      ? buildVisitDraft({ school: visit.name, zone: visit.zone,
          checkIn: row.check_in_time, checkOut: row.check_out_time })
      : null,
  });
})));

/**
 * The WhatsApp message text, built on the server from the stored
 * attendance record so it cannot disagree with what actually happened.
 *
 * Sapience Team never sends this. It hands the employee prepared text;
 * they pick the group and press Send. No WhatsApp API, no credentials.
 */
function buildVisitDraft({ school, zone, checkIn, checkOut }) {
  const t = (v) => new Date(v).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/\s*(am|pm)$/i, (m) => m.toUpperCase());
  const day = new Date(checkIn).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  return [
    'School Visit Update', '',
    `Date: ${day}`, '',
    `School: ${school}`,
    `Zone: ${zone ?? '-'}`, '',
    `Punch In: ${t(checkIn)}`,
    `Punch Out: ${checkOut ? t(checkOut) : '-'}`, '',
    'School visit completed.',
  ].join('\n');
}

router.get('/attendance/me', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  // Type and zone come from the location the server matched at punch-in,
  // so history shows what actually happened rather than anything the
  // client believed at the time.
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT a.*, l.name AS site_name, l.zone AS site_zone,
            CASE WHEN l.kind = 'office' THEN 'OFFICE'
                 WHEN l.kind = 'school' THEN 'SCHOOL' END AS location_type
       FROM attendance a
       LEFT JOIN locations l ON l.location_id = a.check_in_location_id
      WHERE a.employee_id = $1 AND ($2::text IS NULL OR to_char(a.work_date,'YYYY-MM') = $2)
      ORDER BY a.work_date DESC LIMIT $3 OFFSET $4`,
    [req.user.id, month, limit, offset]));
  res.json(rows);
}));

/** Admin view of everyone's attendance for a day. Read-only. */
router.get('/admin/attendance', adminOnly, wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT e.employee_id, e.name AS employee_name, e.role,
            a.attendance_id, a.work_date, a.check_in_time, a.check_out_time,
            a.check_in_accuracy, a.status,
            l.name AS site_name, l.zone AS site_zone,
            CASE WHEN l.kind = 'office' THEN 'OFFICE'
                 WHEN l.kind = 'school' THEN 'SCHOOL' END AS location_type
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id = e.employee_id
            AND a.work_date = COALESCE($1::date, ist_today())
       LEFT JOIN locations l ON l.location_id = a.check_in_location_id
      WHERE e.status = 'Active'
      ORDER BY e.name LIMIT $2 OFFSET $3`, [date, limit, offset]));
  res.json(rows);
}));

/* ───────────────────────────────────────────────────── school directory */

const schoolSchema = z.object({
  name: z.string().trim().min(1).max(120),
  zone: z.string().trim().min(1).max(80),
  address: z.string().trim().max(400).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMetres: z.number().int().min(20).max(2000).default(100),
  isActive: z.boolean().default(true),
}).strict();

/** Employees may read the directory; only admins may change it. */
router.get('/schools', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const q = (req.query.q || '').trim();
  const { rows } = await pool.query(
    `SELECT location_id, name, zone, address, latitude, longitude, radius_metres, is_active
       FROM locations
      WHERE kind = 'school'
        AND ($1::boolean IS NULL OR is_active = $1)
        AND ($2 = '' OR name ILIKE '%'||$2||'%' OR zone ILIKE '%'||$2||'%')
      ORDER BY is_active DESC, zone, name LIMIT $3 OFFSET $4`,
    [req.query.active === undefined ? null : req.query.active === 'true', q, limit, offset]);
  res.json(rows);
}));

router.get('/schools/:id', uuidParam('id'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT location_id, name, zone, address, latitude, longitude, radius_metres, is_active, created_at, updated_at
       FROM locations WHERE location_id = $1 AND kind = 'school'`, [req.params.id]);
  if (!rows[0]) throw notFound('That school does not exist.');

  // trainer_assignments has forced RLS, so this needs actor context too.
  const assigned = (await tx(req.user, (c) => c.query(
    `SELECT e.employee_id, e.name, e.role FROM trainer_assignments ta
       JOIN employees e ON e.employee_id = ta.employee_id
      WHERE ta.location_id = $1 AND (ta.valid_to IS NULL OR ta.valid_to >= ist_today())
      ORDER BY e.name`, [req.params.id]))).rows;

  // Visits come from existing attendance rows; nothing is duplicated.
  // Must run inside tx(): attendance has forced RLS, and a bare pool query
  // has no actor context, so it would return nothing even for an admin.
  const visits = (await tx(req.user, (c) => c.query(
    `SELECT a.work_date, e.name AS employee_name, a.check_in_time, a.check_out_time
       FROM attendance a JOIN employees e ON e.employee_id = a.employee_id
      WHERE a.check_in_location_id = $1
      ORDER BY a.work_date DESC LIMIT 20`, [req.params.id]))).rows;

  res.json({ ...rows[0], assignedEmployees: assigned, recentVisits: visits });
}));

router.post('/admin/schools', adminOnly, idempotent(wrap(async (req, res) => {
  const f = parse(schoolSchema, req.body);
  const out = await tx(req.user, async (c) => {
    try {
      return (await c.query(
        `INSERT INTO locations (kind, name, zone, address, latitude, longitude, radius_metres, is_active)
         VALUES ('school',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [f.name, f.zone, f.address ?? null, f.latitude, f.longitude, f.radiusMetres, f.isActive])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('A school with that name already exists.', 'school_exists');
      throw e;
    }
  }, { reason: 'school created' });
  res.status(201).json(out);
})));

router.patch('/admin/schools/:id', uuidParam('id'), adminOnly, idempotent(wrap(async (req, res) => {
  const f = parse(schoolSchema.partial().strict(), req.body);
  if (!Object.keys(f).length) throw badRequest('Nothing to change.');

  const out = await tx(req.user, async (c) => {
    const cur = (await c.query(
      `SELECT * FROM locations WHERE location_id=$1 AND kind='school' FOR UPDATE`, [req.params.id])).rows[0];
    if (!cur) throw notFound('That school does not exist.');
    // Deactivating never deletes: historical attendance still points here.
    return (await c.query(
      `UPDATE locations SET name=$2, zone=$3, address=$4, latitude=$5, longitude=$6,
              radius_metres=$7, is_active=$8
        WHERE location_id=$1 RETURNING *`,
      [req.params.id,
       f.name ?? cur.name, f.zone ?? cur.zone, f.address ?? cur.address,
       f.latitude ?? cur.latitude, f.longitude ?? cur.longitude,
       f.radiusMetres ?? cur.radius_metres,
       f.isActive === undefined ? cur.is_active : f.isActive])).rows[0];
  }, { reason: f.isActive === false ? 'school deactivated' : 'school updated' });
  res.json(out);
})));

/** Who may punch in where. Kept explicit because it is a security rule. */
router.post('/admin/schools/:id/assign', uuidParam('id'), adminOnly, wrap(async (req, res) => {
  const f = parse(z.object({ employeeId: uuid, remove: z.boolean().default(false) }).strict(), req.body);
  const out = await tx(req.user, async (c) => {
    const school = (await c.query(
      `SELECT location_id, name FROM locations WHERE location_id=$1 AND kind='school'`, [req.params.id])).rows[0];
    if (!school) throw notFound('That school does not exist.');

    if (f.remove) {
      await c.query(
        `UPDATE trainer_assignments SET valid_to = ist_today()
          WHERE employee_id=$1 AND location_id=$2 AND (valid_to IS NULL OR valid_to >= ist_today())`,
        [f.employeeId, req.params.id]);
      return { assigned: false };
    }
    await c.query(
      `INSERT INTO trainer_assignments (employee_id, location_id) VALUES ($1,$2)
       ON CONFLICT (employee_id, location_id, valid_from) DO NOTHING`,
      [f.employeeId, req.params.id]);
    return { assigned: true };
  }, { reason: f.remove ? 'school assignment removed' : 'school assignment added' });
  res.json(out);
}));

/* ────────────────────────────────────────────────────── broadcasts */

/**
 * The CEO tells the whole team something.
 *
 * The broadcast row is the durable record; the notification fan-out is a
 * nudge on top. If the fan-out fails the announcement still exists and
 * every employee can still read it, which is why it is not stored only as
 * notifications.
 */
router.post('/admin/broadcasts', adminOnly, idempotent(wrap(async (req, res) => {
  const f = parse(z.object({
    title: z.string().trim().min(1).max(140),
    message: z.string().trim().min(1).max(4000),
    priority: z.enum(['Normal', 'Important', 'Urgent']).default('Normal'),
  }).strict(), req.body);

  const out = await tx(req.user, async (c) => {
    const b = (await c.query(
      `INSERT INTO broadcasts (title, message, priority, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [f.title, f.message, f.priority, req.user.id])).rows[0];

    // Savepoint-protected: a failure here is logged, never fatal to the
    // broadcast itself.
    await notifyEveryone(c, {
      kind: 'broadcast',
      body: f.priority === 'Normal' ? f.title : `${f.priority}: ${f.title}`,
      reqId: req.id,
    });
    return b;
  });
  res.status(201).json(out);
})));

/** Everyone signed in sees every published broadcast. That is the point. */
router.get('/broadcasts', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT b.broadcast_id, b.title, b.message, b.priority, b.published_at,
            e.name AS published_by,
            (r.employee_id IS NOT NULL) AS read
       FROM broadcasts b
       JOIN employees e ON e.employee_id = b.created_by
       LEFT JOIN broadcast_reads r
              ON r.broadcast_id = b.broadcast_id AND r.employee_id = $1
      ORDER BY b.published_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]));
  res.json(rows);
}));

router.post('/broadcasts/:id/read', uuidParam('id'), wrap(async (req, res) => {
  await tx(req.user, (c) => c.query(
    `INSERT INTO broadcast_reads (broadcast_id, employee_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [req.params.id, req.user.id]));
  res.status(204).end();
}));

/** Admin view: what was sent, and how many people have opened it. */
router.get('/admin/broadcasts', adminOnly, wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT b.*, e.name AS published_by,
            (SELECT count(*)::int FROM broadcast_reads r WHERE r.broadcast_id = b.broadcast_id) AS read_count,
            (SELECT count(*)::int FROM employees WHERE status = 'Active') AS audience
       FROM broadcasts b JOIN employees e ON e.employee_id = b.created_by
      ORDER BY b.published_at DESC LIMIT $1 OFFSET $2`, [limit, offset]));
  res.json(rows);
}));

/* ─────────────────────────────────────────── attendance incidents */

/**
 * A sanctioned way to say "check-in genuinely failed".
 *
 * This never creates or edits an attendance record. The original evidence,
 * or its absence, stands exactly as recorded. The admin reviews and writes
 * down what they decided, which is auditable — unlike an override button,
 * which would quietly destroy the meaning of every check-in in the system.
 */
router.post('/attendance/incidents', idempotent(wrap(async (req, res) => {
  const f = parse(z.object({
    kind: z.enum(['check_in', 'check_out']),
    reason: z.enum(['permission_denied', 'gps_unavailable', 'poor_accuracy', 'outside_radius',
      'mock_location', 'network_unavailable', 'server_unavailable', 'duplicate_check_in', 'other']),
    note: z.string().trim().max(1000).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracy: z.number().positive().max(100000).optional(),
    distanceMetres: z.number().int().min(0).optional(),
  }).strict(), req.body);

  const out = await tx(req.user, async (c) => {
    const ins = await c.query(
      `INSERT INTO attendance_incidents
         (employee_id, kind, reason, note, reported_latitude, reported_longitude,
          reported_accuracy, distance_m)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (employee_id, work_date, kind) WHERE state = 'Open' DO NOTHING
       RETURNING *`,
      [req.user.id, f.kind, f.reason, f.note ?? null,
       f.latitude ?? null, f.longitude ?? null, f.accuracy ?? null, f.distanceMetres ?? null]);

    // Repeated taps must not queue up duplicates for the admin.
    if (!ins.rowCount) return null;

    const name = (await c.query(`SELECT name FROM employees WHERE employee_id=$1`, [req.user.id])).rows[0].name;
    await notifyAdmins(c, {
      kind: 'incident',
      body: `${name} could not ${f.kind === 'check_in' ? 'check in' : 'check out'}: ${f.reason.replace(/_/g, ' ')}.`,
      reqId: req.id,
    });
    return ins.rows[0];
  });

  if (!out) throw conflict('You have already reported this today. Your admin has it.', 'incident_exists');
  res.status(201).json(out);
})));

router.get('/attendance/incidents/me', wrap(async (req, res) => {
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT * FROM attendance_incidents WHERE employee_id=$1
      ORDER BY created_at DESC LIMIT 30`, [req.user.id]));
  res.json(rows);
}));

router.get('/admin/incidents', adminOnly, wrap(async (req, res) => {
  const state = ['Open', 'Resolved', 'Dismissed'].includes(req.query.state) ? req.query.state : 'Open';
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT i.*, e.name AS employee_name, e.role
       FROM attendance_incidents i JOIN employees e ON e.employee_id = i.employee_id
      WHERE i.state = $1::incident_state
      ORDER BY i.created_at DESC LIMIT 100`, [state]));
  res.json(rows);
}));

router.post('/admin/incidents/:id/resolve', uuidParam('id'), adminOnly, idempotent(wrap(async (req, res) => {
  const f = parse(z.object({
    decision: z.enum(['Resolved', 'Dismissed']),
    resolution: z.string().trim().min(1).max(1000),
  }).strict(), req.body);

  const out = await tx(req.user, async (c) => {
    const cur = (await c.query(
      `SELECT incident_id, employee_id, state FROM attendance_incidents
        WHERE incident_id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!cur) throw notFound('That report does not exist.');
    if (cur.state !== 'Open') throw conflict('That report was already handled.', 'already_handled');

    const row = (await c.query(
      `UPDATE attendance_incidents
          SET state=$2, resolution=$3, resolved_by=$4, resolved_at=now()
        WHERE incident_id=$1 RETURNING *`,
      [cur.incident_id, f.decision, f.resolution, req.user.id])).rows[0];

    await notify(c, {
      recipientId: cur.employee_id, kind: 'incident_resolved',
      body: `Your check-in report was reviewed: ${f.resolution}`, reqId: req.id,
    });
    return row;
  }, { reason: f.resolution });
  res.json(out);
})));

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
    await notify(c, { recipientId: f.assignedTo, kind: 'task_assigned',
      body: `New task ${t.task_code}: ${t.title}`, taskId: t.task_id, reqId: req.id });
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

router.post('/tasks/:id/submit', uuidParam('id'), idempotent(wrap(async (req, res) => {
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
    await notifyAdmins(c, { kind: 'review',
      body: `${t.task_code} submitted for review.`, taskId: t.task_id, reqId: req.id });
    return s;
  });
  res.status(201).json(sub);
})));

router.post('/admin/submissions/:id/approve', uuidParam('id'), adminOnly, idempotent(wrap(async (req, res) => {
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
    await notify(c, { recipientId: s.employee_id, kind: 'approved',
      body: `Your work on ${s.task_code} was approved.`, taskId: s.task_id, reqId: req.id });
    return { taskId: s.task_id, status: 'Completed' };
  });
  res.json(out);
})));

router.post('/admin/submissions/:id/return', uuidParam('id'), adminOnly, idempotent(wrap(async (req, res) => {
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
    await notify(c, { recipientId: s.employee_id, kind: 'returned',
      body: `Work returned on ${s.task_code}: ${reason}`, taskId: s.task_id, reqId: req.id });
    return { taskId: s.task_id, status: 'Returned' };
  }, { reason });
  res.json(out);
})));

/* ───────────────────────────────────────────────────────────── claims */

const CAP_COLUMN = { Food: 'cap_food', Stay: 'cap_stay' };

router.post('/claims', idempotent(wrap(async (req, res) => {
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

    await notifyAdmins(c, { kind: 'claim',
      body: `A ${f.category.toLowerCase()} claim of ₹${f.amount} was submitted.`, reqId: req.id });
    return row;
  });
  res.status(201).json(claim);
})));

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

router.post('/admin/claims/:id/decide', uuidParam('id'), adminOnly, idempotent(wrap(async (req, res) => {
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
    await notify(c, { recipientId: cur.employee_id,
      kind: f.decision === 'Approved' ? 'approved' : 'returned',
      body: `Your claim of ₹${cur.amount_paise / 100} was ${f.decision.toLowerCase()}.`, reqId: req.id });
    return row;
  }, { reason: f.decision === 'Rejected' ? f.reason : `claim ${f.decision.toLowerCase()}` });
  res.json(out);
})));

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
