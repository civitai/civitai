#!/usr/bin/env node
/**
 * Regenerate src/__tests__/mocks/unit-fast-manifest.json — which test files may run in the
 * unisolated `unit-fast` project, which may never, and why.
 *
 *   node scripts/test-perf/gen-fast-project.mjs           # write the manifest
 *   node scripts/test-perf/gen-fast-project.mjs --check    # exit 1 on drift, write nothing
 *
 * A file is a MEMBER iff both hold:
 *
 *   1. it is not permanently excluded, and
 *   2. every specifier it mocks is CANONICAL, or PRIVATE to it within the member set —
 *      no other member mocks that module AND no other member's import closure reaches it.
 *
 * Both halves of (2) are load-bearing. A `vi.mock` poisons any sibling that merely IMPORTS the
 * module, whether or not the sibling mocks anything. And a relative specifier is not private by
 * construction: four files mock only `./`-relative modules that other test files import, so a
 * "relative means local" shortcut admits four unsafe files while looking obviously correct.
 *
 * 🔴 Membership is ALL-OR-NOTHING per file. A file converted for one specifier and not another is
 * worse than an unconverted one: it reads as progress on a per-specifier burn-down while its one
 * leftover partial mock still re-poisons the whole worker.
 *
 * 🔴 And it is a FIXPOINT, not a filter. "Private" is a property of the member set, so admitting a
 * file can make another file's specifier shared and evict it. We iterate, evicting only, which
 * converges on the unique maximal member set regardless of order. It currently settles in ONE
 * round; that is a property of this tree, not of the rule, and it stops being true as soon as the
 * migration starts admitting files that share specifiers with each other. Do not collapse the loop.
 */
import { readFileSync, writeFileSync, existsSync, globSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(repoRoot, 'src/__tests__/mocks/unit-fast-manifest.json');
const SPECIFIERS_SRC = path.join(repoRoot, 'src/__tests__/mocks/guarded-specifiers.ts');
const CLOSURES = path.join(repoRoot, '.test-perf/closures.json');
const INVENTORY = path.join(repoRoot, '.test-perf/inventory.json');
const GRAPH = path.join(repoRoot, 'scripts/test-perf/graph.mjs');

const CHECK = process.argv.includes('--check');

/**
 * Env keys whose value is read at MODULE scope, so one shared registry cannot hold two of them.
 * Nominated here, confirmed by conflict below — presence alone is not the test.
 */
const IMPORT_TIME_KEYS = ['IS_BUILD', 'IS_DATAPACKET'];

// ---- inputs ---------------------------------------------------------------

/**
 * The import graph comes from `graph.mjs` (PR #3957's tooling), not from a second copy here. A
 * generator that disagrees with the guard about which modules are guarded is the failure this file
 * must not have, and the same argument applies to disagreeing about the import graph.
 */
function loadGraph() {
  if (!existsSync(GRAPH))
    fail(
      `scripts/test-perf/graph.mjs is missing.\n` +
        `The membership rule needs a mock- and lazy-honouring import graph and must not carry a\n` +
        `second copy of it. Land PR #3957 (test-perf tooling) with the honest graph first.`
    );
  execFileSync(process.execPath, [GRAPH], { cwd: repoRoot, stdio: 'ignore' });
  const closures = JSON.parse(readFileSync(CLOSURES, 'utf8'));
  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  if (closures.mode !== 'real')
    fail(
      `.test-perf/closures.json has mode='${closures.mode}', expected 'real'.\n` +
        `A graph that follows lazy import() and ignores vi.mock over-counts a page-gate test by\n` +
        `~75x and would admit files to unit-fast on the strength of modules that never load.`
    );
  return { closures, inventory };
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Parsed out of the TS module rather than duplicated — two copies would drift. */
function readCanonicalSpecifiers() {
  const sf = ts.createSourceFile(
    SPECIFIERS_SRC,
    readFileSync(SPECIFIERS_SRC, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (decl.name.getText() !== 'CANONICAL_SPECIFIERS') continue;
      if (!decl.initializer || !ts.isArrayLiteralExpression(decl.initializer)) continue;
      return decl.initializer.elements.map((e) => e.getText().slice(1, -1));
    }
  }
  fail(`Could not read CANONICAL_SPECIFIERS from ${path.relative(repoRoot, SPECIFIERS_SRC)}`);
}

// ---- membership -----------------------------------------------------------

/** `~/x` and `@civitai/pkg/x` to repo-relative paths, so a specifier compares against a closure. */
function specifierToPath(spec, fromFile) {
  if (spec.startsWith('~/')) return 'src/' + spec.slice(2);
  if (spec.startsWith('@civitai/')) {
    const [pkg, ...sub] = spec.slice('@civitai/'.length).split('/');
    return `packages/civitai-${pkg}/src/${sub.length ? sub.join('/') : 'index'}`;
  }
  if (spec.startsWith('.'))
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return null; // external package: shared by definition, but not a first-party module
}

/**
 * Which files are permanently excluded, and why.
 *
 * A key every test agrees on can be promoted to a worker-level default and costs nothing. Only a
 * key set to CONFLICTING values at module scope is structurally impossible under one registry.
 */
function findPermanentExclusions(testFiles) {
  const byKey = new Map(IMPORT_TIME_KEYS.map((k) => [k, new Map()]));
  for (const file of testFiles) {
    const src = readFileSync(path.join(repoRoot, file), 'utf8');
    for (const key of IMPORT_TIME_KEYS) {
      const re = new RegExp(String.raw`\b${key}\s*:\s*(true|false)\b`, 'g');
      let m;
      while ((m = re.exec(src))) {
        const byVal = byKey.get(key);
        if (!byVal.has(m[1])) byVal.set(m[1], new Set());
        byVal.get(m[1]).add(file);
      }
    }
  }
  const excluded = new Map();
  const conflicts = {};
  for (const key of IMPORT_TIME_KEYS) {
    const byVal = byKey.get(key);
    if (byVal.size < 2) continue; // agreed, or absent — promotable to a worker default
    conflicts[key] = Object.fromEntries([...byVal].map(([v, s]) => [v, [...s].sort()]));
    for (const [value, files] of byVal)
      for (const file of files) {
        const reason = `${key} is read at module scope and this suite sets it to ${value} while others set it otherwise; no per-file mechanism can vary an import-time value once a worker shares one registry`;
        if (!excluded.has(file)) excluded.set(file, reason);
      }
  }
  return { excluded, conflicts };
}

function computeMembers({ closures, inventory }, canonical) {
  const CANON = new Set(canonical);
  const byFile = new Map(inventory.files.map((f) => [f.file, f]));

  // Closure membership keyed extension-less, so a mock specifier can be compared against it.
  const importedBy = new Map();
  for (const [file, idx] of Object.entries(closures.closures))
    for (const i of idx) {
      const mod = closures.modules[i].replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
      if (!importedBy.has(mod)) importedBy.set(mod, new Set());
      importedBy.get(mod).add(file);
    }

  const { excluded, conflicts } = findPermanentExclusions([...byFile.keys()]);
  let members = new Set([...byFile.keys()].filter((f) => !excluded.has(f)));

  const rounds = [];
  for (let round = 1; ; round++) {
    // A specifier is SHARED within the member set when more than one member mocks or imports it.
    const touchers = new Map();
    const touch = (spec, file) => {
      if (!touchers.has(spec)) touchers.set(spec, new Set());
      touchers.get(spec).add(file);
    };
    for (const file of members)
      for (const mk of byFile.get(file).mocks) {
        touch(mk.specifier, file);
        const modPath = specifierToPath(mk.specifier, file);
        if (!modPath) continue;
        for (const other of importedBy.get(modPath) ?? [])
          if (members.has(other)) touch(mk.specifier, other);
      }

    const evicted = [];
    for (const file of members) {
      const blockers = [
        ...new Set(
          byFile
            .get(file)
            .mocks.map((m) => m.specifier)
            .filter((s) => !CANON.has(s) && (touchers.get(s)?.size ?? 0) > 1)
        ),
      ];
      if (blockers.length) evicted.push({ file, blockers });
    }
    if (!evicted.length) break;
    for (const { file } of evicted) members.delete(file);
    rounds.push(evicted.length);
    if (round > 100) fail('membership fixpoint did not converge in 100 rounds');
  }

  return { members: [...members].sort(), excluded, conflicts, rounds, byFile };
}

// ---- run ------------------------------------------------------------------

const canonical = readCanonicalSpecifiers();
const graph = loadGraph();
const { members, excluded, conflicts, rounds, byFile } = computeMembers(graph, canonical);

/**
 * The set the two projects must partition is the `unit` project's own include, and it is TWO globs
 * — `scripts/**` is in there so the typecheck wrapper's outcome classifier is covered. A partition
 * computed from `src/**` alone leaves every `scripts/*.test.ts` in neither project, which is the
 * exact hole this manifest exists to close, and it would not show up in any count.
 *
 * `.tsx` is deliberately NOT here: those are the `component` project's, and folding them in would
 * report a backlog of files `unit` never ran.
 */
const UNIT_INCLUDE = ['src/**/*.test.ts', 'scripts/**/*.test.ts'];
// No filtering. `gen-mock-allowlist.mjs` skips `src/__tests__/mocks/` because the canonical mocks
// should not be flagged for mocking themselves; borrowing that filter here silently dropped the
// mocks' OWN two test files out of the partition — files that do run in `unit`. A partition may not
// have exceptions, or it is not a partition.
const allTestFiles = [...new Set(UNIT_INCLUDE.flatMap((g) => globSync(g, { cwd: repoRoot })))]
  .map((f) => f.replace(/\\/g, '/'))
  .sort();

const outsidePartition = members.filter((f) => !allTestFiles.includes(f));
if (outsidePartition.length)
  fail(
    `members not matched by the unit project's include — they would run in NEITHER project:\n` +
      outsidePartition.map((f) => `  ${f}`).join('\n')
  );

const memberSet = new Set(members);
const loadsIn = members.reduce((a, f) => a + (byFile.get(f)?.graphModules ?? 0), 0);
const loadsAll = [...byFile.values()].reduce((a, f) => a + f.graphModules, 0);

const manifest = {
  // 🔴 `members` is unit-fast's `include` AND unit's `exclude`. One list, read twice, so the two
  // projects partition the suite structurally instead of by two globs nobody cross-checks.
  members,
  excluded: Object.fromEntries([...excluded].sort(([a], [b]) => a.localeCompare(b))),
  canonicalSpecifiers: canonical,
  conflicts,
  unitInclude: UNIT_INCLUDE,
  totals: {
    testFiles: allTestFiles.length,
    members: members.length,
    excludedPermanently: excluded.size,
    pending: allTestFiles.length - members.length - excluded.size,
    // Published beside the file count on purpose: they diverge badly. Members are ~46% of files
    // and ~16% of module loads, because the files that are already eligible are the ones that mock
    // nothing, which are the cheap ones. Quoting the file count overstates the lane by ~3x.
    moduleLoadsInMembers: loadsIn,
    moduleLoadsTotal: loadsAll,
    // The leading indicator: with most blocked files needing several specifiers, the member count
    // sits flat through a long stretch of real work and then jumps.
    oneSpecifierAway: countOneAway(),
  },
};

function countOneAway() {
  const CANON = new Set(canonical);
  let n = 0;
  for (const [file, rec] of byFile) {
    if (memberSet.has(file) || excluded.has(file)) continue;
    const blockers = new Set(rec.mocks.map((m) => m.specifier).filter((s) => !CANON.has(s)));
    if (blockers.size === 1) n++;
  }
  return n;
}

const serialised = `${JSON.stringify(manifest, null, 2)}\n`;

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== serialised) {
    console.error(
      'unit-fast-manifest.json is stale — run: node scripts/test-perf/gen-fast-project.mjs'
    );
    process.exit(1);
  }
  console.log(`manifest current: ${members.length} members, ${excluded.size} excluded`);
} else {
  writeFileSync(OUT, serialised);
  console.log(
    `members ${members.length} of ${allTestFiles.length} files ` +
      `(${((members.length / allTestFiles.length) * 100).toFixed(1)}%), ` +
      `carrying ${loadsIn} of ${loadsAll} module loads (${((loadsIn / loadsAll) * 100).toFixed(
        1
      )}%)`
  );
  console.log(
    `excluded permanently ${excluded.size}, one specifier away ${manifest.totals.oneSpecifierAway}`
  );
  console.log(
    `fixpoint settled in ${rounds.length} round(s): evicted ${rounds.join(', ') || 'none'}`
  );
}
