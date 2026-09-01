#!/usr/bin/env node
/**
 * Generates every icon the app needs from one logo file.
 *
 *   node scripts/make-icons.mjs path/to/logo.png
 *
 * Accepts PNG, JPG, WEBP or SVG. Square works best; anything else is
 * padded rather than stretched, because a squashed logo looks careless
 * on a home screen.
 *
 * Two variants are produced:
 *   - "any": the logo on your background colour, edge to edge
 *   - "maskable": the same logo inset to 60%, because Android crops icons
 *     into circles and squircles and will cut the corners off otherwise
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const src = process.argv[2];
const BG = process.argv[3] || '#ffffff';
// Vite copies web/public verbatim into the build, so icons belong there.
const OUT = path.resolve(process.cwd(), 'web', 'public');

if (!src) {
  console.error('Usage: node scripts/make-icons.mjs <logo-file> [background-hex]');
  console.error('Example: node scripts/make-icons.mjs logo.png "#ffffff"');
  process.exit(1);
}

const hexToRgb = (h) => {
  const v = h.replace('#', '');
  const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
};

async function build() {
  await fs.access(src).catch(() => {
    console.error(`Cannot find ${src}`);
    process.exit(1);
  });

  const meta = await sharp(src).metadata();
  console.log(`source: ${meta.width}x${meta.height} ${meta.format}`);
  if (Math.abs(meta.width - meta.height) > Math.max(meta.width, meta.height) * 0.15) {
    console.log('note: logo is not square, so it will be padded to fit rather than stretched');
  }
  if (Math.min(meta.width, meta.height) < 512 && meta.format !== 'svg') {
    console.log('warning: smaller than 512px, so the large icon may look soft. An SVG or bigger PNG is better.');
  }

  const background = hexToRgb(BG);

  const make = async (size, inset, file) => {
    const logo = await sharp(src)
      .resize(Math.round(size * inset), Math.round(size * inset), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background } })
      .composite([{ input: logo, gravity: 'centre' }])
      .png()
      .toFile(path.join(OUT, file));
    console.log(`wrote web/${file}`);
  };

  await make(192, 0.82, 'icon-192.png');
  await make(512, 0.82, 'icon-512.png');
  await make(512, 0.60, 'icon-maskable-512.png');  // safe zone for Android cropping
  await make(180, 0.82, 'apple-touch-icon.png');   // iOS home screen
  await make(64, 0.82, 'favicon.png');             // browser tab

  // The in-app logo keeps transparency so it sits on either theme.
  await sharp(src).resize(240, 240, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(path.join(OUT, 'logo.png'));
  console.log('wrote web/logo.png');

  const manifestPath = path.join(OUT, 'manifest.webmanifest');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.background_color = BG;
  manifest.theme_color = BG;
  manifest.icons = [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('updated web/manifest.webmanifest');

  console.log('\nDone. Rebuild with:  npm run web:build');
}

build().catch((e) => { console.error(e.message); process.exit(1); });
