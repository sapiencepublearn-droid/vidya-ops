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
            (SELECT status FROM employees WHERE employee_id = $2) AS status`,
    [claims.jti, claims.sub]
  ).then(({ rows }) => {
    if (rows[0].revoked) return next(new ApiError(401, 'token_revoked', 'You have been signed out.'));
    if (rows[0].status !== 'Active') return next(forbidden('This account is not active.'));
    req.user = { id: claims.sub, isAdmin: !!claims.admin, jti: claims.jti, exp: claims.exp };
    next();
  }).catch(next);
}

export function adminOnly(req, _res, next) {
  if (!req.user?.isAdmin) return next(forbidden('This action needs admin access.'));
  next();
}
