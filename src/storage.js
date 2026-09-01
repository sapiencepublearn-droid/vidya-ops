import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ApiError, pool } from './core.js';

/**
 * Two drivers behind one interface.
 *
 *   disk — a real filesystem. Correct when the host gives you one.
 *   db   — bytes in Postgres. Needed on free hosting, which has no
 *          persistent disk and would wipe every upload on restart.
 *
 * Swapping is one environment variable; nothing else in the app changes.
 */
const DRIVER = process.env.STORAGE_DRIVER || 'disk';

/**
 * Local-disk driver behind an S3-shaped interface. Swapping to S3 or
 * MinIO later means replacing these three functions and nothing else.
 * Files are never written under a client-supplied name or path.
 */
export async function putObject(key, buffer) {
  if (DRIVER === 'db') {
    // A plain INSERT, not an upsert. Storage keys are random UUIDs, so a
    // collision means something is wrong and should surface rather than
    // silently overwrite. It also lets the app role keep INSERT without
    // UPDATE, which makes uploaded evidence immutable once written.
    await pool.query(`INSERT INTO file_blobs (storage_key, bytes) VALUES ($1,$2)`, [key, buffer]);
    return key;
  }
  const abs = resolveKey(key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer, { mode: 0o640 });
  return key;
}

export async function getObject(key) {
  if (DRIVER === 'db') {
    const { rows } = await pool.query(`SELECT bytes FROM file_blobs WHERE storage_key=$1`, [key]);
    if (!rows[0]) throw new ApiError(404, 'file_missing', 'That file is no longer stored.');
    return rows[0].bytes;
  }
  return fs.readFile(resolveKey(key));
}

export async function deleteObject(key) {
  if (DRIVER === 'db') {
    await pool.query(`DELETE FROM file_blobs WHERE storage_key=$1`, [key]);
    return;
  }
  await fs.rm(resolveKey(key), { force: true });
}

function resolveKey(key) {
  const root = path.resolve(config.storageDir);
  const abs = path.resolve(root, key);
  // Defeats ../ traversal in a storage key.
  if (!abs.startsWith(root + path.sep)) throw new ApiError(400, 'bad_key', 'Invalid storage key.');
  return abs;
}

/* ────────────────────────────────────── content-based type validation */

const SIGNATURES = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  // OOXML is a zip container; the sniff confirms zip, the extension picks the flavour.
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', test: isZip },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', test: isZip },
];
function isZip(b) { return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7); }

/** Rejects anything whose bytes disagree with its extension. */
export function sniff(buffer, originalName) {
  if (!buffer?.length) throw new ApiError(422, 'empty_file', 'That file is empty.');
  const ext = path.extname(originalName || '').toLowerCase().replace('.', '');
  const match = SIGNATURES.find((s) => s.test(buffer));
  if (!match) {
    throw new ApiError(415, 'unsupported_file',
      'Only PDF, JPEG, PNG, WebP, XLSX and DOCX files are accepted.');
  }
  const extAllowed = SIGNATURES.filter((s) => s.test(buffer)).map((s) => s.ext);
  if (ext && !extAllowed.includes(ext === 'jpeg' ? 'jpg' : ext)) {
    throw new ApiError(415, 'extension_mismatch',
      `The file contents do not match a .${ext} file.`);
  }
  return match.mime;
}

/** Strips directories and control characters from a display filename. */
export function safeName(original) {
  const base = path.basename(String(original || 'file'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').slice(0, 120);
  return cleaned || 'file';
}

export const storageKey = (employeeId) =>
  `${employeeId}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ──────────────────────────────────────────────────────── signed URLs */

/**
 * Short-lived HMAC token. The download route still re-checks ownership
 * against the database, so a leaked link cannot outlive the permission.
 */
export function signDownload(attachmentId, employeeId, ttlSeconds = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${attachmentId}.${employeeId}.${exp}`;
  const sig = crypto.createHmac('sha256', config.fileSecret).update(payload).digest('base64url');
  return { exp, sig };
}

export function verifyDownload(attachmentId, employeeId, exp, sig) {
  if (!exp || !sig || Number(exp) < Math.floor(Date.now() / 1000)) {
    throw new ApiError(403, 'link_expired', 'That download link has expired.');
  }
  const expected = crypto
    .createHmac('sha256', config.fileSecret)
    .update(`${attachmentId}.${employeeId}.${exp}`)
    .digest('base64url');
  const a = Buffer.from(expected), b = Buffer.from(String(sig));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(403, 'bad_signature', 'That download link is not valid.');
  }
}
