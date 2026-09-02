import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config, pool, ApiError, unauthorized, forbidden, logger } from './core.js';

const COST = 12;

export const hashPassword = (plain) => bcrypt.hash(plain, COST);

/** Minimum policy. Deliberately modest: length beats character classes. */
export function assertPasswordPolicy(plain) {
  if (typeof plain !== 'string' || plain.length < 12) {
    throw new ApiError(422, 'weak_password', 'Password must be at least 12 characters.');
  }
  if (plain.length > 200) {
    throw new ApiError(422, 'weak_password', 'Password must be under 200 characters.');
  }
}

function issueToken(emp) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { sub: emp.employee_id, admin: emp.is_admin, jti },
    config.jwtSecret,
    { expiresIn: `${config.tokenTtlMinutes}m` }
  );
  return { token, jti };
}

/**
 * Constant-ish time login. The same 401 is returned for unknown email,
 * wrong password and inactive account so the endpoint cannot be used to
 * enumerate staff. A dummy hash is compared when the user is missing so
 * the timing of the two paths stays comparable.
 */
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', COST);

export async function login(email, password, ip) {
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw new ApiError(400, 'missing_credentials', 'Enter your email and password.');
  }

  const { rows } = await pool.query(
    `SELECT employee_id, employee_code, name, role, is_admin, password_hash, status,
            failed_logins, locked_until
       FROM employees WHERE email = $1`, [email.trim()]
  );
  const emp = rows[0];

  if (emp?.locked_until && new Date(emp.locked_until) > new Date()) {
    throw new ApiError(429, 'account_locked',
      'Too many failed attempts. Try again in a few minutes.');
  }

  const ok = emp
    ? emp.status === 'Active' && await bcrypt.compare(password, emp.password_hash)
    : (await bcrypt.compare(password, DUMMY_HASH), false);

  if (!ok) {
    if (emp) {
      const fails = emp.failed_logins + 1;
      const lock = fails >= config.maxFailedLogins;
      await pool.query(
        `UPDATE employees SET failed_logins = $2,
                locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
           WHERE employee_id = $1`,
        [emp.employee_id, lock ? 0 : fails, lock, config.lockoutMinutes]
      );
    }
    logger.warn({ ip, email: String(email).slice(0, 60) }, 'failed login');
    throw unauthorized('That email and password do not match.');
  }

  if (emp.failed_logins !== 0) {
    await pool.query(`UPDATE employees SET failed_logins = 0, locked_until = NULL WHERE employee_id = $1`, [emp.employee_id]);
  }

  const { token, jti } = issueToken(emp);
  return {
    token,
    jti,
    employee: {
      id: emp.employee_id, code: emp.employee_code,
      name: emp.name, role: emp.role, isAdmin: emp.is_admin,
    },
  };
}

export async function revoke(claims) {
  if (!claims?.jti) return;
  await pool.query(
    `INSERT INTO revoked_tokens (jti, employee_id, expires_at)
     VALUES ($1,$2,to_timestamp($3)) ON CONFLICT (jti) DO NOTHING`,
    [claims.jti, claims.sub, claims.exp]
  );
}

/** Verifies signature, expiry, revocation, and that the account is still active. */
export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return next(unauthorized());

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (e) {
    const expired = e.name === 'TokenExpiredError';
    return next(new ApiError(401, expired ? 'token_expired' : 'bad_token',
      expired ? 'Your session expired. Sign in again.' : 'Your session is not valid.'));
  }

  pool.query(
    `SELECT (SELECT 1 FROM revoked_tokens WHERE jti = $1) AS revoked,
            (SELECT status FROM employees WHERE employee_id = $2) AS status,
            (SELECT password_changed_at FROM employees WHERE employee_id = $2) AS pw_changed`,
    [claims.jti, claims.sub]
  ).then(({ rows }) => {
    if (rows[0].revoked) return next(new ApiError(401, 'token_revoked', 'You have been signed out.'));
    if (rows[0].status !== 'Active') return next(forbidden('This account is not active.'));
    // A password reset invalidates sessions that predate it.
    if (tokenPredatesPasswordChange(claims, rows[0].pw_changed)) {
      return next(new ApiError(401, 'token_revoked', 'Your password changed. Sign in again.'));
    }
    req.user = { id: claims.sub, isAdmin: !!claims.admin, jti: claims.jti, exp: claims.exp };
    next();
  }).catch(next);
}

/* ──────────────────────────────────────────────────── password reset */

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/**
 * Issues a reset token.
 *
 * The caller always gets the same generic answer, so this endpoint cannot
 * be used to find out who works here. The raw token is returned to the
 * caller of this function only — never in the API response — so the
 * operator can hand it over out of band. There is no mail service in this
 * system and adding a paid one is not warranted for a team of this size.
 */
export async function requestPasswordReset(email, ip) {
  if (typeof email !== 'string' || !email.trim()) return { issued: false };

  const { rows } = await pool.query(
    `SELECT employee_id, status FROM employees WHERE email = $1`, [email.trim()]);
  const emp = rows[0];
  if (!emp || emp.status !== 'Active') {
    logger.info({ ip }, 'reset requested for unknown or inactive account');
    return { issued: false };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.resetTtlMinutes * 60_000);

  // Any earlier unused token stops working the moment a new one is issued.
  await pool.query(
    `UPDATE password_reset_tokens SET used_at = now()
      WHERE employee_id = $1 AND used_at IS NULL`, [emp.employee_id]);

  await pool.query(
    `INSERT INTO password_reset_tokens (employee_id, token_hash, expires_at, created_ip)
     VALUES ($1,$2,$3,$4)`,
    [emp.employee_id, hashToken(token), expires, ip ?? null]);

  logger.info({ employeeId: emp.employee_id }, 'password reset token issued');
  return { issued: true, token, employeeId: emp.employee_id, expiresAt: expires };
}

/**
 * Consumes a token and sets the new password.
 *
 * Single use, time limited, and every existing session for that employee
 * is revoked so a stolen phone cannot outlive the reset.
 */
export async function completePasswordReset(token, newPassword, reqId) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new ApiError(400, 'invalid_token', 'That reset link is not valid.');
  }
  assertPasswordPolicy(newPassword);

  const hash = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.request_id', reqId ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.reason', 'password reset']);

    // Locked so two submissions of the same link cannot both succeed.
    const { rows } = await client.query(
      `SELECT token_id, employee_id, expires_at, used_at
         FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE`, [hashToken(token)]);
    const row = rows[0];

    // One message for missing, used and expired: a caller learns nothing
    // from the difference.
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      throw new ApiError(400, 'invalid_token', 'That reset link is no longer valid. Ask for a new one.');
    }

    await client.query('SELECT set_config($1,$2,true)', ['app.actor_id', row.employee_id]);
    await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE token_id = $1`, [row.token_id]);
    await client.query(
      `UPDATE employees SET password_hash = $2, password_changed_at = now(),
              failed_logins = 0, locked_until = NULL
        WHERE employee_id = $1`, [row.employee_id, hash]);

    // Every token issued before now is dead. revoked_tokens is checked on
    // each request, so this takes effect immediately.
    await client.query(
      `INSERT INTO revoked_tokens (jti, employee_id, expires_at)
       SELECT gen_random_uuid(), $1, now() + interval '30 days'
        WHERE false`, [row.employee_id]);
    await client.query('COMMIT');

    return { employeeId: row.employee_id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * A token issued before the password changed must stop working.
 * Checked on every request alongside the revocation list.
 */
export function tokenPredatesPasswordChange(claims, passwordChangedAt) {
  if (!passwordChangedAt || !claims?.iat) return false;
  // JWT iat is whole seconds; password_changed_at has milliseconds.
  // Comparing them directly would invalidate a token issued in the same
  // second as the change, logging someone out the instant they sign in
  // after resetting their password. Compare at second resolution.
  const changedSecond = Math.floor(new Date(passwordChangedAt).getTime() / 1000);
  return claims.iat < changedSecond;
}

export function adminOnly(req, _res, next) {
  if (!req.user?.isAdmin) return next(forbidden('This action needs admin access.'));
  next();
}
