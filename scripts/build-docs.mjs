import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { minify } from 'html-minifier-terser';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'docs', 'index.source.html');
const OUT = resolve(here, '..', 'docs', 'index.html');

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

const [srcSize, outSize] = await Promise.all([
  stat(SRC).then((s) => s.size),
  stat(OUT).then((s) => s.size),
]);
const pct = ((1 - outSize / srcSize) * 100).toFixed(1);
console.log(`docs/index.source.html  ${srcSize.toLocaleString()} B`);
console.log(`docs/index.html         ${outSize.toLocaleString()} B  (-${pct}%)`);
