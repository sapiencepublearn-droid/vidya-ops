import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from '../web/api-client.js';

/**
 * The frontend cannot be rendered here, but the seam between it and the
 * API can be checked mechanically: every method App.jsx calls must exist
 * on the client, and the client must not offer routes the server lacks.
 * This catches the class of bug where a rename leaves a dead call that
 * only shows up when a user taps the button.
 */
const app = ['../web/App.jsx', '../web/Lat.jsx', '../web/Broadcast.jsx']
  .map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
// Every module that mounts routes must be scanned, or the check silently
// passes for endpoints it cannot see.
const routes = ['../src/routes.js', '../src/lat.js']
  .map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
const client = createClient({ baseUrl: '/api' });

function methodsCalledInApp() {
  const found = new Set();
  for (const m of app.matchAll(/\bapi\.(admin\.)?([a-zA-Z]+)\s*\(/g)) {
    found.add(`${m[1] ? 'admin.' : ''}${m[2]}`);
  }
  return [...found];
}

test('every client method the UI calls exists', () => {
  const missing = methodsCalledInApp().filter((name) => {
    const target = name.startsWith('admin.') ? client.admin?.[name.slice(6)] : client[name];
    return typeof target !== 'function';
  });
  assert.deepEqual(missing, [], `UI calls methods that do not exist: ${missing.join(', ')}`);
});

test('the UI never calls fetch directly', () => {
  // All network access must go through the client so auth, errors and the
  // 401 path stay in one place.
  assert.equal(/[^.\w]fetch\s*\(/.test(app), false, 'App.jsx must not call fetch directly');
});

test('the UI holds no hardcoded credentials or seeded business data', () => {
  assert.equal(/password\s*[:=]\s*['"][^'"]+['"]/i.test(app), false, 'no hardcoded passwords');
  assert.equal(/EMP-0\d\d/.test(app), false, 'no seeded employee ids in the bundle');
  assert.equal(/@vidyapub\.in/.test(app), false, 'no seeded accounts in the bundle');
  assert.equal(/const\s+(SEED|EMPLOYEES|seedTasks|seedClaims)\b/.test(app), false, 'no in-memory data source');
});

test('the token is not persisted to browser storage', () => {
  const clientSrc = fs.readFileSync(new URL('../web/api-client.js', import.meta.url), 'utf8');
  // Strip comments first: the file explains *why* localStorage is avoided,
  // and a naive match on the prose fails a file that is actually correct.
  const code = clientSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Writing to or reading from browser storage is forbidden. Clearing it on
  // logout is the opposite of persistence and is required by the privacy
  // requirement, so .clear() is explicitly allowed.
  const persists = /(localStorage|sessionStorage)\s*\.\s*(setItem|getItem)|document\.cookie\s*=/;
  assert.equal(persists.test(code), false, 'the token must stay in memory');
  assert.equal(persists.test(app.replace(/\/\*[\s\S]*?\*\//g, '')), false,
    'the UI must not persist the session either');
  assert.ok(/caches\.delete|localStorage\?\.clear/.test(code),
    'logout must clear any local state for the next person on a shared phone');
});

test('every client path is backed by a route in the API', () => {
  const clientSrc = fs.readFileSync(new URL('../web/api-client.js', import.meta.url), 'utf8');
  const paths = [...clientSrc.matchAll(/request\(\s*[`'"]([^`'"$]+)/g)]
    .map((m) => m[1].replace(/\/$/, ''))
    .filter((p) => p.startsWith('/'));

  const unmatched = paths.filter((p) => {
    const literal = p.split('?')[0];
    // Compare on the first two static segments, which is enough to catch
    // a typo or a removed endpoint without re-implementing a router.
    const seg = literal.split('/').filter(Boolean).slice(0, 2).join('/');
    return !routes.includes(`'/${seg}`) && !routes.includes(`'/${seg.split('/')[0]}/:`);
  });
  assert.deepEqual(unmatched, [], `client calls paths the API does not serve: ${unmatched.join(', ')}`);
});

test('the UI renders loading, error and empty states', () => {
  // A screen that only handles the happy path is how a real deployment
  // becomes a blank rectangle the first time the network hiccups.
  assert.ok(/loading\s*\?/.test(app), 'loading state must be rendered');
  assert.ok(/ErrorBlock/.test(app), 'error state must be rendered');
  assert.ok(/Blank\b/.test(app), 'empty state must be rendered');
  assert.ok(/onRetry/.test(app), 'failed loads must be retryable');
});
