import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, reset, api } from './helpers.js';

before(async () => { await boot(); await reset(); });
after(async () => { await shutdown(); });

/* ────────────────────────────────────────── content security policy */

/**
 * A CSP that blocks the application is worse than none, because the next
 * person to hit it will simply turn it off. These assert both halves: the
 * policy exists, and it still permits everything Sapience Team needs.
 */
test('a content security policy is served', async () => {
  const r = await api('/');
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp, 'no CSP header');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/, 'plugins are blocked');
  assert.match(csp, /frame-ancestors/, 'clickjacking protection is present');
});

test('the policy permits the fonts and inline styles the app actually uses', async () => {
  const r = await api('/');
  const csp = r.headers.get('content-security-policy');
  // The UI imports a webfont over https and uses React inline styles.
  assert.match(csp, /style-src[^;]*https:/, 'the webfont stylesheet must load');
  assert.match(csp, /style-src[^;]*'unsafe-inline'/, 'React inline styles must render');
  assert.match(csp, /font-src[^;]*https:/, 'font files must load');
  assert.match(csp, /img-src[^;]*data:/, 'inline SVG and icons must render');
});

test('scripts are restricted to the application origin', async () => {
  const r = await api('/');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/, 'eval must not be permitted');
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, 'inline scripts must not be permitted');
});

test('the API is same-origin, so connect-src falls back to self', async () => {
  // One service serves the app and the API, so no cross-origin allowance
  // is needed. If that ever changes, this test should fail and be revisited.
  const r = await api('/');
  const csp = r.headers.get('content-security-policy');
  assert.doesNotMatch(csp, /connect-src/, 'no explicit connect-src should be required');
  assert.match(csp, /default-src 'self'/);
});

/* ────────────────────────────────────────── other security headers */

test('the usual protective headers are present', async () => {
  const r = await api('/');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('x-frame-options') || /frame-ancestors/.test(r.headers.get('content-security-policy')));
  assert.equal(r.headers.get('x-powered-by'), null, 'the server must not advertise itself');
});

/* ────────────────────────────────────────────────────────── version */

test('a real version is reported, not "dev"', async () => {
  const r = await api('/health');
  assert.equal(r.status, 200);
  assert.ok(r.body.version, 'no version reported');
  assert.notEqual(r.body.version, 'dev', 'the audit flagged "dev" as a problem');
  assert.match(r.body.version, /^v\d+\.\d+\.\d+$/, 'expected vMAJOR.MINOR.PATCH');
});

test('the reported version matches package.json', async () => {
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const r = await api('/health');
  assert.equal(r.body.version, `v${pkg.version}`,
    'a second source of truth would drift the first time either is bumped');
});

test('health does not leak configuration or secrets', async () => {
  const r = await api('/health');
  const body = JSON.stringify(r.body);
  assert.doesNotMatch(body, /postgres:\/\/|password|secret|JWT|token/i,
    'health is public, so it must expose nothing sensitive');
});
