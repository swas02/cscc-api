// Minify src/index.js -> dist/index.js and print sizes + the SRI hash to use in <script integrity="...">.
import { transform } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const src = readFileSync('src/index.js', 'utf8');
const { code } = await transform(src, { minify: true, target: 'es2018', legalComments: 'inline' });
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', code);
mkdirSync('site/v1', { recursive: true });
writeFileSync('site/v1/index.js', code);

const kb = (n) => (n / 1024).toFixed(2) + ' KB';
const sri = 'sha384-' + createHash('sha384').update(code).digest('base64');
console.log(`source   ${kb(Buffer.byteLength(src))}`);
console.log(`minified ${kb(Buffer.byteLength(code))}  (gzip ${kb(gzipSync(code, { level: 9 }).length)})`);
console.log(`SRI      ${sri}`);
