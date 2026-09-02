import pg from 'pg';
import { createApp } from '../src/app.js';
import { pool } from '../src/core.js';
import { hashPassword } from '../src/auth.js';

/**
 * Fixtures and assertions use an OWNER connection. The application under
 * test uses the least-privilege crm_app role, which is subject to RLS and
 * has no DELETE/TRUNCATE. Keeping the two apart is what makes the
 * isolation tests meaningful rather than self-confirming.
 */
export const db = new pg.Pool({
  connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL,
});

let server, base;

export async function boot(opts) {
  if (server) return base;
  // Functional tests run with generous limits so they are not fighting the
  // rate limiter; the limiter itself is tested on its own app instance.
  const app = createApp(opts ?? { limits: {
    global: 100000, reset: 100000, resetSubmit: 100000,
    upload: 100000, claims: 100000, lat: 100000, broadcast: 100000,
  } });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
export async function shutdown() {
  if (server) await new Promise((r) => server.close(r));
  await pool.end().catch(() => {});
  await db.end().catch(() => {});
}

export async function api(path, { method = 'GET', token, body, raw, idempotencyKey, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let payload = body;
  if (body && !raw) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

/** Wipes and reseeds. Runs as the migration owner, not the app role. */
export async function reset() {
  await db.query(`
    SET session_replication_role = replica;
    TRUNCATE audit_log, notifications, day_plan_items, day_plans, daily_summaries,
             attachments, claims, work_submissions, tasks, attendance, revoked_tokens,
             trainer_assignments, employees, locations RESTART IDENTITY CASCADE;
    SET session_replication_role = origin;
  `);

  const loc = (await db.query(
    `INSERT INTO locations (kind,name,latitude,longitude,radius_metres)
     VALUES ('office','Head Office',13.041800,80.234100,100) RETURNING *`)).rows[0];
  const school = (await db.query(
    `INSERT INTO locations (kind,name,zone,latitude,longitude,radius_metres)
     VALUES ('school','ABC School','Thiruporur',13.082700,80.270700,100) RETURNING *`)).rows[0];

  const pw = await hashPassword('correct-horse-battery');
  const mk = async (code, name, role, email, isAdmin, claims) => (await db.query(
    `INSERT INTO employees (employee_code,name,role,email,password_hash,is_admin,
        office_location_id,claims_enabled,cap_food,cap_stay)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,500,1500) RETURNING *`,
    [code, name, role, email, pw, isAdmin, loc.location_id, claims])).rows[0];

  const admin = await mk('EMP-000', 'Boss', 'CEO', 'boss@x.in', true, true);
  const alice = await mk('EMP-001', 'Alice', 'Trainer', 'alice@x.in', false, true);
  const bob = await mk('EMP-002', 'Bob', 'Designer', 'bob@x.in', false, false);

  return { loc, school, admin, alice, bob, password: 'correct-horse-battery' };
}

export async function tokenFor(email, password = 'correct-horse-battery') {
  const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.token = r.body.token;
}

/** Multipart body without a dependency. */
/** A second app with its own limits, for testing the limiter itself. */
export async function bootWithLimits(limits) {
  const app = createApp({ limits });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url,
    call: async (path, init = {}) => {
      const res = await fetch(url + path, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

export function multipart(fieldName, filename, buffer) {
  const boundary = '----t' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, buffer, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function uploadFile(token, filename, buffer) {
  const { body, contentType } = multipart('file', filename, buffer);
  const res = await fetch(`${base}/api/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 0x20), Buffer.from('\n%%EOF')]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
export const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(300, 0)]);
