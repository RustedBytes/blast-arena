// Builds the client for the browsers in package.json's "browserslist"
// (about 95% of global usage):
// - JavaScript: one bundle per page in static/js/ — main.js (the game),
//   dashboard.js (server monitor) and tilelab.js (Tile Lab) — with newer
//   syntax rewritten for the oldest browsers in the list;
// - CSS: client/style.css minified into static/style.css, with the vendor
//   prefixes and fallbacks those browsers need.
//
//   node scripts/build-client.mjs           production: minified, no source maps
//   node scripts/build-client.mjs --dev     readable, with inline source maps
//   node scripts/build-client.mjs --watch   --dev, rebuilding on every save
//   node scripts/build-client.mjs --targets prints the targets and exits
//
// esbuild only strips the types; `npm run check` is what type-checks.

import { readFileSync, rmSync, watch as watchFiles, writeFileSync } from 'node:fs';
import browserslist from 'browserslist';
import * as esbuild from 'esbuild';
import { browserslistToTargets, transform } from 'lightningcss';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const dev = watch || args.includes('--dev');
const outdir = 'static/js';
const CSS_IN = 'client/style.css';
const CSS_OUT = 'static/style.css';

const browsers = browserslist(undefined, { path: '.' });

// Browsers that run an older Chromium than their own version number says,
// as the Chrome version their engine matches (from caniuse's feature data:
// UC 15.5 has CSS min()/max() and flex gap but not :focus-visible, QQ 14.9
// has neither).
const CHROMIUM_OF = { and_uc: 84, and_qq: 78 };
// browserslist name -> esbuild engine.
const ENGINE = {
  chrome: 'chrome', and_chr: 'chrome', edge: 'edge', firefox: 'firefox', and_ff: 'firefox',
  safari: 'safari', ios_saf: 'ios', opera: 'opera', op_mob: 'chrome', samsung: 'chrome', android: 'chrome',
};
// Samsung Internet and Opera Mobile versions -> the Chrome they're built on (roughly).
const SAMSUNG_CHROME = { 28: 115, 29: 123, 30: 130 };

/** The oldest version per esbuild engine among the target browsers. */
function esbuildTargets() {
  const min = {};
  const add = (engine, version) => {
    if (!(engine in min) || version < min[engine]) min[engine] = version;
  };
  for (const entry of browsers) {
    const [name, range] = entry.split(' ');
    const version = parseFloat(range.split('-')[0]);
    if (name in CHROMIUM_OF) add('chrome', CHROMIUM_OF[name]);
    else if (name === 'samsung') add('chrome', SAMSUNG_CHROME[version] ?? 115);
    else if (name === 'op_mob') add('chrome', version + 33); // Opera Mobile 80 runs Chromium 113
    else if (ENGINE[name]) add(ENGINE[name], version);
    else console.warn(`build-client: no esbuild engine for ${entry}, skipped`);
  }
  return Object.entries(min).map(([engine, v]) => `${engine}${v}`);
}

/** Lightning CSS targets, with UC and QQ counted as the Chrome they run. */
function cssTargets() {
  const list = browsers.map((entry) => {
    const name = entry.split(' ')[0];
    return name in CHROMIUM_OF ? `chrome ${CHROMIUM_OF[name]}` : entry;
  });
  return browserslistToTargets(list);
}

const target = esbuildTargets();

if (args.includes('--targets')) {
  console.log(`browserslist: ${browsers.length} versions, ${browserslist.coverage(browsers).toFixed(1)}% of global usage`);
  console.log(`esbuild: ${target.join(' ')}`);
  process.exit(0);
}

function buildCss() {
  const { code, warnings } = transform({
    filename: CSS_IN,
    code: readFileSync(CSS_IN),
    minify: !dev,
    sourceMap: false,
    targets: cssTargets(),
  });
  for (const w of warnings) console.warn(`${CSS_IN}: ${w.message}`);
  writeFileSync(CSS_OUT, code);
  console.log(`  ${CSS_OUT}  ${(code.length / 1024).toFixed(1)}kb`);
}

// Start clean, so no stale modules from older builds get embedded.
rmSync(outdir, { recursive: true, force: true });

const options = {
  entryPoints: ['client/main.ts', 'client/dashboard.ts', 'client/tilelab.ts'],
  outdir,
  bundle: true,
  format: 'esm',
  target,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
};

buildCss();
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  watchFiles(CSS_IN, () => {
    try { buildCss(); } catch (e) { console.error(e); }
  });
} else {
  await esbuild.build(options);
}
