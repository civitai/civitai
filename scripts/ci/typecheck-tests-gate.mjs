#!/usr/bin/env node
/**
 * PROOF OF CONCEPT — ratchet gate for the type errors inside `src/ ** /__tests__/`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The root `tsconfig.json` carries `"src/ ** /__tests__/ ** "` in its `exclude`, so
 * `pnpm typecheck` cannot see a single file under a `__tests__/` directory. A type
 * error planted in one of those files is reported as **0 errors, exit 0** — the
 * check is not lenient about test files, it is structurally blind to them.
 *
 * `tsconfig.tests.json` is the same program with that one exclude entry removed.
 * It is a strict superset: every other `include`/`exclude`/`compilerOptions` value
 * is inherited via `extends`, deliberately. A hand-rolled narrowed program that
 * picks its own `include` drops `src/types/global.d.ts`, ambient names like
 * `FileMetadata` then resolve to TS2304, generics that depend on them collapse,
 * and the affected files report FEWER errors than they really have — a false
 * all-clear on exactly the files being measured.
 *
 * WHAT THIS GATE ASKS
 * -------------------
 * Not "is the test tree clean" — it is not, and blocking on that would be
 * permanently red, which only teaches people to click through. It asks the
 * narrower question this org already asks in its schema-drift gate and its
 * infrastructure repo: **did this change make it worse?**
 *
 *   - a file with errors that is NOT in the baseline            -> BLOCK
 *   - a baselined file whose error count went UP                -> BLOCK
 *   - a baselined file whose error count went DOWN              -> pass, and say so
 *   - a baselined file that is now clean, or is gone             -> pass, and say so
 *
 * Lowering a baseline entry is never required to merge; raising one is only
 * possible by editing a committed file inside the pull request, where a reviewer
 * sees it.
 *
 * INSTRUMENT VALIDATION (read this before trusting a green run)
 * ------------------------------------------------------------
 * Two controls run before any verdict is produced, because the failure mode of a
 * gate like this is a confident zero:
 *
 *  1. POSITIVE CONTROL. `tsc --listFilesOnly` is used to prove the program
 *     actually READS test files, and at least `MIN_TEST_FILES` of them. Without
 *     it, a mis-typed `-p` path, a future edit to the exclude list, or a rename
 *     of the `__tests__` convention would yield "0 new errors" and pass — a
 *     result indistinguishable from a gate wired to nothing.
 *  2. CRASH IS NOT CLEAN. The typecheck runs through `scripts/typecheck.mjs`,
 *     which classifies a V8 heap abort separately from a clean run (both emit
 *     zero diagnostics). If that wrapper reports a crash, this gate exits 3
 *     ("cannot measure"), never 0.
 *
 * Exit codes: 0 pass · 1 regression (blocking) · 2 usage/baseline error ·
 *             3 the environment could not run the check.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const TS_CONFIG = 'tsconfig.tests.json';
const BASELINE_PATH = path.join(HERE, 'typecheck-tests-baseline.json');

/**
 * Floor for the positive control. Measured at 870 `.ts`/`.tsx` files under
 * `src/**\/__tests__/` on 2026-08-12; the floor sits well below that so ordinary
 * churn does not trip it, while a program that stopped reading the test tree
 * altogether (the failure this control exists for) lands at 0.
 */
const MIN_TEST_FILES = 400;

const TEST_PATH_MARKER = `${path.sep}__tests__${path.sep}`;

function fail(msg, code) {
  console.error(msg);
  process.exit(code);
}

// `--write-baseline` re-measures and rewrites the baseline. It shares this
// file's parser on purpose: a separate generator is two implementations of one
// rule, and they disagree eventually — always in the direction of a green gate.
const WRITE_BASELINE = process.argv.includes('--write-baseline');

// ---------------------------------------------------------------- baseline
if (!WRITE_BASELINE && !existsSync(BASELINE_PATH)) {
  fail(`typecheck-tests-gate: baseline not found at ${BASELINE_PATH}`, 2);
}
let baseline = { config: TS_CONFIG, files: {} };
if (!WRITE_BASELINE) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    fail(`typecheck-tests-gate: baseline is not valid JSON: ${err.message}`, 2);
  }
}
if (!baseline || typeof baseline.files !== 'object' || baseline.files === null) {
  fail('typecheck-tests-gate: baseline is missing a `files` object', 2);
}
if (baseline.config !== TS_CONFIG) {
  // A baseline is only meaningful next to the program it was measured with.
  fail(
    `typecheck-tests-gate: baseline was measured against "${baseline.config}", ` +
      `this gate runs "${TS_CONFIG}". Re-measure before trusting it.`,
    2
  );
}

// ------------------------------------------------- control 1: positive control
const listed = spawnSync(
  process.execPath,
  [
    path.join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    '-p',
    TS_CONFIG,
    '--listFilesOnly',
    '--noEmit',
  ],
  { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
);
if (listed.error) {
  fail(`typecheck-tests-gate: could not run tsc --listFilesOnly: ${listed.error.message}`, 3);
}
const testFilesInProgram = (listed.stdout || '')
  .split('\n')
  .filter((line) => line.includes(TEST_PATH_MARKER) && !line.includes(`${path.sep}node_modules${path.sep}`))
  .length;
if (testFilesInProgram < MIN_TEST_FILES) {
  fail(
    `typecheck-tests-gate: POSITIVE CONTROL FAILED — the program built from ${TS_CONFIG} ` +
      `contains ${testFilesInProgram} file(s) under a __tests__ directory, below the floor of ` +
      `${MIN_TEST_FILES}. Whatever this run would have reported, it is not a measurement of ` +
      `the test tree. Check ${TS_CONFIG}'s exclude list and the -p path.`,
    3
  );
}
console.log(
  `typecheck-tests-gate: positive control OK — ${testFilesInProgram} test file(s) in the program.`
);

// ------------------------------------------------------------- run the check
const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'typecheck.mjs'), '-p', TS_CONFIG], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
if (run.error) {
  fail(`typecheck-tests-gate: could not run the typecheck: ${run.error.message}`, 3);
}
const output = `${run.stdout || ''}${run.stderr || ''}`;

// `scripts/typecheck.mjs` prints this to STDOUT specifically so a caller that
// captures only one stream still sees it. A crash says nothing about the code.
if (output.includes('TYPECHECK CRASHED')) {
  fail(
    'typecheck-tests-gate: the underlying typecheck CRASHED — this is not a result. ' +
      'See the wrapper output above; do not read the absence of errors as a pass.',
    3
  );
}

// --------------------------------------------------------------- parse errors
// `path(line,col): error TS####: message`
const DIAG = /^(.*?)\((\d+),(\d+)\): error TS(\d+):/;
const current = new Map();
let totalErrors = 0;
for (const line of output.split('\n')) {
  const m = DIAG.exec(line);
  if (!m) continue;
  totalErrors++;
  const file = m[1].split(path.sep).join('/');
  current.set(file, (current.get(file) || 0) + 1);
}

// Anything outside a __tests__ directory is not this gate's business — the root
// typecheck already covers it, and reporting it here would double-count. It is
// also a tell that the config drifted, so it is named rather than dropped.
const outsideTests = [...current.keys()].filter((f) => !f.includes('/__tests__/'));
if (outsideTests.length) {
  console.log(
    `typecheck-tests-gate: note — ${outsideTests.length} file(s) with errors outside a ` +
      `__tests__ directory; those belong to \`pnpm typecheck\`, not this gate:`
  );
  for (const f of outsideTests.slice(0, 10)) console.log(`    ${f} (${current.get(f)})`);
  for (const f of outsideTests) current.delete(f);
}

if (WRITE_BASELINE) {
  const files = Object.fromEntries([...current.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Type errors inside src/**/__tests__/** that pnpm typecheck cannot see. ' +
          'Entries may shrink or disappear freely; adding one, or raising a count, is a ' +
          'deliberate act visible in review. Regenerate with: node scripts/ci/typecheck-tests-gate.mjs --write-baseline',
        config: TS_CONFIG,
        totalErrors: total,
        files,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `typecheck-tests-gate: wrote baseline — ${total} error(s) across ${Object.keys(files).length} file(s).`
  );
  process.exit(0);
}

// ------------------------------------------------------------------- compare
const newlyDirty = [];
const worsened = [];
const improved = [];
const fixed = [];

for (const [file, count] of current) {
  const was = baseline.files[file];
  if (was === undefined) newlyDirty.push({ file, count });
  else if (count > was) worsened.push({ file, was, now: count });
  else if (count < was) improved.push({ file, was, now: count });
}
for (const [file, was] of Object.entries(baseline.files)) {
  if (!current.has(file)) fixed.push({ file, was });
}

const currentTotal = [...current.values()].reduce((a, b) => a + b, 0);
const baselineTotal = Object.values(baseline.files).reduce((a, b) => a + b, 0);

console.log('');
console.log(
  `typecheck-tests-gate: ${currentTotal} error(s) across ${current.size} file(s) ` +
    `(baseline: ${baselineTotal} across ${Object.keys(baseline.files).length}).`
);

if (improved.length || fixed.length) {
  console.log(
    `typecheck-tests-gate: ${fixed.length} file(s) now clean, ${improved.length} improved — ` +
      `lower the baseline when convenient (never required to merge).`
  );
}

if (!newlyDirty.length && !worsened.length) {
  console.log('typecheck-tests-gate: PASS — no new or worsened test-file type errors.');
  process.exit(0);
}

console.error('');
console.error('================================================================');
console.error('  TYPECHECK-TESTS GATE: BLOCKED');
console.error('================================================================');
if (newlyDirty.length) {
  console.error(`  ${newlyDirty.length} test file(s) have type errors and are NOT in the baseline:`);
  for (const { file, count } of newlyDirty) console.error(`    ${file}  (${count})`);
}
if (worsened.length) {
  console.error(`  ${worsened.length} baselined file(s) got WORSE:`);
  for (const { file, was, now } of worsened) console.error(`    ${file}  ${was} -> ${now}`);
}
console.error('');
console.error('  These are real type errors in test files. `pnpm typecheck` cannot see them');
console.error('  because the root tsconfig excludes src/**/__tests__/**.');
console.error('');
console.error('  Reproduce locally:');
console.error(`    pnpm typecheck -p ${TS_CONFIG}`);
console.error('================================================================');
process.exit(1);
