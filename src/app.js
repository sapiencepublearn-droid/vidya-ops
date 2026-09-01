import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { config, logger, ApiError, dbHealth, pool } from './core.js';
import { router } from './routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

  // Correlation ID on every request and every log line it produces.
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = Date.now();
    res.on('finish', () => {
      logger.info({
        reqId: req.id, method: req.method, path: req.path,
        status: res.statusCode, ms: Date.now() - started,
        userId: req.user?.id,
      }, 'request');
    });
    next();
  });

  // Explicit allowlist. No wildcard, and credentials are only echoed
  // back to origins we named.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(origin && config.corsOrigins.includes(origin) ? 204 : 403);
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_req, res) => {
    try {
      const db = await dbHealth();
      res.json({ status: 'ok', db, uptimeSeconds: Math.round(process.uptime()), version: process.env.APP_VERSION || 'dev' });
    } catch (err) {
      logger.error({ err }, 'health check failed');
      res.status(503).json({ status: 'degraded', db: { ok: false } });
    }
  });

  app.use('/api', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth/login', rateLimit({
    windowMs: 15 * 60_000, max: config.loginRateMax, standardHeaders: true, legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many attempts. Try again shortly.' },
  }));

  app.use('/api', router);

  // Serve the built frontend from the same process, so one Render service
  // covers both the API and the web app instead of paying for two.
  const dist = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, {
      // Hashed asset filenames can be cached hard; index.html must not be,
      // or a deploy leaves people on the previous version.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'No such endpoint.', requestId: req.id }));

  // Anything else is a client route: hand back the app shell.
  app.use((req, res) => {
    const index = path.join(dist, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.', requestId: req.id });
  });

  // Single controlled error surface. Nothing internal escapes.
  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: err.code, message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId: req.id,
      });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_json', message: 'The request body is not valid JSON.', requestId: req.id });
    }
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file_too_large', message: 'That file is larger than the limit.', requestId: req.id });
    }
    // Postgres codes are mapped, never forwarded.
    const pgMap = {
      '23505': [409, 'conflict', 'That record already exists.'],
      '23503': [422, 'invalid_reference', 'A referenced record does not exist.'],
      '23514': [422, 'constraint_violated', 'That value is not allowed.'],
      '22P02': [400, 'bad_input', 'One of the values is not in a valid format.'],
      '57014': [503, 'timeout', 'That took too long. Try again.'],
    };
    if (pgMap[err?.code]) {
      const [status, code, message] = pgMap[err.code];
      logger.warn({ err: { code: err.code }, reqId: req.id }, 'database constraint');
      return res.status(status).json({ error: code, message, requestId: req.id });
    }
    logger.error({ err, reqId: req.id }, 'unhandled error');
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on our side.', requestId: req.id });
  });

  return app;
}

/**
 * Applies pending migrations at boot.
 *
 * Free hosting has no pre-deploy hook, so this is where schema changes
 * get applied. node-pg-migrate takes its own advisory lock, so if the
 * host ever runs two instances only one migrates and the other waits.
 * Enabled with RUN_MIGRATIONS_ON_BOOT=true; on a paid plan prefer a
 * pre-deploy command so a failed migration never starts a bad version.
 */
async function migrateOnBoot() {
  if (process.env.RUN_MIGRATIONS_ON_BOOT !== 'true') return;
  const { runner } = await import('node-pg-migrate');
  const url = process.env.ADMIN_DATABASE_URL || config.databaseUrl;
  logger.info('applying migrations');
  const applied = await runner({
    databaseUrl: url,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (m) => logger.info(m),
  });
  logger.info({ count: applied.length }, applied.length ? 'migrations applied' : 'schema already current');
}

export async function start() {
  await migrateOnBoot();
  await dbHealth(); // fail fast if the database is unreachable at boot
  const app = createApp();
  const server = app.listen(config.port, () => logger.info({ port: config.port, env: config.env }, 'listening'));

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}
