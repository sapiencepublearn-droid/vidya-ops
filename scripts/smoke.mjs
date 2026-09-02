#!/usr/bin/env node
/**
 * Post-deploy smoke test.
 *
 *   node scripts/smoke.mjs https://your-app.onrender.com
 *
 * Answers one question: did this deploy actually work?
 *
 * Read-only. It creates nothing, changes nothing and deletes nothing, so
 * it is safe to run against production after every deploy. Deliberately a
 * short script rather than a browser automation framework — for a team of
 * this size, five checks that genuinely run beat fifty that nobody does.
 *
 * Exits non-zero on failure so a deploy pipeline can stop on it.
 */

const base = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/smoke.mjs <base-url>');
  process.exit(2);
}

const results = [];
let failed = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (e) {
    failed += 1;
    results.push({ name, ok: false, ms: Date.now() - started, detail: e.message });
  }
}

const get = async (path, opts = {}) => {
  const res = await fetch(base + path, { redirect: 'manual', ...opts });
  return { status: res.status, headers: res.headers, body: await res.text() };
};

/* 1. the app is reachable and serving the web shell */
await check('app reachable', async () => {
  const r = await get('/');
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  if (!r.body.includes('id="root"')) throw new Error('did not serve the app shell');
  return 'serving the web app';
});

/* 2 and 3. health, and the database behind it */
await check('health and database', async () => {
  const r = await get('/health');
  const h = JSON.parse(r.body);
  if (h.status === 'down') throw new Error('reporting DOWN');
  if (!h.checks?.database?.ok) throw new Error('database is not reachable');
  if (h.status === 'degraded') {
    const bad = Object.entries(h.checks).filter(([, v]) => !v.ok).map(([k]) => k);
    throw new Error(`DEGRADED: ${bad.join(', ') || 'see /health'}`);
  }
  return `${h.status}, ${h.version}, db ${h.checks.database.latencyMs}ms, business date ${String(h.checks.database.businessDate).slice(0, 10)}`;
});

/* 4. authentication responds correctly, without creating a session */
await check('auth rejects bad credentials', async () => {
  const r = await get('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // A deliberately invalid account. Nothing is created and nothing locks
    // out, because no real employee is named here.
    body: JSON.stringify({ email: 'smoke-test@invalid.local', password: 'not-a-real-password' }),
  });
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  const b = JSON.parse(r.body);
  if (/does not exist|no such|unknown account/i.test(b.message || '')) {
    throw new Error('login is leaking whether an account exists');
  }
  return 'rejects and does not enumerate';
});

/* 5. a protected endpoint really is protected */
await check('protected endpoints require auth', async () => {
  for (const path of ['/api/me', '/api/tasks/me', '/api/admin/employees', '/api/broadcasts']) {
    const r = await get(path);
    if (r.status !== 401) throw new Error(`${path} returned ${r.status}, expected 401`);
  }
  return '4 endpoints correctly refuse anonymous access';
});

/* 6. the request id is present, and is not the one we asked for */
await check('request ids are server-generated', async () => {
  const forged = 'forged-by-the-client';
  const r = await get('/api/me', { headers: { 'X-Request-Id': forged } });
  const got = r.headers.get('x-request-id');
  if (!got) throw new Error('no X-Request-Id on the response');
  if (got === forged) throw new Error('the server echoed a client-supplied request id');
  return 'server issues its own id';
});

/* 7. the installable app is intact */
await check('PWA assets served', async () => {
  const m = await get('/manifest.webmanifest');
  if (m.status !== 200) throw new Error(`manifest returned ${m.status}`);
  const manifest = JSON.parse(m.body);
  for (const icon of manifest.icons || []) {
    const i = await get(icon.src);
    if (i.status !== 200) throw new Error(`icon ${icon.src} returned ${i.status}`);
  }
  if (manifest.name !== 'Sapience Team') {
    throw new Error(`manifest name is "${manifest.name}", expected "Sapience Team"`);
  }
  return `${manifest.name}, ${manifest.icons?.length || 0} icons`;
});

/* ---------------------------------------------------------------- report */

const width = Math.max(...results.map((r) => r.name.length));
console.log(`\nSmoke test: ${base}\n`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail} (${r.ms}ms)`);
}
console.log(`\n${results.length - failed}/${results.length} passed\n`);

if (failed) {
  console.error('Deployment is NOT healthy. Check the logs before telling anyone it is live.');
  process.exit(1);
}
console.log('Deployment looks healthy.');
