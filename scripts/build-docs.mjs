import { readFile, writeFile, stat, rm, mkdir, cp, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { minify } from 'html-minifier-terser';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SRC_DIR = resolve(ROOT, 'docs');
const SRC = join(SRC_DIR, 'index.html');
const OUT_DIR = resolve(ROOT, 'dist');
const OUT = join(OUT_DIR, 'index.html');

const isServe = process.argv.includes('--serve');

if (isServe) {
  // Dev server: serves the HTML entry through Bun's bundler, which injects
  // the HMR runtime so edits to docs/index.html hot-reload.
  // The fetch fallback serves the rest of docs/ verbatim (images, videos, etc.).
  const index = await import('../docs/index.html');
  const port = Number(process.env.PORT ?? 5173);
  Bun.serve({
    port,
    development: { hmr: true },
    routes: {
      '/': index.default,
    },
    async fetch(req) {
      const url = new URL(req.url);
      const filePath = join(SRC_DIR, url.pathname);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return new Response(Bun.file(filePath));
      }
      return new Response('Not found', { status: 404 });
    },
  });
  console.log(`docs → http://localhost:${port}`);
} else {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const source = await readFile(SRC, 'utf8');

  const minified = await minify(source, {
    collapseWhitespace: true,
    conservativeCollapse: false,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    minifyCSS: true,
    minifyJS: true,
    decodeEntities: true,
    sortAttributes: true,
    sortClassName: true,
  });

  await writeFile(OUT, minified);

  // Mirror everything else under docs/ into dist/ — images, videos, CNAME, etc.
  // The HTML entry is handled above via minify; skip it here.
  const SKIP = new Set(['index.html']);
  for (const entry of await readdir(SRC_DIR, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    await cp(join(SRC_DIR, entry.name), join(OUT_DIR, entry.name), {
      recursive: true,
    });
  }

  // .nojekyll tells GitHub Pages to skip Jekyll processing so files / folders
  // starting with underscores are served verbatim.
  await writeFile(join(OUT_DIR, '.nojekyll'), '');

  const [srcSize, outSize] = await Promise.all([
    stat(SRC).then((s) => s.size),
    stat(OUT).then((s) => s.size),
  ]);
  const pct = ((1 - outSize / srcSize) * 100).toFixed(1);
  console.log(`docs/index.html  ${srcSize.toLocaleString()} B`);
  console.log(`dist/index.html  ${outSize.toLocaleString()} B  (-${pct}%)`);
}
