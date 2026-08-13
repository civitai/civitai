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
 * The failure mode of a gate like this is a CONFIDENT ZERO — a run that measured
 * nothing and reported "no new errors". The first version of this file had that
 * bug in four places at once, because it inferred "clean" from "I parsed no
 * diagnostics". Five controls now stand between a run and a verdict, and every
 * one of them is STRUCTURAL: none depends on a downstream tool remembering to
 * print a particular string.
 *
 *  1. EXIT-STATUS TRUTH TABLE. `classifyRun()` in `typecheck-tests-compare.mjs`
 *     decides the outcome from (exit status, signal, parsed diagnostic count).
 *     A non-zero exit with zero parsed diagnostics is a FAILURE TO RUN, never a
 *     clean tree — that single rule covers a rejected `TYPECHECK_HEAP_MB` (exit
 *     2), an unresolvable `typescript` (exit 2), a spawn error (exit 2), a
 *     missing binary (127) and a V8 heap abort (134). The previous version
 *     matched the literal string `TYPECHECK CRASHED`, which `scripts/typecheck.mjs`
 *     emits from exactly one of its failure paths and not from the other three;
 *     all four of those exits PASSED this gate at exit 0.
 *  2. PARSE CONTROL. `pretty` is a legal `compilerOptions` key, inherited through
 *     `extends`, and tsc also enables it under a TTY. It changes every diagnostic
 *     from `path(l,c): error TS…` to `path:l:c - error TS…`, which the old
 *     single-format regex matched zero of — 801 real errors parsed as 0, and the
 *     gate PASSED. It is now forced off on the command line (`--pretty false`,
 *     which overrides the config), BOTH formats are recognised anyway, and a run
 *     whose output contains the literal `error TS` while parsing to zero is
 *     refused as unmeasurable.
 *  3. PLAUSIBILITY. A parsed total of 0 against a baseline of N>0 is refused
 *     (escape: `TYPECHECK_TESTS_ALLOW_EMPTY=1`). "Everything got fixed" and "the
 *     instrument is broken" produce the same number, and only one of them is
 *     common.
 *  4. POSITIVE CONTROL ON THE MEASUREMENT ARM. `--listFilesOnly` proves the
 *     program actually READS test files. It now runs through the SAME wrapper,
 *     the same `-p`, and the same flags as the run that produces the verdict —
 *     the old one shelled out to `tsc.js` directly with different arguments, so
 *     it structurally could not witness the arm being validated. Its floor is
 *     derived from the file count STORED IN THE BASELINE, not a magic 400: at
 *     938 real files a floor of 400 let 57% of the test tree disappear with the
 *     control still green, and vanished files score as `fixed`, i.e. PASS.
 *  5. CONFIG-DRIFT CONTROL. `tsconfig.tests.json` must be `tsconfig.json`'s
 *     exclude list minus exactly one entry. Both lists are written out verbatim,
 *     so without this an addition to the base list silently fails to reach the
 *     measurement program and the "one-line delta" property quietly stops being
 *     true.
 *
 * `--write-baseline` runs behind all five. A regeneration on a machine where the
 * check cannot run used to write `0 error(s) across 0 file(s)` and exit 0,
 * destroying the ratchet and reporting success.
 *
 * The pure comparison/parsing/classification logic lives in
 * `typecheck-tests-compare.mjs` and is unit-tested in
 * `scripts/__tests__/typecheck-tests-gate.test.ts`.
 *
 * Exit codes: 0 pass · 1 regression (blocking) · 2 usage/baseline error ·
 *             3 the environment could not run the check.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPlausibility,
  classifyRun,
  compare,
  diffExcludes,
  isGatedTestFile,
  parseDiagnostics,
  stripJsonComments,
  testFileFloor,
  validateBaseline,
} from './typecheck-tests-compare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const TS_CONFIG = 'tsconfig.tests.json';
const BASE_TS_CONFIG = 'tsconfig.json';
const EXCLUDE_ENTRY = 'src/**/__tests__/**';
// Test seam, like TYPECHECK_TESTS_WRAPPER below: lets the suite point the gate
// at a fixture baseline instead of the committed one, so the comparison and the
// --write-baseline refusal can be exercised without a real tsc run and without
// writing to a tracked file.
const BASELINE_PATH = process.env.TYPECHECK_TESTS_BASELINE || path.join(HERE, 'typecheck-tests-baseline.json');

// Test seam. Lets the suite drive this gate with a stub wrapper that exits the
// way each real failure does, at sub-second cost instead of a multi-minute tsc
// run. Not meant for normal use — every path it reaches is the same path the
// real wrapper reaches.
const WRAPPER = process.env.TYPECHECK_TESTS_WRAPPER || path.join(REPO_ROOT, 'scripts', 'typecheck.mjs');
const ALLOW_EMPTY = process.env.TYPECHECK_TESTS_ALLOW_EMPTY === '1';

const TEST_PATH_MARKER = `${path.sep}__tests__${path.sep}`;

function fail(msg, code) {
  console.error(msg);
  process.exit(code);
}

function cannotMeasure(reason) {
  fail(
    `typecheck-tests-gate: CANNOT MEASURE — ${reason}\n` +
      '  This run produced no usable measurement, so it is not a pass and not a failure.\n' +
      '  Do NOT read the absence of reported errors as a clean test tree.',
    3
  );
}

// `--write-baseline` re-measures and rewrites the baseline. It shares this
// file's parser on purpose: a separate generator is two implementations of one
// rule, and they disagree eventually — always in the direction of a green gate.
const WRITE_BASELINE = process.argv.includes('--write-baseline');

// ---------------------------------------------------------------- baseline
if (!WRITE_BASELINE && !existsSync(BASELINE_PATH)) {
  fail(`typecheck-tests-gate: baseline not found at ${BASELINE_PATH}`, 2);
}
// The baseline currently on disk, whether or not this run is going to replace it.
// `--write-baseline` is the mode with no ratchet of its own, so it borrows this
// one for BOTH of its safety checks — the plausibility floor and the positive
// control's file-count floor. Without it, "regenerate" is the one path where
// every control falls back to its weakest setting.
function readPrevious() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}
const previous = readPrevious();

let baseline = { config: TS_CONFIG, files: {} };
if (!WRITE_BASELINE) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    fail(`typecheck-tests-gate: baseline is not valid JSON: ${err.message}`, 2);
  }
  const problems = validateBaseline(baseline, TS_CONFIG);
  if (problems.length) {
    fail(`typecheck-tests-gate: unusable baseline:\n    ${problems.join('\n    ')}`, 2);
  }
}

// ------------------------------------------- control 5: config-drift control
// Cheap, and it runs first: if the two programs have stopped being "the same
// program minus one exclude entry", every number below means something else.
try {
  const readExclude = (file) =>
    JSON.parse(stripJsonComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))).exclude;
  const drift = diffExcludes(readExclude(BASE_TS_CONFIG), readExclude(TS_CONFIG), EXCLUDE_ENTRY);
  if (!drift.ok) {
    cannotMeasure(
      `${TS_CONFIG} is no longer ${BASE_TS_CONFIG}'s exclude list minus exactly ` +
        `"${EXCLUDE_ENTRY}".\n` +
        `    removed from base: [${drift.removed.join(', ')}]\n` +
        `    added by ${TS_CONFIG}: [${drift.added.join(', ')}]\n` +
        `    The one-line delta is what makes this a measurement of the SAME program with the ` +
        `test files added. Restore it, or re-derive what the numbers mean.`
    );
  }
} catch (err) {
  cannotMeasure(`could not compare the two tsconfig exclude lists: ${err.message}`);
}

// -------------------------------------------------------- run the typecheck
// `--pretty false` is passed explicitly, and is control 2: `pretty` is a legal
// inherited compilerOption and tsc turns it on by itself under a TTY, either of
// which reshapes every diagnostic into a format the parser below would have
// matched zero of. The command line beats the config file.
function runWrapper(extraArgs) {
  const res = spawnSync(process.execPath, [WRAPPER, '-p', TS_CONFIG, '--pretty', 'false', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (res.error) cannotMeasure(`could not start the typecheck wrapper: ${res.error.message}`);
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  const parsed = parseDiagnostics(output);
  const verdict = classifyRun({
    status: res.status,
    signal: res.signal,
    parsed,
    crashMarker: output.includes('TYPECHECK CRASHED'),
  });
  return { res, output, parsed, verdict };
}

// ---------------------------------- control 4: positive control, same arm
// Same wrapper, same -p, same flags as the verdict run. The only difference is
// `--listFilesOnly`, so anything that would break the measurement (a bad -p, a
// rejected env var, a missing binary) breaks this too, out loud.
const listed = runWrapper(['--listFilesOnly']);
if (!listed.verdict.ok) {
  cannotMeasure(`the positive control could not run: ${listed.verdict.reason}`);
}
const testFilesInProgram = listed.output
  .split('\n')
  .filter((line) => line.includes(TEST_PATH_MARKER) && !line.includes(`${path.sep}node_modules${path.sep}`))
  .length;

const recordedTestFiles = baseline.testFilesInProgram ?? previous?.testFilesInProgram;
const { floor, derived } = testFileFloor(recordedTestFiles);
if (testFilesInProgram < floor) {
  cannotMeasure(
    `POSITIVE CONTROL FAILED — the program built from ${TS_CONFIG} contains ` +
      `${testFilesInProgram} file(s) under a __tests__ directory, below the floor of ${floor} ` +
      (derived
        ? `(90% of the ${recordedTestFiles} recorded in the baseline).`
        : `(fixed fallback; the baseline records no testFilesInProgram).`) +
      `\n    Whatever this run would have reported, it is not a measurement of the test tree. ` +
      `Check ${TS_CONFIG}'s exclude list and the -p path.`
  );
}
console.log(
  `typecheck-tests-gate: positive control OK — ${testFilesInProgram} test file(s) in the program ` +
    `(floor ${floor}${derived ? ', derived from the baseline' : ', fixed fallback'}).`
);

// ------------------------------------------------------------- the verdict run
const measured = runWrapper([]);
// Control 1 + 2: the outcome is decided by the exit status and the parse, not by
// the absence of diagnostics and not by a marker string.
if (!measured.verdict.ok) cannotMeasure(measured.verdict.reason);

const current = measured.parsed.counts;
if (measured.parsed.formats.size) {
  console.log(
    `typecheck-tests-gate: parsed ${measured.parsed.total} diagnostic(s) in ` +
      `${[...measured.parsed.formats].join('+')} format.`
  );
}

// Anything outside `src/**/__tests__/` is not this gate's business — the root
// typecheck already covers it, and reporting it here would double-count. Note
// the predicate is the ACTUAL exclusion (`src/**/__tests__/**`, anchored at the
// repo-root src), not a bare `/__tests__/` substring: the 68 files under
// `packages/*/src/**/__tests__/` are in BOTH programs, so claiming them here
// would demand a baseline entry for an error `pnpm typecheck` already blocks on.
const outsideTests = [...current.keys()].filter((f) => !isGatedTestFile(f));
if (outsideTests.length) {
  console.log(
    `typecheck-tests-gate: note — ${outsideTests.length} file(s) with errors outside ` +
      `src/**/__tests__/; those belong to \`pnpm typecheck\`, not this gate:`
  );
  for (const f of outsideTests.slice(0, 10)) console.log(`    ${f} (${current.get(f)})`);
  for (const f of outsideTests) current.delete(f);
}

const currentTotal = [...current.values()].reduce((a, b) => a + b, 0);
const baselineTotal = Object.values(baseline.files ?? {}).reduce((a, b) => a + b, 0);

// Control 3. Applies to `--write-baseline` too — that is the path that silently
// zeroed the ratchet and exited 0.
const previousTotal = Object.values(previous?.files ?? {}).reduce((a, b) => a + b, 0);
const plausible = checkPlausibility({
  currentTotal,
  baselineTotal: WRITE_BASELINE ? previousTotal : baselineTotal,
  allowEmpty: ALLOW_EMPTY,
});
if (!plausible.ok) cannotMeasure(plausible.reason);

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
        // The positive control's floor is derived from this. It is part of the
        // measurement, not metadata: without it the control is a magic number
        // that a shrinking test tree walks straight under.
        testFilesInProgram,
        totalErrors: total,
        files,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `typecheck-tests-gate: wrote baseline — ${total} error(s) across ${Object.keys(files).length} ` +
      `file(s), ${testFilesInProgram} test file(s) in program.`
  );
  process.exit(0);
}

// ------------------------------------------------------------------- compare
const result = compare(current, baseline.files);

console.log('');
console.log(
  `typecheck-tests-gate: ${result.currentTotal} error(s) across ${current.size} file(s) ` +
    `(baseline: ${result.baselineTotal} across ${Object.keys(baseline.files).length}).`
);

if (result.improved.length || result.fixed.length) {
  console.log(
    `typecheck-tests-gate: ${result.fixed.length} file(s) now clean, ${result.improved.length} improved — ` +
      `lower the baseline when convenient (never required to merge).`
  );
}

if (!result.blocked) {
  console.log('typecheck-tests-gate: PASS — no new or worsened test-file type errors.');
  process.exit(0);
}

console.error('');
console.error('================================================================');
console.error('  TYPECHECK-TESTS GATE: BLOCKED');
console.error('================================================================');
if (result.newlyDirty.length) {
  console.error(`  ${result.newlyDirty.length} test file(s) have type errors and are NOT in the baseline:`);
  for (const { file, count } of result.newlyDirty) console.error(`    ${file}  (${count})`);
}
if (result.worsened.length) {
  console.error(`  ${result.worsened.length} baselined file(s) got WORSE:`);
  for (const { file, was, now } of result.worsened) console.error(`    ${file}  ${was} -> ${now}`);
}
if (result.renames.length) {
  console.error('');
  console.error(`  ${result.renames.length} of these look like a RENAME, not a regression:`);
  for (const { from, to, count } of result.renames) console.error(`    ${from}  ->  ${to}  (${count}, unchanged)`);
  console.error('    A moved file is a new path with no baseline entry, and this gate cannot see');
  console.error('    file CONTENT, so it will not forgive one automatically — that is a hole a real');
  console.error('    regression fits through. Re-run with --write-baseline in the same change.');
}
console.error('');
console.error('  These are real type errors in test files. `pnpm typecheck` cannot see them');
console.error('  because the root tsconfig excludes src/**/__tests__/**.');
console.error('');
console.error('  Reproduce locally:');
console.error(`    pnpm typecheck -p ${TS_CONFIG}`);
console.error('================================================================');
process.exit(1);
