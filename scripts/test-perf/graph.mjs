#!/usr/bin/env node
/**
 * Static import-graph + mock inventory for the unit suite.
 *
 * Answers the two questions the suite's cost hangs on: how many first-party modules each test
 * file drags in, and which shared modules it mocks. Both come from source text, so this runs in
 * seconds and does not compete with a benchmark run for CPU.
 *
 * Output: .test-perf/inventory.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { readdirSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');

const SRC_DIRS = ['src', 'scripts', 'packages'];
const EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = SRC_DIRS.flatMap((d) => walk(path.join(repoRoot, d)));
const fileSet = new Set(files.map((f) => f.replace(/\\/g, '/')));

const norm = (p) => p.replace(/\\/g, '/');

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('~/')) return tryFile(path.join(repoRoot, 'src', spec.slice(2)));
  if (spec.startsWith('@civitai/')) {
    const rest = spec.slice('@civitai/'.length);
    const [pkg, ...sub] = rest.split('/');
    const base = path.join(repoRoot, 'packages', `civitai-${pkg}`, 'src');
    return tryFile(sub.length ? path.join(base, sub.join('/')) : path.join(base, 'index'));
  }
  if (spec.startsWith('.')) return tryFile(path.resolve(path.dirname(fromFile), spec));
  return null; // external package
}

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

const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;
const TYPE_ONLY_RE = /(?:^|\n)\s*import\s+type\s/;

/** Imports of a file, split into first-party edges and external package names. */
const cache = new Map();
function importsOf(file) {
  if (cache.has(file)) return cache.get(file);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  const internal = new Set();
  const external = new Set();
  // Strip `import type` lines: they are erased by the transform and cost nothing at runtime.
  const lines = text.split('\n').filter((l) => !/^\s*import\s+type\s/.test(l) && !/^\s*export\s+type\s/.test(l));
  const scan = lines.join('\n');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(scan))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    const resolved = resolveSpecifier(spec, file);
    if (resolved) internal.add(resolved);
    else if (!spec.startsWith('.') && !spec.startsWith('~') && !spec.startsWith('node:')) {
      external.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
    }
  }
  const res = { internal: [...internal], external: [...external], bytes: Buffer.byteLength(text) };
  cache.set(file, res);
  return res;
}

/**
 * Transitive first-party closure by iterative BFS.
 *
 * Deliberately not recursive-with-memo: the graph has cycles, so a memo keyed on "fully
 * resolved" never fills and the recursion degenerates to exponential re-walks.
 */
const closureCache = new Map();
function closure(file) {
  const hit = closureCache.get(file);
  if (hit) return hit;
  const internal = new Set([file]);
  const external = new Set();
  const queue = [file];
  let bytes = 0;
  while (queue.length) {
    const cur = queue.pop();
    const own = importsOf(cur);
    bytes += own.bytes;
    for (const x of own.external) external.add(x);
    for (const dep of own.internal) {
      if (!internal.has(dep)) {
        internal.add(dep);
        queue.push(dep);
      }
    }
  }
  const res = { internal, external, bytes };
  closureCache.set(file, res);
  return res;
}

// ---- mock inventory -------------------------------------------------------
const VI_MOCK_RE = /vi\.(mock|doMock)\s*\(\s*['"]([^'"]+)['"]\s*(,)?/g;

function mockInventory(text) {
  const mocks = [];
  let m;
  VI_MOCK_RE.lastIndex = 0;
  while ((m = VI_MOCK_RE.exec(text))) {
    const spec = m[2];
    const hasFactory = !!m[3];
    // Look ahead a bounded window for importOriginal in this factory.
    const window = text.slice(m.index, m.index + 400);
    mocks.push({
      specifier: spec,
      hasFactory,
      importOriginal: /importOriginal/.test(window),
    });
  }
  return mocks;
}

const unitTests = files
  .map(norm)
  .filter((f) => /\.test\.ts$/.test(f) && (f.includes('/src/') || f.includes('/scripts/')))
  .filter((f) => !f.includes('/packages/'));

const records = unitTests.map((file) => {
  const text = readFileSync(file, 'utf8');
  const c = closure(file);
  const mocks = mockInventory(text);
  return {
    file: path.relative(repoRoot, file).replace(/\\/g, '/'),
    bytes: Buffer.byteLength(text),
    tests: (text.match(/^\s*(?:it|test)(?:\.\w+)*\s*\(/gm) || []).length,
    graphModules: c.internal.size,
    graphBytes: c.bytes,
    externals: [...c.external].sort(),
    externalCount: c.external.size,
    mocks,
    mockCount: mocks.length,
    partialMocks: mocks.filter((m) => m.hasFactory && !m.importOriginal).length,
  };
});

// Which first-party modules appear in the most test-file closures? Those are the ones whose
// import cost is paid over and over under isolation.
const moduleFanIn = new Map();
for (const file of unitTests) {
  for (const mod of closure(file).internal) {
    moduleFanIn.set(mod, (moduleFanIn.get(mod) ?? 0) + 1);
  }
}
const externalFanIn = new Map();
for (const file of unitTests) {
  for (const ext of closure(file).external) externalFanIn.set(ext, (externalFanIn.get(ext) ?? 0) + 1);
}

const mockFanIn = new Map();
for (const r of records) {
  for (const m of r.mocks) {
    const e = mockFanIn.get(m.specifier) ?? { specifier: m.specifier, sites: 0, files: 0, partial: 0 };
    e.sites++;
    if (m.hasFactory && !m.importOriginal) e.partial++;
    mockFanIn.set(m.specifier, e);
  }
}
for (const r of records) {
  for (const spec of new Set(r.mocks.map((m) => m.specifier))) mockFanIn.get(spec).files++;
}

const out = {
  generatedAt: new Date().toISOString(),
  repoHead: process.env.TESTPERF_HEAD ?? null,
  totals: {
    testFiles: records.length,
    tests: records.reduce((a, r) => a + r.tests, 0),
    mockSites: records.reduce((a, r) => a + r.mockCount, 0),
    filesWithMocks: records.filter((r) => r.mockCount > 0).length,
    partialMockSites: records.reduce((a, r) => a + r.partialMocks, 0),
    medianGraphModules: median(records.map((r) => r.graphModules)),
    maxGraphModules: Math.max(...records.map((r) => r.graphModules)),
  },
  files: records.sort((a, b) => b.graphModules - a.graphModules),
  heaviestModules: [...moduleFanIn.entries()]
    .map(([mod, n]) => ({ module: path.relative(repoRoot, mod).replace(/\\/g, '/'), inClosures: n, ownBytes: importsOf(mod).bytes }))
    .sort((a, b) => b.inClosures - a.inClosures)
    .slice(0, 150),
  heaviestExternals: [...externalFanIn.entries()]
    .map(([pkg, n]) => ({ pkg, inClosures: n }))
    .sort((a, b) => b.inClosures - a.inClosures)
    .slice(0, 80),
  mockedModules: [...mockFanIn.values()].sort((a, b) => b.sites - a.sites),
};

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

mkdirSync(path.join(repoRoot, '.test-perf'), { recursive: true });
writeFileSync(path.join(repoRoot, '.test-perf/inventory.json'), JSON.stringify(out, null, 2));
console.log(
  `${out.totals.testFiles} unit test files, ${out.totals.tests} tests, ${out.totals.mockSites} vi.mock sites`
);
console.log(`median closure ${out.totals.medianGraphModules} modules, max ${out.totals.maxGraphModules}`);
console.log('top mocked:', out.mockedModules.slice(0, 8).map((m) => `${m.specifier}(${m.sites})`).join(' '));
