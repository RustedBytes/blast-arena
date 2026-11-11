// Bundles the TypeScript client into one file per page in static/js/:
// main.js (the game), dashboard.js (server monitor) and tilelab.js (Tile Lab).
//
//   node scripts/build-client.mjs           production: minified, no source maps
//   node scripts/build-client.mjs --dev     readable, with inline source maps
//   node scripts/build-client.mjs --watch   --dev, rebuilding on every save
//
// esbuild only strips the types; `npm run check` is what type-checks.

import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const outdir = 'static/js';

// Start clean, so no stale modules from older builds get embedded.
rmSync(outdir, { recursive: true, force: true });

const options = {
  entryPoints: ['client/main.ts', 'client/dashboard.ts', 'client/tilelab.ts'],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
