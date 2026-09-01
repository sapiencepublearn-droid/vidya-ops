import pg from 'pg';
import crypto from 'node:crypto';
import { pino } from 'pino';

/* ─────────────────────────────────────────── configuration + validation */

function required(name, { min } = {}) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable: ${name}`);
  if (min && v.length < min) throw new Error(`${name} must be at least ${min} characters`);
  return v;
}

export const config = (() => {
  const env = process.env.NODE_ENV || 'development';
  const cfg = {
    env,
    isProd: env === 'production',
    port: Number(process.env.PORT || 3000),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: required('JWT_SECRET', { min: 32 }),
    fileSecret: process.env.FILE_SECRET || required('JWT_SECRET', { min: 32 }),
    tokenTtlMinutes: Number(process.env.TOKEN_TTL_MINUTES || 720),
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    storageDir: process.env.STORAGE_DIR || './storage',
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
    maxAccuracyMetres: Number(process.env.MAX_ACCURACY_M || 100),
    gpsRetentionDays: Number(process.env.GPS_RETENTION_DAYS || 90),
    maxFailedLogins: Number(process.env.MAX_FAILED_LOGINS || 5),
    lockoutMinutes: Number(process.env.LOCKOUT_MINUTES || 15),
    statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS || 5000),
    loginRateMax: Number(process.env.LOGIN_RATE_MAX || 10),
  };
  // In production an empty CORS allowlist means the browser app cannot
  // reach the API at all, which is a misconfiguration worth failing on.
  if (cfg.isProd && cfg.corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be set in production (wildcard is not permitted)');
  }
  if (cfg.isProd && cfg.corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGINS must not contain "*" for an authenticated API');
  }
  return cfg;
})();

/* ────────────────────────────────────────────────────────────── logging */

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug'),
  // Never let credentials or tokens reach the log stream.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password', '*.password_hash'],
    censor: '[redacted]',
  },
});

/* ───────────────────────────────────────────────────────────── database */

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: config.statementTimeoutMs,
});

pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

/**
 * Runs a transaction with the RLS actor context set.
 * Every statement inside sees app.actor_id / app.is_admin, which the
 * row-level policies and the audit trigger both read. Using SET LOCAL
 * means the setting dies with the transaction and cannot leak to the
 * next request that borrows this pooled connection.
 */
export async function tx(actor, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.actor_id', actor?.id ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.is_admin', actor?.isAdmin ? 'true' : 'false']);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Read-only convenience for queries that still need actor context. */
export const query = (actor, sql, params) => tx(actor, (c) => c.query(sql, params));

export async function dbHealth() {
  const started = Date.now();
  const { rows } = await pool.query('SELECT 1 AS ok, ist_today() AS business_date');
  return { ok: rows[0].ok === 1, businessDate: rows[0].business_date, latencyMs: Date.now() - started };
}

/* ─────────────────────────────────────────────────────────────── errors */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (m, d) => new ApiError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Sign in to continue.') => new ApiError(401, 'unauthorized', m);
export const forbidden = (m = 'You do not have access to this.') => new ApiError(403, 'forbidden', m);
export const notFound = (m = 'Not found.') => new ApiError(404, 'not_found', m);
export const conflict = (m, c = 'conflict') => new ApiError(409, c, m);
export const unprocessable = (m, c = 'unprocessable', d) => new ApiError(422, c, m, d);

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Guards the :id params so a malformed UUID is a 400, never a raw 22P02. */
export function uuidParam(name) {
  return (req, _res, next) => {
    if (!UUID_RE.test(req.params[name] || '')) {
      return next(badRequest(`${name} must be a valid identifier.`));
    }
    next();
  };
}

/* ───────────────────────────────────────────────────────────── geometry */

const R_EARTH = 6371000, toRad = (d) => (d * Math.PI) / 180;
export function metresBetween(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R_EARTH * Math.asin(Math.sqrt(h)));
}

export const newId = () => crypto.randomUUID();
