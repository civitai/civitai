#!/usr/bin/env node
/**
 * Which EXTERNAL packages the unit suite's module registry actually reaches.
 *
 * Externalised deps are loaded natively and cached per worker process, so unlike first-party
 * modules they are not a per-FILE cost — but under `isolate: false` every worker still pays
 * each one once, which is part of the registry-build floor. Same two corrections as
 * `cuts.mjs union-real`: `vi.mock` factories cut a subtree, and `import()` is lazy.
 *
 *   node scripts/test-perf/externals.mjs [--top N]
 *   node scripts/test-perf/externals.mjs --why @mantine/core
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../..'
);
const SRC_DIRS = ['src', 'scripts', 'packages'];
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
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist' || e.name === '.git')
      continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = SRC_DIRS.flatMap((d) => walk(path.join(repoRoot, d)));
const fileSet = new Set(files.map(norm));

function tryFile(base) {
  const b = norm(base);
  for (const e of EXT) if (fileSet.has(b + e)) return b + e;
  if (fileSet.has(b)) {
    try {
      if (statSync(b).isFile()) return b;
    } catch {}
  }
  for (const e of EXT) if (fileSet.has(`${b}/index${e}`)) return `${b}/index${e}`;
  return null;
}

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('~/')) return tryFile(path.join(repoRoot, 'src', spec.slice(2)));
  if (spec.startsWith('@civitai/')) {
    const rest = spec.slice('@civitai/'.length);
    const [pkg, ...sub] = rest.split('/');
    const base = path.join(repoRoot, 'packages', `civitai-${pkg}`, 'src');
    return tryFile(sub.length ? path.join(base, sub.join('/')) : path.join(base, 'index'));
  }
  if (spec.startsWith('.')) return tryFile(path.resolve(path.dirname(fromFile), spec));
  return null;
}

const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;

const cache = new Map();
function importsOf(file) {
  if (cache.has(file)) return cache.get(file);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  const scan = text
    .split('\n')
    .filter((l) => !/^\s*import\s+type\s/.test(l) && !/^\s*export\s+type\s/.test(l))
    .join('\n');
  const internal = new Set();
  const external = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(scan))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (m[2] !== undefined && !process.env.COUNT_DYNAMIC) {
      if (!/require/.test(scan.slice(Math.max(0, m.index), m.index + 12))) continue;
    }
    const r = resolveSpecifier(spec, file);
    if (r) internal.add(r);
    else if (!spec.startsWith('.') && !spec.startsWith('~') && !spec.startsWith('node:'))
      external.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
  }
  const res = { internal: [...internal], external: [...external] };
  cache.set(file, res);
  return res;
}

const inv = JSON.parse(readFileSync(path.join(repoRoot, '.test-perf/inventory.json'), 'utf8'));
const unitTests = inv.files.map((f) => norm(path.join(repoRoot, f.file)));
const blockedFor = new Map();
for (const f of inv.files) {
  const file = norm(path.join(repoRoot, f.file));
  const blocked = new Set();
  for (const m of f.mocks) {
    if (!m.hasFactory || m.importOriginal) continue;
    const r = resolveSpecifier(m.specifier, file);
    if (r) blocked.add(r);
  }
  blockedFor.set(file, blocked);
}

const rel = (f) => path.relative(repoRoot, f).replace(/\\/g, '/');
const args = process.argv.slice(2);
const topArg = args.indexOf('--top');
const TOP = topArg >= 0 ? Number(args[topArg + 1]) : 40;
const whyArg = args.indexOf('--why');

/** BFS from one test, honouring its mocks; returns reached first-party set + parent map. */
function walkTest(root) {
  const blocked = blockedFor.get(root) ?? new Set();
  const parent = new Map([[root, null]]);
  const q = [root];
  const externals = new Map();
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const own = importsOf(cur);
    for (const e of own.external) if (!externals.has(e)) externals.set(e, cur);
    for (const dep of own.internal) {
      if (parent.has(dep) || blocked.has(dep)) continue;
      parent.set(dep, cur);
      q.push(dep);
    }
  }
  return { parent, externals };
}

if (whyArg >= 0) {
  const target = args[whyArg + 1];
  let shown = 0;
  for (const t of unitTests) {
    const { parent, externals } = walkTest(t);
    const via = externals.get(target);
    if (!via) continue;
    const hops = [];
    for (let c = via; c; c = parent.get(c)) hops.push(rel(c));
    console.log(`\n${hops.reverse().join('\n  -> ')}\n  -> ${target}`);
    if (++shown >= 3) break;
  }
  if (!shown) console.log(`${target} is not reached by any unit test`);
} else {
  const fanIn = new Map();
  for (const t of unitTests) {
    for (const e of walkTest(t).externals.keys()) fanIn.set(e, (fanIn.get(e) ?? 0) + 1);
  }
  const rows = [...fanIn.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`${rows.length} external packages reached by the unit suite (mocks + lazy honoured)`);
  for (const [pkg, n] of rows.slice(0, TOP)) console.log(`  ${String(n).padStart(4)}  ${pkg}`);
}
