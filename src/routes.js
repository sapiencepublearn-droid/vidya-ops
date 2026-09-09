import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  config, pool, tx, ApiError, badRequest, forbidden, notFound, conflict,
  unprocessable, wrap, uuidParam, metresBetween, logger,
} from './core.js';
import { login, revoke, authenticate, adminOnly, hashPassword, assertPasswordPolicy,
  requestPasswordReset, completePasswordReset } from './auth.js';
import { putObject, getObject, deleteObject, sniff, safeName, storageKey, sha256, signDownload, verifyDownload } from './storage.js';
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
  expenseType: z.enum(['Local', 'Outstation']),
  category: z.enum(['Travel', 'Food', 'Stay', 'Others']),
  // Rupees in, paise stored. Integers only: floats and money do not mix.
  amount: z.number().positive().max(100000).multipleOf(0.01),
  attachmentId: uuid.optional(),
  place: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

const employeeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(['Trainer', 'Technical Support', 'Admin Support', 'Admin', 'Accountant', 'Content Writer', 'Designer', 'CEO']),
  email: z.string().email().max(160),
  phone: z.string().trim().max(30).optional(),
  password: z.string(),
  isAdmin: z.boolean().default(false),
  officeLocationId: uuid.optional(),
  claimsEnabled: z.boolean().default(false),
  capFood: z.number().int().min(0).max(100000).default(500),
  capStay: z.number().int().min(0).max(100000).default(1500),
}).strict();

const contributionSchema = z.object({
  workDate: isoDate,
  entryType: z.enum(['Contribution', 'Inconvenience']),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(3000),
}).strict();

const contributionReplySchema = z.object({
  message: z.string().trim().min(1).max(3000),
}).strict();

const employeeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(['Trainer', 'Technical Support', 'Admin Support', 'Admin', 'Accountant', 'Content Writer', 'Designer', 'CEO']),
  email: z.string().email().max(160),
  phone: z.string().trim().max(30).optional().nullable(),
  status: z.enum(['Active', 'Inactive']).default('Active'),
  claimsEnabled: z.boolean().default(false),
  capFood: z.number().int().min(0).max(100000).default(500),
  capStay: z.number().int().min(0).max(100000).default(1500),
  password: z.string().optional(),
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

function validateOpenFix(fix) {
  if (fix.isMocked) {
    throw unprocessable('This device is reporting a mock location. Turn off the mock location app and try again.', 'mock_location');
  }
  if (fix.accuracy > config.maxAccuracyMetres) {
    throw unprocessable(`The GPS reading is accurate to only ${Math.round(fix.accuracy)} m. Move outside and try again.`, 'poor_accuracy');
  }
  return fix;
}
// Trainers and Technical Support may punch from anywhere. Their GPS is still
// recorded as evidence, but low accuracy must not turn an anywhere punch into
// a geofence failure. School visit check-in/out continues to require accurate GPS.
function validateFieldFix(fix) {
  if (fix.isMocked) {
    throw unprocessable('This device is reporting a mock location. Turn off the mock location app and try again.', 'mock_location');
  }
  return fix;
}

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
      WHERE e.employee_id = $1 AND l.is_active AND l.latitude IS NOT NULL
      UNION
     SELECT l.location_id, l.kind, l.name, l.zone, l.latitude, l.longitude, l.radius_metres
       FROM trainer_assignments ta JOIN locations l ON l.location_id = ta.location_id
      WHERE ta.employee_id = $1 AND l.is_active AND ta.valid_from <= ist_today()
        AND (ta.valid_to IS NULL OR ta.valid_to >= ist_today())
        -- A school with no confirmed position cannot be matched: there is
        -- nothing to measure against. The punch is refused and the employee
        -- reports it, rather than being accepted on an unverified guess.
        AND l.latitude IS NOT NULL`, [actor.id]));
  return rows.map((r) => ({
    id: r.location_id, kind: r.kind, name: r.name, zone: r.zone,
    lat: Number(r.latitude), lng: Number(r.longitude), radius: r.radius_metres,
  }));
}

async function schoolVisitSites(actor, role) {
  if (role === 'Technical Support') {
    const { rows } = await tx(actor, (c) => c.query(
      `SELECT location_id, kind, name, zone, latitude, longitude, radius_metres
         FROM locations
        WHERE kind='school' AND is_active AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY zone, name`));
    return rows.map((r) => ({ id:r.location_id, kind:r.kind, name:r.name, zone:r.zone, lat:Number(r.latitude), lng:Number(r.longitude), radius:r.radius_metres }));
  }
  return (await permittedSites(actor)).filter((s) => s.kind === 'school');
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
  const emp = (await tx(req.user, (c) => c.query(
    `SELECT role, shift_start, late_grace_minutes FROM employees WHERE employee_id = $1`,
    [req.user.id]))).rows[0];
  const anywhere = emp.role === 'Trainer' || emp.role === 'Technical Support' || emp.role === 'Admin Support';
  const cleanFix = anywhere ? validateFieldFix(fix) : validateOpenFix(fix);
  const sites = anywhere ? [] : await permittedSites(req.user);
  const matched = anywhere ? { site: null, distance: null } : verifyFix(sites, cleanFix);
  const { site, distance } = matched;

  const result = await tx(req.user, async (c) => {

    const late = (await c.query(
      `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::time > ($1::time + make_interval(mins => $2)) AS late`,
      [emp.shift_start, emp.late_grace_minutes])).rows[0].late;

    const status = (emp.role === 'Trainer' || emp.role === 'Technical Support' || emp.role === 'Admin Support') ? 'Field Work' : late ? 'Late' : 'Present';

    // One employee may have several closed sessions on the same business day,
    // but never more than one active session. The partial unique index enforces
    // this at database level, so retries/concurrent taps cannot create two opens.
    const open = (await c.query(
      `SELECT attendance_id FROM attendance
        WHERE employee_id=$1 AND work_date=ist_today()
          AND check_in_time IS NOT NULL AND check_out_time IS NULL
        FOR UPDATE`, [req.user.id])).rows[0];
    if (open) return { conflict: true };

    const ins = await c.query(
      `INSERT INTO attendance (employee_id, work_date, check_in_time, check_in_latitude,
         check_in_longitude, check_in_accuracy, check_in_location_id, check_in_distance_m,
         check_in_device, status)
       VALUES ($1, ist_today(), now(), $2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [req.user.id, fix.latitude, fix.longitude, fix.accuracy, site?.id ?? null, distance,
       fix.device ?? {}, status]);

    if (!ins.rowCount) return { conflict: true };

    if (late) {
      const name = (await c.query(`SELECT name FROM employees WHERE employee_id=$1`, [req.user.id])).rows[0].name;
      await notifyAdmins(c, { kind: 'attendance', body: `${name} checked in late.`, reqId: req.id });
    }
    return ins.rows[0];
  });

  if (result?.conflict) throw conflict('You already have an active attendance session. End that session before punching in again.', 'already_checked_in');
  // The server reports what it matched. The client never chose it.
  res.status(201).json({
    attendance: result,
    locationType: site ? (site.kind === 'office' ? 'OFFICE' : 'SCHOOL') : 'ANYWHERE',
    location: site?.name ?? 'Field / Any location', zone: site?.zone ?? null,
    site: site?.name ?? null, distanceMetres: distance,
  });
})));

router.post('/attendance/check-out', idempotent(wrap(async (req, res) => {
  const fix = parse(fixSchema, req.body);
  const emp = (await tx(req.user, (c) => c.query(
    `SELECT role FROM employees WHERE employee_id = $1`, [req.user.id]))).rows[0];
  const anywhere = emp.role === 'Trainer' || emp.role === 'Technical Support' || emp.role === 'Admin Support';
  const cleanFix = anywhere ? validateFieldFix(fix) : validateOpenFix(fix);
  const sites = anywhere ? [] : await permittedSites(req.user);
  const matched = anywhere ? { site: null, distance: null } : verifyFix(sites, cleanFix);
  const { site, distance } = matched;

  const row = await tx(req.user, async (c) => {
    if (emp.role === 'Trainer' || emp.role === 'Technical Support') {
      const openVisit = (await c.query(
        `SELECT visit_id FROM school_visits WHERE employee_id=$1 AND work_date=ist_today() AND check_in_time IS NOT NULL AND check_out_time IS NULL LIMIT 1`,
        [req.user.id])).rows[0];
      if (openVisit) throw conflict('Please check out from the school visit before punching out.', 'school_visit_open');
    }
    const cur = (await c.query(
      `SELECT attendance_id, check_in_time, check_out_time FROM attendance
        WHERE employee_id = $1 AND work_date = ist_today()
          AND check_in_time IS NOT NULL AND check_out_time IS NULL
        ORDER BY check_in_time DESC LIMIT 1 FOR UPDATE`, [req.user.id])).rows[0];
    if (!cur?.check_in_time) throw conflict('You have not checked in today.', 'not_checked_in');
    if (cur.check_out_time) throw conflict('You have already checked out today.', 'already_checked_out');

    return (await c.query(
      `UPDATE attendance SET check_out_time = now(), check_out_latitude=$2, check_out_longitude=$3,
              check_out_accuracy=$4, check_out_location_id=$5, check_out_distance_m=$6, check_out_device=$7
        WHERE attendance_id = $1 RETURNING *`,
      [cur.attendance_id, fix.latitude, fix.longitude, fix.accuracy, site?.id ?? null, distance, fix.device ?? {}])).rows[0];
  });
  // A school visit gets a draft the employee can review and send. Office
  // attendance does not: there is no group expecting an update.
  const visit = row.check_in_location_id
    ? (await pool.query(`SELECT kind, name, zone FROM locations WHERE location_id = $1`,
        [row.check_in_location_id])).rows[0]
    : null;

  res.json({
    attendance: row,
    locationType: site ? (site.kind === 'office' ? 'OFFICE' : 'SCHOOL') : 'ANYWHERE',
    location: site?.name ?? 'Field / Any location', zone: site?.zone ?? null,
    site: site?.name ?? null, distanceMetres: distance,
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

router.get('/attendance/school-visits/today', wrap(async (req, res) => {
  const emp = (await tx(req.user, (c) => c.query(
    `SELECT role FROM employees WHERE employee_id=$1`, [req.user.id]))).rows[0];
  if (emp.role !== 'Trainer' && emp.role !== 'Technical Support') return res.json({ schools: [], active: null, visits: [] });

  const sites = await schoolVisitSites(req.user, emp.role);
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT v.*, l.name AS school_name, l.zone AS school_zone
       FROM school_visits v JOIN locations l ON l.location_id=v.location_id
      WHERE v.employee_id=$1 AND v.work_date=ist_today()
      ORDER BY v.check_in_time DESC`, [req.user.id]));
  res.json({
    schools: sites.map((s) => ({ id: s.id, name: s.name, zone: s.zone, lat: s.lat, lng: s.lng, radius: s.radius })),
    active: rows.find((v) => v.check_in_time && !v.check_out_time) || null,
    visits: rows,
  });
}));

router.post('/attendance/school-visits/check-in', idempotent(wrap(async (req, res) => {
  const f = parse(fixSchema.extend({ locationId: uuid }).strict(), req.body);
  const emp = (await tx(req.user, (c) => c.query(`SELECT role FROM employees WHERE employee_id=$1`, [req.user.id]))).rows[0];
  if (emp.role !== 'Trainer' && emp.role !== 'Technical Support') throw forbidden('School visits are available only to trainers and technical support.');
  const sites = await schoolVisitSites(req.user, emp.role);
  const site = sites.find((s) => s.id === f.locationId);
  if (!site) throw forbidden(emp.role === 'Technical Support' ? 'That school is not available for a school visit.' : 'That school is not assigned to you today.', 'school_not_available');
  const { distance } = verifyFix([site], f);
  const row = await tx(req.user, async (c) => {
    const activeAttendance = (await c.query(
      `SELECT attendance_id FROM attendance
        WHERE employee_id=$1 AND work_date=ist_today()
          AND check_in_time IS NOT NULL AND check_out_time IS NULL
        LIMIT 1 FOR UPDATE`, [req.user.id])).rows[0];
    if (!activeAttendance) throw conflict('Please Punch In before starting a school visit.', 'not_checked_in');
    const open = (await c.query(
      `SELECT visit_id FROM school_visits WHERE employee_id=$1 AND work_date=ist_today() AND check_in_time IS NOT NULL AND check_out_time IS NULL LIMIT 1`,
      [req.user.id])).rows[0];
    if (open) throw conflict('You already have a school visit in progress.', 'school_visit_open');
    return (await c.query(
      `INSERT INTO school_visits (employee_id, work_date, location_id, check_in_time, check_in_latitude, check_in_longitude, check_in_accuracy, check_in_distance_m)
       VALUES ($1, ist_today(), $2, now(), $3,$4,$5,$6) RETURNING *`,
      [req.user.id, site.id, f.latitude, f.longitude, f.accuracy, distance])).rows[0];
  });
  res.status(201).json({ visit: row, school: site.name, zone: site.zone, distanceMetres: distance });
})));

router.post('/attendance/school-visits/check-out', idempotent(wrap(async (req, res) => {
  const f = parse(fixSchema.extend({ visitId: uuid }).strict(), req.body);
  const emp = (await tx(req.user, (c) => c.query(`SELECT role FROM employees WHERE employee_id=$1`, [req.user.id]))).rows[0];
  if (emp.role !== 'Trainer' && emp.role !== 'Technical Support') throw forbidden('School visits are available only to trainers and technical support.');
  const clean = validateOpenFix(f);
  const row = await tx(req.user, async (c) => {
    const cur = (await c.query(
      `SELECT v.*, l.name AS school_name, l.zone AS school_zone, l.latitude, l.longitude, l.radius_metres
         FROM school_visits v JOIN locations l ON l.location_id=v.location_id
        WHERE v.visit_id=$1 AND v.employee_id=$2 FOR UPDATE`, [f.visitId, req.user.id])).rows[0];
    if (!cur) throw notFound('School visit not found.');
    if (cur.check_out_time) throw conflict('This school visit is already checked out.', 'already_checked_out');
    const distance = metresBetween({ lat: clean.latitude, lng: clean.longitude }, { lat: Number(cur.latitude), lng: Number(cur.longitude) });
    if (distance > cur.radius_metres) throw unprocessable(`You are ${distance} m from ${cur.school_name}. Check-out is allowed within ${cur.radius_metres} m.`, 'outside_radius');
    return (await c.query(
      `UPDATE school_visits SET check_out_time=now(), check_out_latitude=$2, check_out_longitude=$3, check_out_accuracy=$4, check_out_distance_m=$5 WHERE visit_id=$1 RETURNING *`,
      [f.visitId, clean.latitude, clean.longitude, clean.accuracy, distance])).rows[0];
  });
  res.json({ visit: row });
})));

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
            a.work_date,
            a.first_in AS check_in_time,
            a.last_out AS check_out_time,
            a.first_accuracy AS check_in_accuracy,
            a.session_count AS attendance_sessions,
            a.open_sessions,
            a.site_name, a.site_zone, a.location_type,
            a.status
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT x.work_date,
                MIN(x.check_in_time) AS first_in,
                MAX(x.check_out_time) FILTER (WHERE x.check_in_time = (SELECT MAX(z.check_in_time) FROM attendance z WHERE z.employee_id=e.employee_id AND z.work_date=COALESCE($1::date, ist_today()))) AS last_out,
                MAX(x.check_in_accuracy) FILTER (WHERE x.check_in_time = (SELECT MIN(z.check_in_time) FROM attendance z WHERE z.employee_id=e.employee_id AND z.work_date=COALESCE($1::date, ist_today()))) AS first_accuracy,
                COUNT(*)::int AS session_count,
                COUNT(*) FILTER (WHERE x.check_out_time IS NULL AND x.check_in_time IS NOT NULL)::int AS open_sessions,
                (SELECT l.name FROM attendance z LEFT JOIN locations l ON l.location_id=z.check_in_location_id
                  WHERE z.employee_id=e.employee_id AND z.work_date=COALESCE($1::date, ist_today())
                  ORDER BY z.check_in_time ASC LIMIT 1) AS site_name,
                (SELECT l.zone FROM attendance z LEFT JOIN locations l ON l.location_id=z.check_in_location_id
                  WHERE z.employee_id=e.employee_id AND z.work_date=COALESCE($1::date, ist_today())
                  ORDER BY z.check_in_time ASC LIMIT 1) AS site_zone,
                (SELECT CASE WHEN l.kind='office' THEN 'OFFICE' WHEN l.kind='school' THEN 'SCHOOL' ELSE 'ANYWHERE' END
                   FROM attendance z LEFT JOIN locations l ON l.location_id=z.check_in_location_id
                  WHERE z.employee_id=e.employee_id AND z.work_date=COALESCE($1::date, ist_today())
                  ORDER BY z.check_in_time ASC LIMIT 1) AS location_type,
                (SELECT z.status FROM attendance z
                  WHERE z.employee_id=e.employee_id AND z.work_date=COALESCE($1::date, ist_today())
                  ORDER BY z.check_in_time DESC LIMIT 1) AS status
           FROM attendance x
          WHERE x.employee_id=e.employee_id AND x.work_date=COALESCE($1::date, ist_today())
          GROUP BY x.work_date
       ) a ON true
      WHERE e.status='Active'
      ORDER BY e.name LIMIT $2 OFFSET $3`, [date, limit, offset]));
  res.json(rows);
}));

/* ───────────────────────────────────────────────────── school directory */

// Base shape, kept unrefined so the edit endpoint can call .partial() on
// it. Zod refuses .partial() on a schema carrying refinements.
const schoolFields = z.object({
  name: z.string().trim().min(1).max(120),
  zone: z.string().trim().max(80).nullable().optional(),
  address: z.string().trim().max(400).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  contactDesignation: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(30).optional(),
  // Optional: a school is usually known long before anyone has stood at
  // the gate to record its position.
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  radiusMetres: z.number().int().min(20).max(2000).default(100),
  isActive: z.boolean().default(true),
}).strict();

// Half a coordinate would look set and match nothing, so it is both or
// neither. Applied to create and edit alike.
const bothOrNeither = (v) =>
  (v.latitude === undefined || v.latitude === null) === (v.longitude === undefined || v.longitude === null);
const coordMessage = { message: 'Give both latitude and longitude, or neither.', path: ['latitude'] };

const schoolSchema = schoolFields.refine(bothOrNeither, coordMessage);
const schoolPatchSchema = schoolFields.partial().refine(bothOrNeither, coordMessage);

/** Employees may read the directory; only admins may change it. */
router.get('/schools', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const q = (req.query.q || '').trim();
  const { rows } = await pool.query(
    `SELECT location_id, name, zone, address, contact_person, contact_designation, contact_phone,
            latitude, longitude, radius_metres, is_active
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
    `SELECT location_id, name, zone, address, contact_person, contact_designation, contact_phone,
            latitude, longitude, radius_metres, is_active, location_set_at, created_at, updated_at,
            school_history
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

const schoolHistorySchema = z.object({
  location: z.string().trim().max(200).optional().nullable(),
  vintage: z.string().trim().max(120).optional().nullable(),
  books: z.string().trim().max(120).optional().nullable(),
  category: z.string().trim().max(120).optional().nullable(),
  contacts: z.object({
    correspondent: z.string().trim().max(160).optional().nullable(),
    correspondentPhone: z.string().trim().max(40).optional().nullable(),
    principal: z.string().trim().max(160).optional().nullable(),
    principalPhone: z.string().trim().max(40).optional().nullable(),
    keyPerson: z.string().trim().max(160).optional().nullable(),
    keyPersonPhone: z.string().trim().max(40).optional().nullable(),
  }).default({}),
  booksPayment: z.object({
    lkg: z.string().trim().max(120).optional().nullable(),
    lkgHhp: z.string().trim().max(120).optional().nullable(),
    ukgHhp: z.string().trim().max(120).optional().nullable(),
    deliveryDate: z.string().trim().max(40).optional().nullable(),
    pyCredit: z.string().trim().max(120).optional().nullable(),
    spInvoiceValueMo: z.string().trim().max(120).optional().nullable(),
    total2526: z.string().trim().max(120).optional().nullable(),
    lkgAdditionalOrders: z.string().trim().max(120).optional().nullable(),
    lkgReturns: z.string().trim().max(120).optional().nullable(),
    lkgRemarks: z.string().trim().max(500).optional().nullable(),
    ukg: z.string().trim().max(120).optional().nullable(),
    ukgAdditionalOrders: z.string().trim().max(120).optional().nullable(),
    ukgReturns: z.string().trim().max(120).optional().nullable(),
    ukgRemarks: z.string().trim().max(500).optional().nullable(),
    discount: z.string().trim().max(120).optional().nullable(),
    discountAdditionalOrders: z.string().trim().max(120).optional().nullable(),
    discountReturns: z.string().trim().max(120).optional().nullable(),
    discountRemarks: z.string().trim().max(500).optional().nullable(),
    spInvoiceValue2526: z.string().trim().max(120).optional().nullable(),
    spInvoiceValueAdditionalOrders: z.string().trim().max(120).optional().nullable(),
    amountReceived: z.string().trim().max(120).optional().nullable(),
    amountReceivedDate: z.string().trim().max(40).optional().nullable(),
    amountPending: z.string().trim().max(120).optional().nullable(),
    status: z.string().trim().max(120).optional().nullable(),
    remarks: z.string().trim().max(500).optional().nullable(),
  }).default({}),
  deliverables1: z.object({
    teachersCopy: z.string().trim().max(120).optional().nullable(),
    teachersManual1: z.string().trim().max(120).optional().nullable(),
    teachersManual2: z.string().trim().max(120).optional().nullable(),
    flashCards: z.string().trim().max(120).optional().nullable(),
    teachersCopyDate: z.string().trim().max(40).optional().nullable(),
    teachersManual1Date: z.string().trim().max(40).optional().nullable(),
    teachersManual2Date: z.string().trim().max(40).optional().nullable(),
    flashCardsDate: z.string().trim().max(40).optional().nullable(),
  }).default({}),
  deliverables2: z.object({
    whatsapp: z.string().trim().max(120).optional().nullable(),
    whatsappDate: z.string().trim().max(40).optional().nullable(),
    windowsApp: z.object({ appVersion: z.string().trim().max(120).optional().nullable(), date: z.string().trim().max(40).optional().nullable(), lkg: z.string().trim().max(120).optional().nullable(), ukg: z.string().trim().max(120).optional().nullable(), systemTvBoth: z.string().trim().max(120).optional().nullable() }).default({}),
    kidsApp: z.object({ appVersion: z.string().trim().max(120).optional().nullable(), date: z.string().trim().max(40).optional().nullable(), lkg: z.string().trim().max(120).optional().nullable(), ukg: z.string().trim().max(120).optional().nullable(), systemTvBoth: z.string().trim().max(120).optional().nullable() }).default({}),
    appComments: z.string().trim().max(1000).optional().nullable(),
  }).default({}),
  deliverables3: z.object({
    questionPaper: z.string().trim().max(120).optional().nullable(),
    progressCard: z.string().trim().max(120).optional().nullable(),
    questionPaperDate: z.string().trim().max(40).optional().nullable(),
    progressCardDate: z.string().trim().max(40).optional().nullable(),
  }).default({}),
  services: z.object({
    t1: z.string().trim().max(120).optional().nullable(),
    atu1: z.string().trim().max(120).optional().nullable(),
    atu1Date: z.string().trim().max(40).optional().nullable(),
    atu1Comments: z.string().trim().max(1000).optional().nullable(),
    sim1: z.string().trim().max(120).optional().nullable(),
    sim1Date: z.string().trim().max(40).optional().nullable(),
    sim1Comments: z.string().trim().max(1000).optional().nullable(),
    t2: z.string().trim().max(120).optional().nullable(),
    generalVisit: z.string().trim().max(120).optional().nullable(),
    atu2: z.string().trim().max(120).optional().nullable(),
    atu2Date: z.string().trim().max(40).optional().nullable(),
    atu2Comments: z.string().trim().max(1000).optional().nullable(),
    sim2: z.string().trim().max(120).optional().nullable(),
    sim2Date: z.string().trim().max(40).optional().nullable(),
    sim2Comments: z.string().trim().max(1000).optional().nullable(),
    t3: z.string().trim().max(120).optional().nullable(),
    sim3: z.string().trim().max(120).optional().nullable(),
    sim3Date: z.string().trim().max(40).optional().nullable(),
    sim3Comments: z.string().trim().max(1000).optional().nullable(),
  }).default({}),
  currentStatus: z.string().trim().max(300).optional().nullable(),
  comments: z.string().trim().max(2000).optional().nullable(),
}).strict();

router.put('/admin/schools/:id/history', adminOnly, uuidParam('id'), idempotent(wrap(async (req, res) => {
  const f = parse(schoolHistorySchema, req.body);
  const row = (await pool.query(
    `UPDATE locations SET school_history=$2, updated_at=now() WHERE location_id=$1 AND kind='school' RETURNING location_id, school_history`,
    [req.params.id, JSON.stringify(f)])).rows[0];
  if (!row) throw notFound('That school does not exist.');
  res.json(row);
})));


const googleMapsResolveSchema = z.object({
  url: z.string().trim().url().max(2000),
}).strict();

function extractGoogleMapsCoordinates(text) {
  const value = String(text || '');
  // IMPORTANT: Google Maps' /@lat,lng/ is often only the viewport centre.
  // Never use it as the school's saved position. Prefer the place's !3d/!4d
  // coordinates, then explicit query/destination coordinates.
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i,
    /[?&](?:q|query|ll|destination)=\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i,
    /\/place\/\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = value.match(re);
    if (!m) continue;
    const latitude = Number(m[1]);
    const longitude = Number(m[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      return { latitude, longitude };
    }
  }
  return null;
}

router.post('/admin/schools/resolve-google-maps', adminOnly, wrap(async (req, res) => {
  const { url } = parse(googleMapsResolveSchema, req.body);
  let parsed;
  try { parsed = new URL(url); } catch { throw badRequest('Enter a valid Google Maps link.', 'invalid_maps_url'); }
  const host = parsed.hostname.toLowerCase();
  const allowed = host === 'maps.app.goo.gl' || host === 'goo.gl'
    || host === 'google.com' || host === 'www.google.com' || host === 'maps.google.com';
  if (!allowed) throw badRequest('Only Google Maps links are supported.', 'invalid_maps_host');

  const direct = extractGoogleMapsCoordinates(url);
  if (direct) return res.json({ ...direct, resolvedUrl: url });

  let response;
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Sapience-Team/1.0' } });
  } catch {
    throw badRequest('Could not resolve that Google Maps link. Enter latitude and longitude manually.', 'maps_resolve_failed');
  }
  const resolvedUrl = response.url || url;
  const fromUrl = extractGoogleMapsCoordinates(resolvedUrl);
  if (fromUrl) return res.json({ ...fromUrl, resolvedUrl });

  let html = '';
  try { html = await response.text(); } catch { /* final URL is enough when available */ }
  const fromHtml = extractGoogleMapsCoordinates(html);
  if (fromHtml) return res.json({ ...fromHtml, resolvedUrl });

  throw badRequest('No coordinates were found in that Google Maps link. Enter latitude and longitude manually.', 'maps_coordinates_not_found');
}));

router.post('/admin/schools', adminOnly, idempotent(wrap(async (req, res) => {
  const f = parse(schoolSchema, req.body);
  const out = await tx(req.user, async (c) => {
    try {
      const hasCoords = f.latitude !== undefined && f.latitude !== null;
      return (await c.query(
        `INSERT INTO locations (kind, name, zone, address, contact_person, contact_designation,
            contact_phone, latitude, longitude, radius_metres, is_active, location_set_by, location_set_at)
         VALUES ('school',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [f.name, f.zone, f.address ?? null, f.contactPerson ?? null, f.contactDesignation ?? null,
         f.contactPhone ?? null, f.latitude ?? null, f.longitude ?? null, f.radiusMetres, f.isActive,
         hasCoords ? req.user.id : null, hasCoords ? new Date() : null])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('A school with that name already exists.', 'school_exists');
      throw e;
    }
  }, { reason: 'school created' });
  res.status(201).json(out);
})));

router.patch('/admin/schools/:id', uuidParam('id'), adminOnly, idempotent(wrap(async (req, res) => {
  const f = parse(schoolPatchSchema, req.body);
  if (!Object.keys(f).length) throw badRequest('Nothing to change.');

  const out = await tx(req.user, async (c) => {
    const cur = (await c.query(
      `SELECT * FROM locations WHERE location_id=$1 AND kind='school' FOR UPDATE`, [req.params.id])).rows[0];
    if (!cur) throw notFound('That school does not exist.');
    // Deactivating never deletes: historical attendance still points here.
    // Setting a position for the first time is recorded against the admin
    // who did it, so a coordinate is always traceable to a person.
    const settingCoords = f.latitude !== undefined && f.latitude !== null && cur.latitude === null;
    return (await c.query(
      `UPDATE locations SET name=$2, zone=$3, address=$4, contact_person=$5,
              contact_designation=$6, contact_phone=$7, latitude=$8, longitude=$9,
              radius_metres=$10, is_active=$11,
              location_set_by = COALESCE($12, location_set_by),
              location_set_at = COALESCE($13, location_set_at)
        WHERE location_id=$1 RETURNING *`,
      [req.params.id,
       f.name ?? cur.name, f.zone ?? cur.zone,
       f.address === undefined ? cur.address : f.address,
       f.contactPerson === undefined ? cur.contact_person : f.contactPerson,
       f.contactDesignation === undefined ? cur.contact_designation : f.contactDesignation,
       f.contactPhone === undefined ? cur.contact_phone : f.contactPhone,
       f.latitude === undefined ? cur.latitude : f.latitude,
       f.longitude === undefined ? cur.longitude : f.longitude,
       f.radiusMetres ?? cur.radius_metres,
       f.isActive === undefined ? cur.is_active : f.isActive,
       settingCoords ? req.user.id : null, settingCoords ? new Date() : null])).rows[0];
  }, { reason: f.isActive === false ? 'school deactivated' : 'school updated' });
  res.json(out);
})));

router.delete('/admin/schools/:id', uuidParam('id'), adminOnly, idempotent(wrap(async (req, res) => {
  const out = await tx(req.user, async (c) => {
    const cur = (await c.query(
      `SELECT location_id, name, kind, is_active FROM locations WHERE location_id=$1 AND kind='school' FOR UPDATE`,
      [req.params.id])).rows[0];
    if (!cur) throw notFound('That school does not exist.');

    // A school may be permanently removed only when no operational/history
    // record points to it. The imported School History JSON is safe to remove
    // with the school; attendance, visits and assignments are not.
    const refs = (await c.query(
      `SELECT
         (SELECT count(*)::int FROM attendance WHERE check_in_location_id=$1 OR check_out_location_id=$1) AS attendance_refs,
         (SELECT count(*)::int FROM school_visits WHERE location_id=$1) AS visit_refs,
         (SELECT count(*)::int FROM trainer_assignments WHERE location_id=$1) AS assignment_refs`,
      [req.params.id])).rows[0];
    if (refs.attendance_refs || refs.visit_refs || refs.assignment_refs) {
      throw conflict('This school has attendance, visit, or assignment records. Mark it Inactive instead of deleting it.', 'school_has_history');
    }

    await c.query(`DELETE FROM locations WHERE location_id=$1 AND kind='school'`, [req.params.id]);
    return cur;
  }, { reason: 'school permanently deleted' });
  res.json({ deleted: true, school: out });
})));

/**
 * Adopts a position recorded during a failed punch as the school's
 * permanent location.
 *
 * This exists because a trainer standing at the gate is the person best
 * placed to say where the gate is. But their reading is evidence, not
 * authority: it becomes the school's coordinate only when an admin looks
 * at it and says yes. `confirm: true` is required, the decision is
 * audited, and the accepting admin is recorded on the row.
 *
 * The attendance or incident record is never altered by this.
 */
router.post('/admin/schools/:id/location-from-incident', uuidParam('id'), adminOnly,
  idempotent(wrap(async (req, res) => {
    const f = parse(z.object({
      incidentId: uuid,
      confirm: z.literal(true, {
        errorMap: () => ({ message: 'Confirm that this position is correct for the school.' }),
      }),
      radiusMetres: z.number().int().min(20).max(2000).optional(),
    }).strict(), req.body);

    const out = await tx(req.user, async (c) => {
      const school = (await c.query(
        `SELECT location_id, name, latitude FROM locations
          WHERE location_id=$1 AND kind='school' FOR UPDATE`, [req.params.id])).rows[0];
      if (!school) throw notFound('That school does not exist.');

      const inc = (await c.query(
        `SELECT incident_id, reported_latitude, reported_longitude, reported_accuracy
           FROM attendance_incidents WHERE incident_id=$1`, [f.incidentId])).rows[0];
      if (!inc) throw notFound('That report does not exist.');
      if (inc.reported_latitude === null || inc.reported_longitude === null) {
        throw unprocessable('That report has no recorded position.', 'no_position');
      }

      const updated = (await c.query(
        `UPDATE locations SET latitude=$2, longitude=$3,
                radius_metres = COALESCE($4, radius_metres),
                location_set_by=$5, location_set_at=now()
          WHERE location_id=$1 RETURNING *`,
        [school.location_id, inc.reported_latitude, inc.reported_longitude,
         f.radiusMetres ?? null, req.user.id])).rows[0];

      return { ...updated, previouslyUnset: school.latitude === null };
    }, { reason: `school location confirmed from report ${f.incidentId}` });

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

async function recordTaskDailyLog(c, employeeId, todayTasks, selectedTaskIds) {
  const selected = new Set(selectedTaskIds);
  const values = todayTasks.map((t) => ({
    taskId: t.task_id,
    outcome: t.status === 'Completed' || selected.has(t.task_id) ? 'Completed' : 'Pending',
  }));
  for (const v of values) {
    await c.query(
      `INSERT INTO task_daily_log (task_id, employee_id, work_date, outcome)
       VALUES ($1,$2,ist_today(),$3)
       ON CONFLICT (task_id, work_date)
       DO UPDATE SET outcome=EXCLUDED.outcome, recorded_at=now()`,
      [v.taskId, employeeId, v.outcome]);
  }
}

router.get('/tasks/me', wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const views = {
    today: `t.due_date <= ist_today()`,
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


/**
 * End-of-day is one atomic action: the employee selects completed work and
 * punches out in the same database transaction. If GPS validation or the
 * punch-out fails, no task is completed or carried forward.
 */
router.post('/attendance/end-day', idempotent(wrap(async (req, res) => {
  const f = parse(fixSchema.extend({ completedTaskIds: z.array(uuid).max(100).default([]) }).strict(), req.body);
  const emp = (await tx(req.user, (c) => c.query(
    `SELECT role FROM employees WHERE employee_id=$1`, [req.user.id]))).rows[0];
  if (!emp) throw notFound('Your employee account does not exist.');

  const anywhere = emp.role === 'Trainer' || emp.role === 'Technical Support' || emp.role === 'Admin Support';
  const cleanFix = anywhere ? validateFieldFix(f) : validateOpenFix(f);
  const sites = anywhere ? [] : await permittedSites(req.user);
  const matched = anywhere ? { site: null, distance: null } : verifyFix(sites, cleanFix);
  const { site, distance } = matched;

  const out = await tx(req.user, async (c) => {
    if (emp.role === 'Trainer' || emp.role === 'Technical Support') {
      const openVisit = (await c.query(
        `SELECT visit_id FROM school_visits
          WHERE employee_id=$1 AND work_date=ist_today()
            AND check_in_time IS NOT NULL AND check_out_time IS NULL
          LIMIT 1`, [req.user.id])).rows[0];
      if (openVisit) throw conflict('Please check out from the school visit before ending your day.', 'school_visit_open');
    }

    const attendance = (await c.query(
      `SELECT attendance_id, check_in_time, check_out_time
         FROM attendance
        WHERE employee_id=$1 AND work_date=ist_today()
          AND check_in_time IS NOT NULL AND check_out_time IS NULL
        ORDER BY check_in_time DESC LIMIT 1
        FOR UPDATE`, [req.user.id])).rows[0];
    if (!attendance?.check_in_time) throw conflict('You do not have an active attendance session. Punch In first.', 'not_checked_in');

    const todayTasks = (await c.query(
      `SELECT task_id, status
         FROM tasks
        WHERE assigned_to=$1 AND due_date <= ist_today() AND deleted_at IS NULL
        ORDER BY due_date, due_time, created_at`, [req.user.id])).rows;
    const allowed = new Set(todayTasks.map((t) => t.task_id));
    const selected = f.completedTaskIds.filter((id) => allowed.has(id));
    if (selected.length) {
      await c.query(
        `UPDATE tasks
            SET status='Completed', completed_at=COALESCE(completed_at, now()), updated_at=now()
          WHERE task_id = ANY($1::uuid[]) AND assigned_to=$2
            AND due_date <= ist_today() AND deleted_at IS NULL`,
        [selected, req.user.id]);
    }

    await recordTaskDailyLog(c, req.user.id, todayTasks, selected);
    const pending = todayTasks.filter((t) => t.status !== 'Completed' && !selected.includes(t.task_id));
    // Pending work stays on the business day when a session closes. This is
    // important because another work session can start later the same night.
    // The next day's task view includes still-open work (due_date <= today),
    // so unfinished work carries forward without creating duplicate tasks.


    const row = (await c.query(
      `UPDATE attendance
          SET check_out_time=now(), check_out_latitude=$2, check_out_longitude=$3,
              check_out_accuracy=$4, check_out_location_id=$5, check_out_distance_m=$6, check_out_device=$7
        WHERE attendance_id=$1
        RETURNING *`,
      [attendance.attendance_id, f.latitude, f.longitude, f.accuracy, site?.id ?? null, distance, f.device ?? {}])).rows[0];

    return {
      attendance: row,
      completedTaskIds: selected,
      pendingTaskIds: pending.map((t) => t.task_id),
      locationType: site ? (site.kind === 'office' ? 'OFFICE' : 'SCHOOL') : 'ANYWHERE',
      location: site?.name ?? 'Field / Any location',
      zone: site?.zone ?? null,
      distanceMetres: distance,
    };
  });

  res.json(out);
})));

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



/* ───────────────────────────────────────────── daily work done */
router.get('/work-done/me', wrap(async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT work_done_id, work_date, summary, created_at, updated_at
       FROM employee_work_done
      WHERE employee_id=$1
        AND ($2::date IS NULL OR work_date >= $2::date)
        AND ($3::date IS NULL OR work_date <= $3::date)
      ORDER BY work_date DESC`, [req.user.id, from, to]));
  res.json(rows);
}));

router.put('/work-done/me', idempotent(wrap(async (req, res) => {
  const f = parse(z.object({
    workDate: isoDate,
    summary: z.string().trim().min(1).max(5000),
  }).strict(), req.body);
  const today = (await pool.query(`SELECT ist_today() AS d`)).rows[0].d;
  if (f.workDate > today.toISOString().slice(0, 10)) {
    throw unprocessable('You cannot record Work Done for a future date.', 'future_date');
  }
  const row = await tx(req.user, (c) => c.query(
    `INSERT INTO employee_work_done (employee_id, work_date, summary)
     VALUES ($1,$2,$3)
     ON CONFLICT (employee_id, work_date)
     DO UPDATE SET summary=EXCLUDED.summary, updated_at=now()
     RETURNING *`, [req.user.id, f.workDate, f.summary])).then((r) => r.rows[0]);
  res.json(row);
})));

router.get('/admin/tasks', adminOnly, wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  if (!date) throw unprocessable('Choose a valid date.', 'invalid_date');
  const { rows } = await pool.query(
    `SELECT t.task_id, t.task_code, t.title, t.description, t.priority, t.due_date, t.due_time,
            t.status, t.started_at, t.submitted_at, t.completed_at,
            e.employee_id, e.name AS employee_name, e.employee_code,
            a.name AS assigner_name
       FROM tasks t
       JOIN employees e ON e.employee_id=t.assigned_to
       JOIN employees a ON a.employee_id=t.assigned_by
      WHERE t.due_date=$1 AND t.deleted_at IS NULL
      ORDER BY e.name, t.due_time, t.created_at`, [date]);
  res.json(rows);
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

// Claims run in Saturday → Friday cycles. Sunday is a holiday; if a trainer
// works on Sunday, that claim belongs to the following Saturday's cycle.
const claimCycleStart = (isoDate) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const dow = d.getUTCDay(); // Sunday=0 ... Saturday=6
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 6);
  else d.setUTCDate(d.getUTCDate() - ((dow + 1) % 7));
  return d.toISOString().slice(0, 10);
};


router.post('/contributions', idempotent(wrap(async (req, res) => {
  const f = parse(contributionSchema, req.body);
  const today = (await pool.query(`SELECT ist_today() AS d`)).rows[0].d;
  if (f.workDate > today.toISOString().slice(0, 10)) {
    throw unprocessable('You cannot submit a future date.', 'future_date');
  }
  const row = await tx(req.user, async (c) => {
    const out = (await c.query(
      `INSERT INTO employee_contributions
         (employee_id, work_date, entry_type, title, description)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [req.user.id, f.workDate, f.entryType, f.title, f.description])).rows[0];
    await notifyAdmins(c, {
      kind: 'contribution',
      body: `${req.user.name || 'An employee'} submitted ${f.entryType.toLowerCase()}: ${f.title}`,
      reqId: req.id,
    });
    return out;
  });
  res.status(201).json(row);
})));

router.get('/contributions/me', wrap(async (req, res) => {
  const { rows } = await tx(req.user, async (c) => {
    const items = (await c.query(
      `SELECT contribution_id, work_date, entry_type, title, description, status, created_at
         FROM employee_contributions
        WHERE employee_id=$1
        ORDER BY work_date DESC, created_at DESC`, [req.user.id])).rows;
    const replies = items.length ? (await c.query(
      `SELECT r.reply_id, r.contribution_id, r.message, r.created_at, e.name AS author_name
         FROM contribution_replies r
         JOIN employees e ON e.employee_id=r.employee_id
        WHERE r.contribution_id = ANY($1::uuid[])
        ORDER BY r.created_at ASC`, [items.map((x) => x.contribution_id)])).rows : [];
    return { rows: [{ items, replies }] };
  });
  res.json(rows[0]);
}));

router.post('/claims', idempotent(wrap(async (req, res) => {
  const f = parse(claimSchema, req.body);
  const paise = Math.round(f.amount * 100);

  const claim = await tx(req.user, async (c) => {
    const emp = (await c.query(
      `SELECT claims_enabled, cap_food, cap_stay FROM employees WHERE employee_id=$1`, [req.user.id])).rows[0];
    if (!emp.claims_enabled) throw forbidden('Reimbursement is not enabled on your account.');

    const cycleStart = claimCycleStart(f.date);
    const cycle = (await c.query(
      `SELECT status FROM claim_cycles WHERE cycle_start=$1 FOR SHARE`, [cycleStart])).rows[0];
    if (cycle?.status === 'Closed') {
      throw conflict('That weekly claim cycle is already closed. Corrections must use the audit correction process.', 'claim_cycle_closed');
    }

    await c.query(
      `INSERT INTO claim_cycles (cycle_start) VALUES ($1) ON CONFLICT (cycle_start) DO NOTHING`, [cycleStart]);

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
      `INSERT INTO claims (employee_id, claim_date, claim_cycle_start, expense_type, category, amount_paise, place, location, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id, f.date, claimCycleStart(f.date), f.expenseType, f.category, paise, f.place ?? null, f.location ?? null, f.note ?? null])).rows[0];

    if (f.attachmentId) {
      const upd = await c.query(
        `UPDATE attachments SET claim_id=$1 WHERE attachment_id=$2 AND uploaded_by=$3
           AND claim_id IS NULL AND submission_id IS NULL AND task_id IS NULL`,
        [row.claim_id, f.attachmentId, req.user.id]);
      if (!upd.rowCount) throw forbidden('That bill is not yours or is already attached to another claim.');
    }

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

router.get('/admin/contributions', adminOnly, wrap(async (req, res) => {
  const status = ['Open', 'Replied'].includes(req.query.status) ? req.query.status : null;
  const out = await tx(req.user, async (c) => {
    const items = (await c.query(
      `SELECT c.contribution_id, c.work_date, c.entry_type, c.title, c.description,
              c.status, c.created_at,
              e.employee_id, e.employee_code, e.name AS employee_name
         FROM employee_contributions c
         JOIN employees e ON e.employee_id=c.employee_id
        WHERE ($1::text IS NULL OR c.status=$1)
        ORDER BY c.work_date DESC, c.created_at DESC`, [status])).rows;
    const replies = items.length ? (await c.query(
      `SELECT r.reply_id, r.contribution_id, r.message, r.created_at, e.name AS author_name
         FROM contribution_replies r
         JOIN employees e ON e.employee_id=r.employee_id
        WHERE r.contribution_id = ANY($1::uuid[])
        ORDER BY r.created_at ASC`, [items.map((x) => x.contribution_id)])).rows : [];
    return { items, replies };
  });
  res.json(out);
}));

router.post('/admin/contributions/:id/reply', adminOnly, uuidParam('id'), idempotent(wrap(async (req, res) => {
  const f = parse(contributionReplySchema, req.body);
  const out = await tx(req.user, async (c) => {
    const item = (await c.query(`SELECT contribution_id, employee_id FROM employee_contributions WHERE contribution_id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!item) throw notFound('That contribution does not exist.');
    const reply = (await c.query(
      `INSERT INTO contribution_replies (contribution_id, employee_id, message)
       VALUES ($1,$2,$3) RETURNING reply_id, contribution_id, employee_id, message, created_at`,
      [req.params.id, req.user.id, f.message])).rows[0];
    await c.query(`UPDATE employee_contributions SET status='Replied' WHERE contribution_id=$1`, [req.params.id]);
    await notify(c, { recipientId: item.employee_id, kind: 'contribution_reply', body: 'Admin replied to your contribution / inconvenience entry.', reqId: req.id });
    return reply;
  });
  res.status(201).json(out);
})));

router.get('/admin/claims', adminOnly, wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const status = ['Pending', 'Approved', 'Rejected'].includes(req.query.status) ? req.query.status : null;
  const cycle = /^\d{4}-\d{2}-\d{2}$/.test(req.query.cycle || '') ? req.query.cycle : null;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT c.*, e.name AS employee_name,
            to_char(c.claim_cycle_start, 'YYYY-MM-DD') AS cycle_start,
            to_char((c.claim_cycle_start + INTERVAL '6 days')::date, 'YYYY-MM-DD') AS cycle_end,
            COALESCE(cc.status, 'Open') AS cycle_status
       FROM claims c JOIN employees e ON e.employee_id=c.employee_id
      LEFT JOIN claim_cycles cc ON cc.cycle_start=c.claim_cycle_start
      WHERE ($1::text IS NULL OR c.status::text=$1)
        AND ($2::date IS NULL OR c.claim_cycle_start=$2::date)
      ORDER BY c.claim_cycle_start DESC, c.created_at DESC LIMIT $3 OFFSET $4`,
    [status, cycle, limit, offset]));
  res.json(rows);
}));

router.get('/admin/claims/cycles', adminOnly, wrap(async (req, res) => {
  const { limit, offset } = page(req.query);
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT to_char(c.claim_cycle_start, 'YYYY-MM-DD') AS cycle_start,
            to_char((c.claim_cycle_start + INTERVAL '6 days')::date, 'YYYY-MM-DD') AS cycle_end,
            COALESCE(cc.status, 'Open') AS cycle_status,
            COALESCE(cc.status, 'Open') AS status,
            cc.reviewed_by, cc.reviewed_at, cc.closed_by, cc.closed_at,
            COUNT(*)::int AS bill_count,
            COUNT(DISTINCT c.employee_id)::int AS employee_count,
            COALESCE(SUM(c.amount_paise),0)::bigint AS total_paise,
            COALESCE(SUM(c.amount_paise) FILTER (WHERE c.expense_type='Local'),0)::bigint AS local_paise,
            COALESCE(SUM(c.amount_paise) FILTER (WHERE c.expense_type='Outstation'),0)::bigint AS outstation_paise
       FROM claims c
       LEFT JOIN claim_cycles cc ON cc.cycle_start=c.claim_cycle_start
      WHERE c.claim_cycle_start IS NOT NULL
      GROUP BY c.claim_cycle_start, cc.status, cc.reviewed_by, cc.reviewed_at, cc.closed_by, cc.closed_at
      ORDER BY c.claim_cycle_start DESC
      LIMIT $1 OFFSET $2`, [limit, offset]));
  res.json(rows);
}));

router.post('/admin/claims/cycles/:cycle/review', adminOnly, idempotent(wrap(async (req, res) => {
  const cycle = parse(z.object({ cycle: isoDate }).strict(), req.params).cycle;
  const out = await tx(req.user, async (c) => {
    const cur = (await c.query(`SELECT cycle_start, status FROM claim_cycles WHERE cycle_start=$1 FOR UPDATE`, [cycle])).rows[0];
    if (!cur) throw notFound('That claim cycle does not exist.');
    if (cur.status === 'Closed') throw conflict('That claim cycle is already closed.', 'claim_cycle_closed');
    const row = (await c.query(
      `UPDATE claim_cycles SET status='Reviewed', reviewed_by=$2, reviewed_at=now(), updated_at=now()
        WHERE cycle_start=$1 RETURNING *`, [cycle, req.user.id])).rows[0];
    return row;
  });
  res.json(out);
})));

router.post('/admin/claims/cycles/:cycle/close', adminOnly, idempotent(wrap(async (req, res) => {
  const cycle = parse(z.object({ cycle: isoDate }).strict(), req.params).cycle;
  const out = await tx(req.user, async (c) => {
    const cur = (await c.query(`SELECT cycle_start, status FROM claim_cycles WHERE cycle_start=$1 FOR UPDATE`, [cycle])).rows[0];
    if (!cur) throw notFound('That claim cycle does not exist.');
    if (cur.status === 'Closed') return cur;
    if (cur.status !== 'Reviewed') throw conflict('Review the claim cycle before closing it.', 'review_required');
    const row = (await c.query(
      `UPDATE claim_cycles SET status='Closed', closed_by=$2, closed_at=now(), updated_at=now()
        WHERE cycle_start=$1 RETURNING *`, [cycle, req.user.id])).rows[0];
    return row;
  });
  res.json(out);
})));

/* Claims are reviewed and closed at the weekly-cycle level. */

// Excel-compatible SpreadsheetML workbook. No extra npm dependency is required.
const xmlEscape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const excelCell = (value, type = 'String') =>
  `<Cell><Data ss:Type="${type}">${xmlEscape(value)}</Data></Cell>`;
const excelRow = (cells) => `<Row>${cells.join('')}</Row>`;
const excelSheet = (name, rows) =>
  `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${rows.join('')}</Table></Worksheet>`;

router.get('/admin/claims/cycles/:cycle/export.xls', adminOnly, wrap(async (req, res) => {
  const cycle = parse(z.object({ cycle: isoDate }).strict(), req.params).cycle;
  const { rows } = await tx(req.user, (c) => c.query(
    `SELECT c.claim_id, c.claim_date, c.claim_cycle_start, e.name AS employee_name,
            c.employee_id, c.expense_type, c.category, c.amount_paise,
            c.place, c.location, c.note, c.created_at,
            COALESCE(cc.status, 'Open') AS cycle_status
       FROM claims c
       JOIN employees e ON e.employee_id=c.employee_id
       LEFT JOIN claim_cycles cc ON cc.cycle_start=c.claim_cycle_start
      WHERE c.claim_cycle_start=$1
      ORDER BY e.name, c.expense_type, c.claim_date, c.created_at`, [cycle]));

  if (!rows.length) throw notFound('That claim cycle has no bills.');
  const cycleEnd = new Date(`${cycle}T00:00:00Z`);
  cycleEnd.setUTCDate(cycleEnd.getUTCDate() + 6);
  const end = cycleEnd.toISOString().slice(0, 10);
  const money = (paise) => Number(paise || 0) / 100;
  const total = rows.reduce((s, r) => s + money(r.amount_paise), 0);
  const local = rows.filter(r => r.expense_type === 'Local').reduce((s, r) => s + money(r.amount_paise), 0);
  const outstation = rows.filter(r => r.expense_type === 'Outstation').reduce((s, r) => s + money(r.amount_paise), 0);
  const employees = new Map();
  for (const r of rows) {
    const e = employees.get(r.employee_id) || { name: r.employee_name, local: 0, outstation: 0, total: 0, bills: 0 };
    const a = money(r.amount_paise);
    e.total += a; e.bills += 1;
    if (r.expense_type === 'Local') e.local += a;
    if (r.expense_type === 'Outstation') e.outstation += a;
    employees.set(r.employee_id, e);
  }
  const fmt = (n) => n.toFixed(2);
  const summaryRows = [
    excelRow([excelCell('Weekly Claims Summary'), excelCell(''), excelCell(''), excelCell('')]),
    excelRow([excelCell('Cycle Start'), excelCell(cycle), excelCell('Cycle End'), excelCell(end)]),
    excelRow([excelCell('Status'), excelCell(rows[0].cycle_status)]),
    excelRow([excelCell('Employee'), excelCell('Local'), excelCell('Outstation'), excelCell('Total'), excelCell('Bills')]),
    ...Array.from(employees.values()).map(e => excelRow([excelCell(e.name), excelCell(fmt(e.local),'Number'), excelCell(fmt(e.outstation),'Number'), excelCell(fmt(e.total),'Number'), excelCell(e.bills,'Number')])),
    excelRow([excelCell('TOTAL'), excelCell(fmt(local),'Number'), excelCell(fmt(outstation),'Number'), excelCell(fmt(total),'Number'), excelCell(rows.length,'Number')]),
  ];
  const detailHeader = ['Employee','Date','Expense Type','Category','Amount','Place','Location','Note','Claim ID','Created At','Cycle Status'];
  const detailRows = [excelRow(detailHeader.map(h => excelCell(h))), ...rows.map(r => excelRow([
    excelCell(r.employee_name), excelCell(r.claim_date), excelCell(r.expense_type || 'Unclassified'), excelCell(r.category),
    excelCell(fmt(money(r.amount_paise)),'Number'), excelCell(r.place), excelCell(r.location), excelCell(r.note),
    excelCell(r.claim_id), excelCell(r.created_at ? new Date(r.created_at).toISOString() : ''), excelCell(r.cycle_status)
  ]))];
  const localRows = [excelRow(detailHeader.map(h => excelCell(h))), ...rows.filter(r => r.expense_type === 'Local').map(r => excelRow([
    excelCell(r.employee_name), excelCell(r.claim_date), excelCell(r.expense_type), excelCell(r.category), excelCell(fmt(money(r.amount_paise)),'Number'),
    excelCell(r.place), excelCell(r.location), excelCell(r.note), excelCell(r.claim_id), excelCell(r.created_at ? new Date(r.created_at).toISOString() : ''), excelCell(r.cycle_status)
  ]))];
  const outRows = [excelRow(detailHeader.map(h => excelCell(h))), ...rows.filter(r => r.expense_type === 'Outstation').map(r => excelRow([
    excelCell(r.employee_name), excelCell(r.claim_date), excelCell(r.expense_type), excelCell(r.category), excelCell(fmt(money(r.amount_paise)),'Number'),
    excelCell(r.place), excelCell(r.location), excelCell(r.note), excelCell(r.claim_id), excelCell(r.created_at ? new Date(r.created_at).toISOString() : ''), excelCell(r.cycle_status)
  ]))];

  const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Aptos" ss:Size="10"/></Style></Styles>
${excelSheet('Weekly Summary', summaryRows)}
${excelSheet('Bill Details', detailRows)}
${excelSheet('Local Expenses', localRows)}
${excelSheet('Outstation Expenses', outRows)}
</Workbook>`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claims-${cycle}-to-${end}.xls"`);
  res.send(workbook);
}));

/* ────────────────────────────────────────────────────────────── files */

router.post('/admin/claims/cycles/:cycle/clear', adminOnly, wrap(async (req, res) => {
  if (req.body?.confirm !== 'CLEAR') {
    throw unprocessable('Type CLEAR to confirm deletion of this exported week.', 'confirmation_required');
  }

  const cycle = /^\d{4}-\d{2}-\d{2}$/.test(req.params.cycle) ? req.params.cycle : null;
  if (!cycle) throw unprocessable('Use a valid Saturday cycle date.', 'invalid_cycle');

  const keys = await tx(req.user, async (c) => {
    const cur = (await c.query(
      `SELECT status FROM claim_cycles WHERE cycle_start=$1 FOR UPDATE`, [cycle])).rows[0];
    if (!cur) throw notFound('That claim cycle does not exist.');
    if (cur.status !== 'Closed') throw conflict('Only a closed cycle can be cleared after export.', 'claim_cycle_not_closed');

    const attachments = (await c.query(
      `SELECT a.storage_key FROM attachments a
         JOIN claims cl ON cl.claim_id=a.claim_id
        WHERE cl.claim_cycle_start=$1`, [cycle])).rows;

    await c.query(`DELETE FROM attachments WHERE claim_id IN (SELECT claim_id FROM claims WHERE claim_cycle_start=$1)`, [cycle]);
    const deletedClaims = (await c.query(`DELETE FROM claims WHERE claim_cycle_start=$1`, [cycle])).rowCount;
    await c.query(`DELETE FROM claim_cycles WHERE cycle_start=$1`, [cycle]);
    return { keys: attachments.map((r) => r.storage_key), deletedClaims };
  });

  let deletedFiles = 0;
  const failedFiles = [];
  for (const key of keys.keys) {
    try { await deleteObject(key); deletedFiles += 1; }
    catch (e) { failedFiles.push(key); logger.error({ err: e, storageKey: key, reqId: req.id }, 'claim file cleanup failed'); }
  }

  res.json({ cycle, deletedClaims: keys.deletedClaims, deletedFiles, failedFiles });
}));


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


router.post('/admin/test/reset', adminOnly, wrap(async (req, res) => {
  if (process.env.ALLOW_TEST_RESET !== 'true') {
    throw forbidden('Test reset is disabled. Set ALLOW_TEST_RESET=true only on the testing environment.', 'test_reset_disabled');
  }
  if (req.body?.confirm !== 'RESET ALL TEST DATA') {
    throw unprocessable('Type RESET ALL TEST DATA to confirm.', 'confirmation_required');
  }

  const result = (await pool.query(`SELECT reset_test_data() AS result`)).rows[0].result;
  res.json(result);
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


/**
 * Read-only employee dashboard. Admin opens it from the Today/Team screens,
 * chooses a date range, and gets one consolidated summary of attendance,
 * school visits, tasks, claims and LAT.
 */
router.get('/admin/employees/:id/dashboard', adminOnly, uuidParam('id'), wrap(async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  if (!from || !to) throw unprocessable('Choose a valid From and To date.', 'invalid_date_range');
  if (from > to) throw unprocessable('From date cannot be after To date.', 'invalid_date_range');
  const rangeDays = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (rangeDays > 366) throw unprocessable('Choose a date range of one year or less.', 'range_too_large');

  const out = await tx(req.user, async (c) => {
    const employee = (await c.query(
      `SELECT employee_id, employee_code, name, role, email, phone, status, claims_enabled
         FROM employees WHERE employee_id=$1`, [req.params.id])).rows[0];
    if (!employee) throw notFound('That employee does not exist.');

    const attendance = (await c.query(
      `SELECT a.attendance_id, a.work_date, a.check_in_time, a.check_out_time, a.status,
              a.check_in_accuracy, a.check_out_accuracy,
              li.name AS check_in_site, li.kind AS check_in_kind,
              lo.name AS check_out_site, lo.kind AS check_out_kind
         FROM attendance a
         LEFT JOIN locations li ON li.location_id=a.check_in_location_id
         LEFT JOIN locations lo ON lo.location_id=a.check_out_location_id
        WHERE a.employee_id=$1 AND a.work_date BETWEEN $2::date AND $3::date
        ORDER BY a.work_date DESC`, [req.params.id, from, to])).rows;

    const schoolVisits = (await c.query(
      `SELECT v.visit_id, v.work_date, v.check_in_time, v.check_out_time,
              v.check_in_accuracy, v.check_out_accuracy, l.name AS school_name, l.zone AS school_zone
         FROM school_visits v
         JOIN locations l ON l.location_id=v.location_id
        WHERE v.employee_id=$1 AND v.work_date BETWEEN $2::date AND $3::date
        ORDER BY v.work_date DESC, v.check_in_time DESC`, [req.params.id, from, to])).rows;

    // Dashboard task reporting must work even if a production database is
    // one migration behind. Avoid depending on the v_tasks view here and
    // explicitly cast enum values to text before UNIONing historical rows.
    const hasTaskHistory = (await c.query(
      `SELECT to_regclass('public.task_daily_log') IS NOT NULL AS present`
    )).rows[0]?.present === true;

    const taskSql = hasTaskHistory ? `
      SELECT l.task_id, t.task_code, t.title, l.work_date AS due_date, t.due_time,
             l.outcome::text AS status, NULL::timestamptz AS started_at,
             NULL::timestamptz AS submitted_at, NULL::timestamptz AS completed_at,
             l.outcome::text AS effective_status
        FROM task_daily_log l
        JOIN tasks t ON t.task_id=l.task_id
       WHERE l.employee_id=$1 AND l.work_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT t.task_id, t.task_code, t.title, t.due_date, t.due_time,
             t.status::text AS status, t.started_at, t.submitted_at, t.completed_at,
             CASE
               WHEN t.status IN ('Completed','Submitted') THEN t.status::text
               WHEN ((t.due_date + t.due_time) AT TIME ZONE 'Asia/Kolkata') < now() THEN 'Overdue'
               ELSE t.status::text
             END AS effective_status
        FROM tasks t
       WHERE t.assigned_to=$1 AND t.due_date BETWEEN $2::date AND $3::date
         AND t.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM task_daily_log l
            WHERE l.task_id=t.task_id AND l.work_date=t.due_date
         )
      ORDER BY due_date DESC, due_time DESC` : `
      SELECT t.task_id, t.task_code, t.title, t.due_date, t.due_time,
             t.status::text AS status, t.started_at, t.submitted_at, t.completed_at,
             CASE
               WHEN t.status IN ('Completed','Submitted') THEN t.status::text
               WHEN ((t.due_date + t.due_time) AT TIME ZONE 'Asia/Kolkata') < now() THEN 'Overdue'
               ELSE t.status::text
             END AS effective_status
        FROM tasks t
       WHERE t.assigned_to=$1 AND t.due_date BETWEEN $2::date AND $3::date
         AND t.deleted_at IS NULL
       ORDER BY t.due_date DESC, t.due_time DESC`;

    const tasks = (await c.query(taskSql, [req.params.id, from, to])).rows;

    const claims = (await c.query(
      `SELECT claim_id, claim_date, expense_type, category, amount_paise, place, location, note
         FROM claims
        WHERE employee_id=$1 AND claim_date BETWEEN $2::date AND $3::date
        ORDER BY claim_date DESC, created_at DESC`, [req.params.id, from, to])).rows;

    const contributions = (await c.query(
      `SELECT contribution_id, work_date, entry_type, title, description, status, created_at
         FROM employee_contributions
        WHERE employee_id=$1 AND work_date BETWEEN $2::date AND $3::date
        ORDER BY work_date DESC, created_at DESC`, [req.params.id, from, to])).rows;

    const contributionReplies = contributions.length ? (await c.query(
      `SELECT r.reply_id, r.contribution_id, r.message, r.created_at, e.name AS author_name
         FROM contribution_replies r
         JOIN employees e ON e.employee_id=r.employee_id
        WHERE r.contribution_id = ANY($1::uuid[])
        ORDER BY r.created_at ASC`, [contributions.map((x) => x.contribution_id)])).rows : [];

    const workDone = (await c.query(
      `SELECT work_done_id, work_date, summary, created_at, updated_at
         FROM employee_work_done
        WHERE employee_id=$1 AND work_date BETWEEN $2::date AND $3::date
        ORDER BY work_date DESC`, [req.params.id, from, to])).rows;

    const latAttempts = (await c.query(
      `SELECT attempt_id, started_at, submitted_at, score, total
         FROM lat_attempts
        WHERE employee_id=$1
          AND (started_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
        ORDER BY started_at DESC`, [req.params.id, from, to])).rows;

    const hoursBetween = (a, b) => a && b ? Math.max(0, (new Date(b) - new Date(a)) / 3600000) : 0;
    const round2 = (n) => Math.round(n * 100) / 100;
    const attendanceWithIn = attendance.filter((a) => a.check_in_time);
    const completedAttendance = attendanceWithIn.filter((a) => a.check_out_time);
    const attendanceDays = new Set(attendanceWithIn.map((a) => String(a.work_date).slice(0,10))).size;
    const completedDays = new Set(completedAttendance.map((a) => String(a.work_date).slice(0,10))).size;
    const lateDays = new Set(attendance.filter((a) => a.status === 'Late').map((a) => String(a.work_date).slice(0,10))).size;
    const fieldDays = new Set(attendance.filter((a) => a.status === 'Field Work').map((a) => String(a.work_date).slice(0,10))).size;
    const totalHours = round2(completedAttendance.reduce((sum, a) => sum + hoursBetween(a.check_in_time, a.check_out_time), 0));
    const visitHours = round2(schoolVisits.reduce((sum, v) => sum + hoursBetween(v.check_in_time, v.check_out_time), 0));
    const claimsTotal = claims.reduce((sum, c) => sum + Number(c.amount_paise || 0), 0);
    const localTotal = claims.filter((c) => c.expense_type === 'Local').reduce((sum, c) => sum + Number(c.amount_paise || 0), 0);
    const outstationTotal = claims.filter((c) => c.expense_type === 'Outstation').reduce((sum, c) => sum + Number(c.amount_paise || 0), 0);

    return {
      employee,
      range: { from, to },
      summary: {
        attendanceDays,
        completedDays,
        lateDays,
        fieldDays,
        totalHours,
        schoolVisits: schoolVisits.length,
        visitHours,
        tasksAssigned: tasks.length,
        tasksCompleted: tasks.filter((t) => t.effective_status === 'Completed').length,
        tasksSubmitted: tasks.filter((t) => t.effective_status === 'Submitted').length,
        tasksOverdue: tasks.filter((t) => t.effective_status === 'Overdue').length,
        claimsTotal,
        localTotal,
        outstationTotal,
        claimCount: claims.length,
        latAttempts: latAttempts.length,
        latCompleted: latAttempts.filter((a) => a.submitted_at).length,
        latScore: latAttempts.reduce((sum, a) => sum + Number(a.score || 0), 0),
        latPossible: latAttempts.reduce((sum, a) => sum + Number(a.total || 0), 0),
        contributionsCount: contributions.length,
      },
      attendance,
      schoolVisits,
      tasks,
      claims,
      contributions,
      contributionReplies,
      workDone,
      latAttempts,
    };
  });

  res.json(out);
}));

router.patch('/admin/employees/:id', adminOnly, uuidParam('id'), wrap(async (req, res) => {
  const f = parse(employeeUpdateSchema, req.body);
  const hash = f.password?.trim() ? await (assertPasswordPolicy(f.password), hashPassword(f.password)) : null;
  const out = await tx(req.user, async (c) => {
    const existing = (await c.query(
      `SELECT employee_id, email, is_admin FROM employees WHERE employee_id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!existing) throw notFound('That employee does not exist.');

    if (String(existing.email).toLowerCase() !== f.email.toLowerCase()) {
      const duplicate = await c.query(`SELECT 1 FROM employees WHERE email=$1 AND employee_id<>$2`, [f.email, req.params.id]);
      if (duplicate.rowCount) throw conflict('An account with that email already exists.', 'email_taken');
    }

    const row = (await c.query(
      `UPDATE employees
          SET name=$2, role=$3, email=$4, phone=$5, status=$6,
              claims_enabled=$7, cap_food=$8, cap_stay=$9,
              password_hash=COALESCE($10, password_hash),
              password_changed_at=CASE WHEN $10 IS NULL THEN password_changed_at ELSE now() END
        WHERE employee_id=$1
        RETURNING employee_id, employee_code, name, role, email, phone, is_admin, status, claims_enabled, cap_food, cap_stay`,
      [req.params.id, f.name, f.role, f.email.toLowerCase(), f.phone || null, f.status,
       f.claimsEnabled, f.capFood, f.capStay, hash])).rows[0];
    return row;
  });
  res.json(out);
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
