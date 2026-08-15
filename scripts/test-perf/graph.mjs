#!/usr/bin/env node
/**
 * Static import-graph + mock inventory for the unit suite.
 *
 * Answers the two questions the suite's cost hangs on: how many first-party modules each test
 * file drags in, and which shared modules it mocks. Both come from source text, so this runs in
 * seconds and does not compete with a benchmark run for CPU.
 *
 * Output: .test-perf/inventory.json, .test-perf/closures.json
 *
 * 🔴 `graphModules` is what a worker really loads: lazy `import()` edges are NOT followed and a
 * `vi.mock` factory without `importOriginal` truncates the subtree behind it. A graph that follows
 * both overstates a page-render test by ~75x — four `src/tests/pages/apps/**` files measured 13-26
 * modules against a naive 1,655-1,670, which put them at the top of a ranking where their MEASURED
 * worker time ranks 202-572 of 1,065. The naive count is still emitted as `graphModulesRaw` for the
 * bundler question ("is this chunk compiled"), which is a different question from "what does a
 * worker's registry cost". Do not rank test cost by it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { readdirSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../..'
);

// `event-engine-common` is a submodule, imported by relative path from `src/server/services`. Left
// out, its 21 modules are invisible — and so are the `packages/civitai-db-queries` files reached
// only through it. A worktree without the submodule checked out just walks an empty directory.
const SRC_DIRS = ['src', 'scripts', 'packages', 'event-engine-common'];
const EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'];

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

/**
 * Whole `import type ... from '...'` / `export type ... from '...'` statements.
 *
 * 🔴 The gap is a TEMPERED match, not `[\s\S]*?`, and that is the whole correctness of it. With a
 * plain lazy gap the pattern also starts on a bodyless `export type X = ...` and then scans forward
 * across the file to the next `from '...'`-shaped text — including inside comments and strings —
 * deleting every statement in between before the import scanner sees them. Measured over 5,239
 * files: 40 affected, 331 statements consumed; `src/server/common/enums.ts` lost a real
 * `@civitai/notifications/constants` edge across a 7,881-character span. Direction is UNDER-count,
 * and `graphModules` is the ranking key for the dashboard, `order.mjs` and `bench.mjs`.
 *
 * Between `type` and `from` a real type-import statement contains only a binding clause, so the gap
 * may not cross `;`, `=`, or another `import`/`export` keyword. Each of those alone would have
 * caught the enums.ts case; all three are cheap.
 */
const TYPE_STATEMENT_RE =
  /(^|\n)[ \t]*(?:import|export)[ \t]+type[ \t\r\n]+(?:(?!\b(?:import|export)\b)[^;=])*?from[ \t]*['"][^'"]+['"][ \t]*;?/g;
const stripTypeStatements = (text) => text.replace(TYPE_STATEMENT_RE, '$1');

/**
 * True when every binding in an import/export statement carries the inline `type` modifier, so the
 * transform erases the statement and the module is never fetched.
 *
 * `import type { X } from` is handled by `stripTypeStatements` above; `import { type X } from` is
 * not, and it is the common shape in this repo. Missing it over-counted `FeatureFlagsProvider` by 8
 * modules — the whole `feature-flags.service` subtree — on two of the five files with traced
 * ground truth.
 */
function isTypeOnlyStatement(stmt) {
  const brace = stmt.match(/\{([^}]*)\}/);
  if (!brace) return false;
  // A default or namespace binding ahead of the brace is a value import regardless.
  const before = stmt.slice(0, stmt.indexOf('{'));
  if (/(?:import|export)\s+(?:[A-Za-z_$][\w$]*|\*\s+as\s+[A-Za-z_$][\w$]*)\s*,/.test(before))
    return false;
  const parts = brace[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^type\s/.test(p));
}

const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^.\w])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*export\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;

/**
 * Imports of a file, split into first-party edges and external package names.
 *
 * `eager` drops lazy `import()` — under vitest the module is never fetched unless the call runs,
 * and `dynamic(() => import(...))` at module scope never does — while keeping `require()`, which
 * is eager. `raw` keeps everything, which is the bundler view.
 */
const cache = new Map();
function importsOf(file, mode = 'eager') {
  const key = mode + '\0' + file;
  if (cache.has(key)) return cache.get(key);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  const internal = new Set();
  const external = new Set();
  // Strip whole `import type ... from '...'` STATEMENTS, not lines. A line filter leaves the tail
  // of a multi-line one behind, and the lazy `[\s\S]*?` in IMPORT_RE then glues that orphan
  // `} from '...'` onto the previous import — inventing an edge to a type-only module.
  const scan = stripTypeStatements(text);
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(scan))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (m[2] !== undefined && mode === 'eager') {
      const call = scan.slice(Math.max(0, m.index), m.index + 12);
      if (!/require/.test(call)) continue;
    }
    if (m[2] === undefined && isTypeOnlyStatement(m[0])) continue;
    const resolved = resolveSpecifier(spec, file);
    if (resolved) internal.add(resolved);
    else if (!spec.startsWith('.') && !spec.startsWith('~') && !spec.startsWith('node:')) {
      external.add(
        spec
          .split('/')
          .slice(0, spec.startsWith('@') ? 2 : 1)
          .join('/')
      );
    }
  }
  const res = { internal: [...internal], external: [...external], bytes: Buffer.byteLength(text) };
  cache.set(key, res);
  return res;
}

/** Specifiers a test file's own `vi.mock` factories stop from being fetched. */
function blockedSet(file, mocks) {
  const blockedInternal = new Set();
  const blockedExternal = new Set();
  for (const mk of mocks) {
    if (!mk.hasFactory || mk.importOriginal) continue;
    const r = resolveSpecifier(mk.specifier, file);
    if (r) blockedInternal.add(r);
    else if (!mk.specifier.startsWith('.') && !mk.specifier.startsWith('~'))
      blockedExternal.add(
        mk.specifier
          .split('/')
          .slice(0, mk.specifier.startsWith('@') ? 2 : 1)
          .join('/')
      );
  }
  return { blockedInternal, blockedExternal };
}

/**
 * What a worker actually loads for one test file.
 *
 * A mocked module is still TRANSFORMED (vitest resolves it), so it is counted; what it imports is
 * not, so the traversal stops there. Verified against a transform-hook trace of
 * `review-detail-page-gate.test.ts`: 20 modules by this walk, 22 transformed, the two extra being
 * the setup files — which every file pays and which are reported separately as `setupClosure`.
 *
 * ⚠️ The ROOT's lazy edges ARE followed, every other module's are not. A `dynamic(() => import())`
 * in a page never runs; an `await import()` in a test body is the point of the test and always
 * does. Collapsing the two is what made the four `src/tests/pages/apps/**` files look like a
 * ceiling in one direction and vanish entirely in the other. Upper bound, in that a test-body
 * import inside a branch that never executes is still counted.
 */
function realClosure(file, mocks) {
  const { blockedInternal, blockedExternal } = blockedSet(file, mocks);
  // Registering a mock resolves and transforms the target whether or not anything imports it,
  // so a mocked module is in the set even when the only path to it runs through another mock.
  const internal = new Set([file, ...blockedInternal]);
  const external = new Set();
  const queue = [file];
  let bytes = 0;
  while (queue.length) {
    const cur = queue.pop();
    const own = importsOf(cur, cur === file ? 'raw' : 'eager');
    bytes += own.bytes;
    for (const x of own.external) if (!blockedExternal.has(x)) external.add(x);
    for (const dep of own.internal) {
      if (internal.has(dep)) continue;
      internal.add(dep);
      // Counted, but not walked through: the factory replaced its exports.
      if (!blockedInternal.has(dep)) queue.push(dep);
    }
  }
  for (const x of blockedExternal) external.delete(x);
  return { internal, external, bytes };
}

/**
 * Transitive first-party closure by iterative BFS.
 *
 * Deliberately not recursive-with-memo: the graph has cycles, so a memo keyed on "fully
 * resolved" never fills and the recursion degenerates to exponential re-walks.
 */
const closureCache = new Map();
function closure(file, mode = 'raw') {
  const key = mode + '\0' + file;
  const hit = closureCache.get(key);
  if (hit) return hit;
  const internal = new Set([file]);
  const external = new Set();
  const queue = [file];
  let bytes = 0;
  while (queue.length) {
    const cur = queue.pop();
    const own = importsOf(cur, mode);
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
  closureCache.set(key, res);
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

const realClosures = new Map();
const records = unitTests.map((file) => {
  const text = readFileSync(file, 'utf8');
  const mocks = mockInventory(text);
  const real = realClosure(file, mocks);
  const raw = closure(file, 'raw');
  realClosures.set(file, real);
  return {
    file: path.relative(repoRoot, file).replace(/\\/g, '/'),
    bytes: Buffer.byteLength(text),
    tests: (text.match(/^\s*(?:it|test)(?:\.\w+)*\s*\(/gm) || []).length,
    graphModules: real.internal.size,
    graphModulesRaw: raw.internal.size,
    graphBytes: real.bytes,
    externals: [...real.external].sort(),
    externalCount: real.external.size,
    externalCountRaw: raw.external.size,
    mocks,
    mockCount: mocks.length,
    partialMocks: mocks.filter((m) => m.hasFactory && !m.importOriginal).length,
  };
});

// Every unit file also pays the setup files, which are not in any test's own closure. Reported
// on its own rather than folded in: it is a per-WORKER constant under `isolate: false` and a
// per-FILE constant under isolation, and blending it hides which of the two a number is.
const setupEntries = ['src/__tests__/setup.ts']
  .map((p) => norm(path.join(repoRoot, p)))
  .filter((p) => fileSet.has(p));
const setupClosure = new Set();
for (const s of setupEntries) for (const m of realClosure(s, []).internal) setupClosure.add(m);

// Which first-party modules appear in the most test-file closures? Those are the ones whose
// import cost is paid over and over under isolation.
const moduleFanIn = new Map();
for (const file of unitTests) {
  for (const mod of realClosures.get(file).internal) {
    moduleFanIn.set(mod, (moduleFanIn.get(mod) ?? 0) + 1);
  }
}
const externalFanIn = new Map();
for (const file of unitTests) {
  for (const ext of realClosures.get(file).external)
    externalFanIn.set(ext, (externalFanIn.get(ext) ?? 0) + 1);
}

const mockFanIn = new Map();
for (const r of records) {
  for (const m of r.mocks) {
    const e = mockFanIn.get(m.specifier) ?? {
      specifier: m.specifier,
      sites: 0,
      files: 0,
      partial: 0,
    };
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
    medianGraphModulesRaw: median(records.map((r) => r.graphModulesRaw)),
    maxGraphModulesRaw: Math.max(...records.map((r) => r.graphModulesRaw)),
    setupClosureModules: setupClosure.size,
  },
  files: records.sort((a, b) => b.graphModules - a.graphModules),
  heaviestModules: [...moduleFanIn.entries()]
    .map(([mod, n]) => ({
      module: path.relative(repoRoot, mod).replace(/\\/g, '/'),
      inClosures: n,
      ownBytes: importsOf(mod).bytes,
    }))
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

// Per-file closures as index arrays over a shared module table — the input any assignment or
// per-worker-union evaluation reads. Mock- and lazy-honouring, same as `graphModules`.
const moduleTable = [...moduleFanIn.keys()].map((m) =>
  path.relative(repoRoot, m).replace(/\\/g, '/')
);
const moduleIdx = new Map(moduleTable.map((m, i) => [m, i]));
const closures = {};
for (const file of unitTests) {
  const relFile = path.relative(repoRoot, file).replace(/\\/g, '/');
  closures[relFile] = [...realClosures.get(file).internal]
    .map((m) => moduleIdx.get(path.relative(repoRoot, m).replace(/\\/g, '/')))
    .filter((i) => i !== undefined);
}

mkdirSync(path.join(repoRoot, '.test-perf'), { recursive: true });
writeFileSync(path.join(repoRoot, '.test-perf/inventory.json'), JSON.stringify(out, null, 2));
writeFileSync(
  path.join(repoRoot, '.test-perf/closures.json'),
  JSON.stringify({
    mode: 'real',
    note: 'lazy import() not followed; vi.mock factory subtrees truncated (the mocked module itself is counted)',
    setupClosure: [...setupClosure]
      .map((m) => path.relative(repoRoot, m).replace(/\\/g, '/'))
      .sort(),
    modules: moduleTable,
    closures,
  })
);
console.log(
  `${out.totals.testFiles} unit test files, ${out.totals.tests} tests, ${out.totals.mockSites} vi.mock sites`
);
console.log(
  `median closure ${out.totals.medianGraphModules} modules, max ${out.totals.maxGraphModules}` +
    `  (naive: median ${out.totals.medianGraphModulesRaw}, max ${out.totals.maxGraphModulesRaw})`
);
console.log(`setup closure ${setupClosure.size} modules, paid by every file`);
console.log(
  'top mocked:',
  out.mockedModules
    .slice(0, 8)
    .map((m) => `${m.specifier}(${m.sites})`)
    .join(' ')
);
