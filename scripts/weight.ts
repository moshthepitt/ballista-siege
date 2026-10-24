import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
const build = spawnSync('pnpm', ['exec', 'vite', 'build', 'play'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const root = resolve('play/dist'), first = new Set<string>(['index.html']);
const local = (ref: string, from: string) => {
  if (/^(data:|https?:|#)/.test(ref)) return null;
  const path = resolve(dirname(resolve(root, from)), ref.split(/[?#]/)[0]);
  if (!path.startsWith(root + '/')) throw new Error(`Asset leaves Pages root: ${ref}`);
  return path.slice(root.length + 1);
};
function add(ref: string, from: string) { const path = local(ref, from); if (path) first.add(path); }
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
  if (tag[0].startsWith('<link') && !/rel="(?:stylesheet|preload|modulepreload)"/.test(tag[0])) continue;
  const ref = /(?:src|href)="([^"]+)"/.exec(tag[0]); if (ref) add(ref[1], 'index.html');
}
for (const from of first) {
  const content = readFileSync(resolve(root, from), 'utf8');
  if (from.endsWith('.html') || from.endsWith('.css')) for (const font of content.matchAll(/url\(\s*["']?([^\s)'";]+)["']?\s*\)/g)) add(font[1], from);
  if (from.endsWith('.js')) for (const item of content.matchAll(/(?:import|export)\s*(?:\{[^}]*\}|\*\s*as\s+\w+)?\s*(?:from\s*)?["']([^"']+)["']/g)) add(item[1], from);
}
const modules = JSON.parse(readFileSync('.tmp/dp1/bundle-modules.json', 'utf8')) as Record<string, string[]>;
for (const [file, sources] of Object.entries(modules)) {
  if (sources.some(p => /(?:zod|ballista-sdk|src\/chain-v1\/(?!wire|run-layout))/.test(p))) throw new Error(`Compiler/template code in ${file}`);
  if (first.has(file) && sources.some(p => /(?:@solana|play\/(?:chain-|wallet|deployment|network(?:-state)?\.ts|rpc-policy)|src\/chain-v1)/.test(p))) throw new Error(`Chain code on first visit: ${file}`);
}
const sizes = (file: string) => ({ file, bytes: readFileSync(resolve(root,file)).length, gzip: gzipSync(readFileSync(resolve(root,file)), { level: 9 }).length });
const initial = [...first].map(sizes), lazy = readdirSync(root).filter(p => p.endsWith('.js') && !first.has(p)).map(sizes);
for (const item of initial) console.log(`first  ${item.file.padEnd(34)} ${String(item.gzip).padStart(7)} gzip bytes`);
for (const item of lazy) console.log(`lazy   ${item.file.padEnd(34)} ${String(item.gzip).padStart(7)} gzip bytes`);
const total = initial.reduce((n, s) => n + s.gzip, 0), lazyTotal = lazy.reduce((n,s) => n+s.gzip,0);
console.log(`First visit: ${initial.length} requests, ${total} gzip bytes. Lazy chain: ${lazyTotal} gzip bytes.`);
console.log(`Target ≤4 / ≤100000; hard ceiling ≤5 / ≤120000. ${initial.length <=4 && total<=100000 ? 'Target met.' : 'Target missed.'}`);
if (initial.length > 5 || total > 120000 || lazyTotal > 40000) process.exitCode = 1;
