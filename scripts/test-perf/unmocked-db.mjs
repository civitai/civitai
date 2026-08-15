#!/usr/bin/env node
/**
 * Unit tests that reach a real infrastructure client.
 *
 * A test whose graph reaches `~/server/db/client` (or the redis client) without mocking it does
 * not fail — it opens a real connection and waits for it to time out, which can be seconds PER
 * TEST and looks like a slow test rather than a missing mock. Whether that is deliberate (a
 * fallback path being exercised) or an oversight is a judgement call, so this only lists them.
 *
 *   node scripts/test-perf/unmocked-db.mjs [--client db|redis|clickhouse]
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
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(scan))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    // An in-body `await import()` DOES run in a test file, unlike a `dynamic()` at module scope,
    // so those edges are followed here — the connection it opens is just as real.
    const r = resolveSpecifier(spec, file);
    if (r) internal.add(r);
  }
  const res = { internal: [...internal] };
  cache.set(file, res);
  return res;
}

const CLIENTS = {
  db: 'src/server/db/client.ts',
  redis: 'src/server/redis/client.ts',
  clickhouse: 'src/server/clickhouse/client.ts',
};
const which = process.argv.includes('--client')
  ? process.argv[process.argv.indexOf('--client') + 1]
  : 'db';
const target = norm(path.join(repoRoot, CLIENTS[which] ?? CLIENTS.db));

const inv = JSON.parse(readFileSync(path.join(repoRoot, '.test-perf/inventory.json'), 'utf8'));
const rel = (f) => path.relative(repoRoot, f).replace(/\\/g, '/');

const hits = [];
for (const f of inv.files) {
  const file = norm(path.join(repoRoot, f.file));
  const blocked = new Set();
  for (const m of f.mocks) {
    if (!m.hasFactory || m.importOriginal) continue;
    const r = resolveSpecifier(m.specifier, file);
    if (r) blocked.add(r);
  }
  if (blocked.has(target)) continue;

  const parent = new Map([[file, null]]);
  const q = [file];
  let found = false;
  for (let h = 0; h < q.length && !found; h++) {
    for (const dep of importsOf(q[h]).internal) {
      if (parent.has(dep) || blocked.has(dep)) continue;
      parent.set(dep, q[h]);
      if (dep === target) {
        found = true;
        break;
      }
      q.push(dep);
    }
  }
  if (!found) continue;
  const hops = [];
  for (let c = target; c; c = parent.get(c)) hops.push(rel(c));
  hits.push({ file: f.file, tests: f.tests, hops: hops.reverse() });
}

console.log(`${hits.length} unit test files reach ${CLIENTS[which]} unmocked\n`);
for (const h of hits.sort((a, b) => b.tests - a.tests).slice(0, 40)) {
  console.log(`${String(h.tests).padStart(4)} tests  ${h.file}`);
  console.log(`             via ${h.hops.slice(1, 4).join(' -> ')}`);
}
