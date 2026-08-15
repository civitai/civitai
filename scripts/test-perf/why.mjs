#!/usr/bin/env node
/**
 * Why does <file> import <target>?
 *
 *   node scripts/test-perf/why.mjs src/server/__tests__/x.test.ts @mantine/core
 *   node scripts/test-perf/why.mjs src/server/__tests__/x.test.ts ~/server/services/image.service
 *   node scripts/test-perf/why.mjs src/server/__tests__/x.test.ts --ui
 *
 * Prints the SHORTEST import path, which is the edge to argue about. `--ui` looks for the first
 * browser-only package reached from a server-side test, which is the usual accident.
 *
 * Static, so it does not know that a `vi.mock` factory would stop the real module executing — use
 * the tracer for that. It is still the right tool for finding the edge to cut.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'];
const norm = (p) => p.replace(/\\/g, '/');

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (['node_modules', '.next', 'dist', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.includes(path.extname(e.name))) out.push(norm(p));
  }
  return out;
}

const fileSet = new Set(['src', 'scripts', 'packages'].flatMap((d) => walk(path.join(repoRoot, d))));

function tryFile(base) {
  const b = norm(base);
  for (const e of EXT) if (fileSet.has(b + e)) return b + e;
  if (fileSet.has(b)) return b;
  for (const e of EXT) if (fileSet.has(`${b}/index${e}`)) return `${b}/index${e}`;
  return null;
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('~/')) return tryFile(path.join(repoRoot, 'src', spec.slice(2)));
  if (spec.startsWith('@civitai/')) {
    const [pkg, ...sub] = spec.slice('@civitai/'.length).split('/');
    const base = path.join(repoRoot, 'packages', `civitai-${pkg}`, 'src');
    return tryFile(sub.length ? path.join(base, sub.join('/')) : path.join(base, 'index'));
  }
  if (spec.startsWith('.')) return tryFile(path.resolve(path.dirname(fromFile), spec));
  return null;
}

const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;

const edgeCache = new Map();
function edges(file) {
  if (edgeCache.has(file)) return edgeCache.get(file);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  const lines = text
    .split('\n')
    .filter((l) => !/^\s*import\s+type\s/.test(l) && !/^\s*export\s+type\s/.test(l));
  const scan = lines.join('\n');
  const out = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(scan))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    const resolved = resolveSpecifier(spec, file);
    out.push({ spec, resolved });
  }
  edgeCache.set(file, out);
  return out;
}

const UI_PACKAGES = [
  '@mantine/', '@dnd-kit/', '@tabler/icons-react', 'react-dom', '@tiptap/', 'chart.js',
  '@grafana/faro-web-sdk', 'embla-carousel', 'framer-motion', 'react-easy-crop', '@hello-pangea/',
  'next/router', 'next/image', 'react-hook-form', '@mantine/core',
];

const [rawStart, rawTarget] = process.argv.slice(2);
if (!rawStart || !rawTarget) {
  console.error('usage: why.mjs <test-or-source-file> <target specifier | --ui>');
  process.exit(2);
}
const start = tryFile(path.resolve(repoRoot, rawStart)) ?? norm(path.resolve(repoRoot, rawStart));

const wantUi = rawTarget === '--ui';
const targetResolved = wantUi ? null : resolveSpecifier(rawTarget, start);

// BFS keeps the path SHORTEST, which is the one worth arguing about: a long path usually means a
// legitimate chain, a short one usually means a single wrong import.
const prev = new Map([[start, null]]);
const queue = [start];
let hit = null;
let hitSpec = null;
while (queue.length && !hit) {
  const cur = queue.shift();
  for (const { spec, resolved } of edges(cur)) {
    if (wantUi) {
      if (UI_PACKAGES.some((p) => spec.startsWith(p))) {
        hit = cur;
        hitSpec = spec;
        break;
      }
    } else if (resolved && targetResolved && resolved === targetResolved) {
      hit = resolved;
      prev.set(resolved, cur);
      break;
    } else if (!targetResolved && spec === rawTarget) {
      hit = cur;
      hitSpec = spec;
      break;
    }
    if (resolved && !prev.has(resolved)) {
      prev.set(resolved, cur);
      queue.push(resolved);
    }
  }
}

if (!hit) {
  console.log(`no path from ${rawStart} to ${rawTarget}`);
  process.exit(1);
}

const chain = [];
for (let n = hit; n != null; n = prev.get(n)) chain.push(path.relative(repoRoot, n).replace(/\\/g, '/'));
chain.reverse();
console.log(`shortest path (${chain.length} hops):\n`);
chain.forEach((c, i) => console.log(`${'  '.repeat(i > 6 ? 6 : i)}${i === 0 ? '' : '-> '}${c}`));
if (hitSpec) console.log(`${'  '.repeat(Math.min(chain.length, 6))}-> ${hitSpec}   <-- target`);
