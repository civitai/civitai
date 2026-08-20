#!/usr/bin/env node
/**
 * Ratchet gate for the type errors in the QUARANTINED files under `scripts/`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until this gate landed, the root `tsconfig.json` put ZERO files under
 * `scripts/` into the program. Not "only `scripts/local-dev`" — zero. That
 * directory was named in `include` and ALSO in `exclude`, and exclude wins, so
 * the one entry that made the list look intentional was inert. Measured on
 * 23cecb57c0: `tsc -p tsconfig.json --listFilesOnly` contained 0 files under
 * `scripts/`, and a deliberate `const x: number = 'nope'` planted in
 * `scripts/oneoffs/parse_header.ts` produced `OK — 0 type errors`, exit 0. Both
 * CI tiers run that same config, so the gap could not close on its own.
 *
 * `tsconfig.json` now includes `scripts/**\/*.ts(x)`. 33 of the 38 files that
 * pulls in were already clean and are checked by the real `pnpm typecheck` from
 * now on, in both tiers, along with every file added under `scripts/` later.
 * The other five carried 198 pre-existing errors and are listed in that config's
 * `exclude` under a `scripts/ quarantine` heading.
 *
 * THIS GATE IS WHAT KEEPS THAT QUARANTINE FROM BEING A NEW BLIND SPOT. Excluding
 * five files and walking away would recreate, at smaller scale, exactly the
 * defect being fixed — which is how `src/**\/__tests__/**` got to 801 errors.
 *
 * `tsconfig.scripts.json` is the same program with the quarantine entries
 * removed. It is a strict superset: every other `include`/`exclude`/
 * `compilerOptions` value is inherited via `extends`, deliberately. A hand-rolled
 * narrowed program that picks its own `include` drops `src/types/global.d.ts`,
 * ambient names then resolve to TS2304, generics that depend on them collapse,
 * and the affected files report FEWER errors than they really have — a false
 * all-clear on exactly the files being measured.
 *
 * WHAT THIS GATE ASKS
 * -------------------
 * Not "is the quarantine clean" — it is not, and blocking on that would be
 * permanently red, which only teaches people to click through. It asks: **did
 * this change make it worse?**
 *
 *   - a quarantined file whose error count went UP        -> BLOCK
 *   - a file with errors that is NOT in the baseline      -> BLOCK
 *   - a quarantined file whose error count went DOWN      -> pass, and say so
 *   - a quarantined file that is now clean, or is gone    -> pass, and say so
 *
 * Lowering a baseline entry is never required to merge; raising one is only
 * possible by editing a committed file inside the pull request, where a reviewer
 * sees it. When a file reaches zero, delete its line from `tsconfig.json`'s
 * quarantine block and from `tsconfig.scripts.json` is NOT needed — the latter
 * simply stops differing by that entry, which `diffLists` then requires you to
 * reflect in QUARANTINE below.
 *
 * A NOTE ON WHERE THE 198 COME FROM
 * ---------------------------------
 * 164 of them are in one file and share a single cause: it imports an untyped
 * `.mjs` module carrying no JSDoc, so under `allowJs` tsc infers
 * `request({ worktree, args = [] } = {})` as taking `{ args?: never[] }` (40x
 * TS2353) and infers the run object's `null` initializers as type `null` (123x
 * TS18047/TS2531). They are not 164 independent defects, and the fix is to type
 * that module rather than to edit 164 assertions.
 *
 * INSTRUMENT VALIDATION (read this before trusting a green run)
 * ------------------------------------------------------------
 * The failure mode of a gate like this is a CONFIDENT ZERO — a run that measured
 * nothing and reported "no new errors". Five controls stand between a run and a
 * verdict, and they are the sibling gate's, reused rather than reimplemented
 * (`typecheck-scripts-compare.mjs` re-exports them from
 * `typecheck-tests-compare.mjs`). Each was written in response to a real defect
 * in that gate; a second copy would regenerate each of them on its own schedule.
 *
 *  1. EXIT-STATUS TRUTH TABLE (`classifyRun`). A non-zero exit with zero parsed
 *     diagnostics is a FAILURE TO RUN, never a clean tree — covering a rejected
 *     `TYPECHECK_HEAP_MB` (exit 2), an unresolvable `typescript` (2), a spawn
 *     error (2), a missing binary (127) and a V8 heap abort (134).
 *  2. PARSE CONTROL (`parseDiagnostics` + `classifyRun`). `--pretty false` is
 *     forced on the command line, BOTH diagnostic formats are recognised anyway,
 *     and the parse must ACCOUNT FOR EVERY LINE carrying the `error TS` marker.
 *  3. PLAUSIBILITY (`checkPlausibility`). A parsed total of 0 against a baseline
 *     of N>0 is refused, and so is a collapse below 25% of the baseline.
 *     "Everything got fixed" and "the instrument is broken" produce the same
 *     number, and only one of them is common.
 *  4. POSITIVE CONTROL ON THE MEASUREMENT ARM. `--listFilesOnly` proves the
 *     program actually READS files under `scripts/`, through the SAME wrapper,
 *     the same `-p` and the same flags as the verdict run. Its floor is
 *     `max(20, 90% of the count STORED IN THE BASELINE)`. 🔴 It counts on a
 *     REPO-ROOT-ANCHORED path, not the substring `/scripts/`: this repo pulls
 *     `.claude/skills/dev-server/scripts/*.mjs` into the program transitively,
 *     and every vendored package has a `scripts/` directory, so a substring
 *     control could stay green with the entire measured tree gone.
 *  5. CONFIG-DRIFT CONTROL (`diffLists`). `tsconfig.scripts.json` must be
 *     `tsconfig.json`'s exclude list minus exactly the QUARANTINE set. Both
 *     lists are written out verbatim, so without this an addition to the base
 *     list silently fails to reach the measurement program and the "same program
 *     plus the quarantine" property quietly stops being true.
 *
 * `--write-baseline` runs behind all five.
 *
 * The pure comparison/parsing/classification logic lives in
 * `typecheck-scripts-compare.mjs` and is unit-tested in
 * `scripts/__tests__/typecheck-scripts-gate.test.ts`.
 *
 * Exit codes: 0 pass · 1 regression (blocking) · 2 usage/baseline error ·
 *             3 the environment could not run the check.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOW_EMPTY_ENV,
  GATE_SCRIPT,
  checkPlausibility,
  classifyEmptyAllowance,
  classifyRun,
  compare,
  countScriptFilesInProgram,
  diffLists,
  isGatedScriptFile,
  parseDiagnostics,
  scriptFileFloor,
  stripJsonComments,
  validateBaseline,
} from './typecheck-scripts-compare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const TS_CONFIG = 'tsconfig.scripts.json';
const BASE_TS_CONFIG = 'tsconfig.json';

/**
 * The quarantine: files `tsconfig.json` excludes and `tsconfig.scripts.json` does
 * not. This list is the gate's copy of that delta, and `diffLists` refuses to run
 * if the two configs stop agreeing with it — including if this list goes STALE
 * after someone cleans a file up. Shrinking it is the intended direction.
 */
const QUARANTINE = [
  'scripts/__tests__/dev-server-test-queue.test.ts',
  'scripts/__tests__/dev-server-env-modes.test.ts',
  'scripts/__tests__/dev-server-port-reservation.test.ts',
  'scripts/__tests__/typecheck-tests-gate.test.ts',
  'scripts/local-dev/gen_seed.ts',
];

function fail(msg, code) {
  console.error(msg);
  process.exit(code);
}

function cannotMeasure(reason) {
  fail(
    `typecheck-scripts-gate: CANNOT MEASURE — ${reason}\n` +
      '  This run produced no usable measurement, so it is not a pass and not a failure.\n' +
      '  Do NOT read the absence of reported errors as a clean scripts/ tree.',
    3
  );
}

const WRITE_BASELINE = process.argv.includes('--write-baseline');

// ------------------------------------------------------------------ seams
// Three environment variables reach into this gate's production behaviour so the
// suite can drive it with a stub typechecker and a fixture baseline at
// sub-second cost instead of a multi-minute `tsc` — a control nobody can afford
// to run is not a control. They are ECHOED below, because an unechoed seam makes
// a stub-driven run byte-identical to a real one.
const BASELINE_PATH =
  process.env.TYPECHECK_SCRIPTS_BASELINE || path.join(HERE, 'typecheck-scripts-baseline.json');
const WRAPPER =
  process.env.TYPECHECK_SCRIPTS_WRAPPER || path.join(REPO_ROOT, 'scripts', 'typecheck.mjs');
const CONFIG_DIR = process.env.TYPECHECK_SCRIPTS_CONFIG_DIR || REPO_ROOT;
// Only the positive control's path-anchoring uses this. It is a seam because the
// suite measures fixture output whose absolute paths are not this checkout's.
const PROGRAM_ROOT = process.env.TYPECHECK_SCRIPTS_PROGRAM_ROOT || REPO_ROOT;

const provenance = [
  ['wrapper', WRAPPER, 'TYPECHECK_SCRIPTS_WRAPPER'],
  ['baseline', BASELINE_PATH, 'TYPECHECK_SCRIPTS_BASELINE'],
  ['tsconfig dir', CONFIG_DIR, 'TYPECHECK_SCRIPTS_CONFIG_DIR'],
  ['program root', PROGRAM_ROOT, 'TYPECHECK_SCRIPTS_PROGRAM_ROOT'],
];
const overridden = provenance.filter(([, , env]) => process.env[env]);
console.log(
  `typecheck-scripts-gate: provenance — mode=${WRITE_BASELINE ? '--write-baseline' : 'verdict'}, ` +
    provenance
      .map(([label, value, env]) => `${label}=${value}${process.env[env] ? ' [OVERRIDE]' : ''}`)
      .join(', ')
);
if (overridden.length) {
  console.log(
    `typecheck-scripts-gate: NOTE — ${overridden.length} seam(s) overridden by environment ` +
      `(${overridden.map(([, , env]) => env).join(', ')}). This run did NOT necessarily measure ` +
      `this repository; treat its numbers as belonging to whatever the override points at.`
  );
}

// --------------------------------------------- the plausibility escape hatch
const allowance = classifyEmptyAllowance({
  raw: process.env[ALLOW_EMPTY_ENV],
  writeBaseline: WRITE_BASELINE,
  envName: ALLOW_EMPTY_ENV,
  gateScript: GATE_SCRIPT,
});
if (allowance.refuse) {
  fail(
    `typecheck-scripts-gate: REFUSING TO RUN — ${allowance.refuse}\n` +
      '  A disabled control is not a passing run. Nothing was measured.',
    3
  );
}
if (allowance.allowed) {
  console.log('');
  console.log('  ################################################################');
  console.log('  #  PLAUSIBILITY CONTROL DISARMED — this run is NOT a clean bill #');
  console.log('  ################################################################');
  console.log(`  # reason given: ${allowance.reason}`);
  console.log(`  # ${ALLOW_EMPTY_ENV} is set, so an implausible measurement (a zero, or a`);
  console.log('  # collapse against the previous baseline) will be WRITTEN rather than');
  console.log('  # refused. Whoever reviews the resulting baseline diff is the control.');
  console.log('  ################################################################');
  console.log('');
}

// ---------------------------------------------------------------- baseline
if (!WRITE_BASELINE && !existsSync(BASELINE_PATH)) {
  fail(`typecheck-scripts-gate: baseline not found at ${BASELINE_PATH}`, 2);
}
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
    fail(`typecheck-scripts-gate: baseline is not valid JSON: ${err.message}`, 2);
  }
  const problems = validateBaseline(baseline, TS_CONFIG);
  if (problems.length) {
    fail(`typecheck-scripts-gate: unusable baseline:\n    ${problems.join('\n    ')}`, 2);
  }
}

// ------------------------------------------- control 5: config-drift control
// Cheap, and it runs first: if the two programs have stopped being "the same
// program plus the quarantine", every number below means something else.
try {
  const readExclude = (file) =>
    JSON.parse(stripJsonComments(readFileSync(path.join(CONFIG_DIR, file), 'utf8'))).exclude;
  const drift = diffLists(readExclude(BASE_TS_CONFIG), readExclude(TS_CONFIG), QUARANTINE);
  if (!drift.ok) {
    cannotMeasure(
      `${TS_CONFIG} is no longer ${BASE_TS_CONFIG}'s exclude list minus exactly the ` +
        `${QUARANTINE.length} quarantined entry/entries.\n` +
        `    missing (this gate expects them removed, but ${TS_CONFIG} still excludes them): ` +
        `[${drift.missing.join(', ')}]\n` +
        `    unexpected (removed by ${TS_CONFIG} but not in this gate's QUARANTINE list): ` +
        `[${drift.unexpected.join(', ')}]\n` +
        `    added by ${TS_CONFIG}: [${drift.added.join(', ')}]\n` +
        `    That delta is what makes this a measurement of the SAME program with the quarantined ` +
        `files added back. If you cleaned a file up, remove it from BOTH ${BASE_TS_CONFIG}'s ` +
        `quarantine block and the QUARANTINE list in ${GATE_SCRIPT}, then re-run with ` +
        `--write-baseline.`
    );
  }
} catch (err) {
  cannotMeasure(`could not compare the two tsconfig exclude lists: ${err.message}`);
}

// -------------------------------------------------------- run the typecheck
// `--pretty false` is control 2: `pretty` is a legal inherited compilerOption and
// tsc turns it on by itself under a TTY, either of which reshapes every
// diagnostic into a format the parser would have matched zero of. The command
// line beats the config file.
function runWrapper(extraArgs) {
  const res = spawnSync(
    process.execPath,
    [WRAPPER, '-p', TS_CONFIG, '--pretty', 'false', ...extraArgs],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    }
  );
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
const listed = runWrapper(['--listFilesOnly']);
if (!listed.verdict.ok) {
  cannotMeasure(`the positive control could not run: ${listed.verdict.reason}`);
}
const scriptFilesInProgram = countScriptFilesInProgram(listed.output, PROGRAM_ROOT);

const recordedScriptFiles = baseline.scriptFilesInProgram ?? previous?.scriptFilesInProgram;
const floorResult = scriptFileFloor(recordedScriptFiles);
if (!floorResult.ok) {
  cannotMeasure(
    `the positive control has no usable floor — ${floorResult.reason}\n` +
      `    The floor is what makes the positive control a control; without it this run would ` +
      `report a number nothing checked.`
  );
}
const { floor, derived } = floorResult;
if (scriptFilesInProgram < floor) {
  cannotMeasure(
    `POSITIVE CONTROL FAILED — the program built from ${TS_CONFIG} contains ` +
      `${scriptFilesInProgram} file(s) under scripts/, below the floor of ${floor} ` +
      (derived
        ? `(90% of the ${recordedScriptFiles} recorded in the baseline).`
        : recordedScriptFiles === undefined || recordedScriptFiles === null
        ? `(fixed fallback; the baseline records no scriptFilesInProgram).`
        : `(fixed fallback ${floor}; it OUTRANKS the ${Math.floor(
            recordedScriptFiles * 0.9
          )} that ` +
          `90% of the baseline's ${recordedScriptFiles} would give — a derived floor may raise the ` +
          `fixed one, never lower it).`) +
      `\n    Whatever this run would have reported, it is not a measurement of the scripts/ tree. ` +
      `Check ${TS_CONFIG}'s include/exclude lists and the -p path.`
  );
}
console.log(
  `typecheck-scripts-gate: positive control OK — ${scriptFilesInProgram} scripts/ file(s) in the ` +
    `program (floor ${floor}${derived ? ', derived from the baseline' : ', fixed fallback'}).`
);

// ------------------------------------------------------------- the verdict run
const measured = runWrapper([]);
if (!measured.verdict.ok) cannotMeasure(measured.verdict.reason);

const current = measured.parsed.counts;
if (measured.parsed.formats.size) {
  console.log(
    `typecheck-scripts-gate: parsed ${measured.parsed.total} diagnostic(s) in ` +
      `${[...measured.parsed.formats].join('+')} format.`
  );
}

// Anything outside `scripts/` is not this gate's business — the root typecheck
// already covers it and blocks on it, so reporting it here would double-count.
// 🔴 It is also a REAL SIGNAL that something is wrong: `tsconfig.scripts.json`
// differs from the root config only by the quarantine, so a `src/` error here
// means `pnpm typecheck` is red too.
const outside = [...current.keys()].filter((f) => !isGatedScriptFile(f));
if (outside.length) {
  console.log(
    `typecheck-scripts-gate: note — ${outside.length} file(s) with errors outside scripts/; ` +
      `those belong to \`pnpm typecheck\`, not this gate (and mean it is red too):`
  );
  for (const f of outside.slice(0, 10)) console.log(`    ${f} (${current.get(f)})`);
  for (const f of outside) current.delete(f);
}

const currentTotal = [...current.values()].reduce((a, b) => a + b, 0);
const baselineTotal = Object.values(baseline.files ?? {}).reduce((a, b) => a + b, 0);

// Control 3. Applies to `--write-baseline` too — that is the path that would
// silently zero the ratchet and exit 0.
const previousTotal = Object.values(previous?.files ?? {}).reduce((a, b) => a + b, 0);
const plausible = checkPlausibility({
  currentTotal,
  baselineTotal: WRITE_BASELINE ? previousTotal : baselineTotal,
  allowEmpty: allowance.allowed,
});
if (!plausible.ok) {
  // A collapsed VERDICT run is loud but harmless — it cannot hide a regression,
  // since a regression is what the ratchet blocks on, and a collapsed
  // measurement makes files look FIXED, never new. A collapsed
  // --write-baseline rewrites the ratchet to the smaller number and destroys
  // the evidence, so that one is refused.
  if (plausible.kind === 'collapse' && !WRITE_BASELINE) {
    console.log('');
    console.log('  ################################################################');
    console.log('  #  IMPLAUSIBLE MEASUREMENT — READ BEFORE BELIEVING THE VERDICT  #');
    console.log('  ################################################################');
    for (const line of plausible.reason.match(/.{1,72}(\s|$)/g) ?? []) {
      console.log(`  # ${line.trim()}`);
    }
    console.log('  # This run can still BLOCK, and a block from it is real. What it');
    console.log('  # cannot do is certify the tree: an instrument measuring a smaller');
    console.log('  # program than the baseline reports the difference as progress.');
    console.log('  ################################################################');
    console.log('');
  } else {
    cannotMeasure(plausible.reason);
  }
}

if (WRITE_BASELINE) {
  const files = Object.fromEntries([...current.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Type errors in the files tsconfig.json quarantines out of the scripts/ typecheck. ' +
          'Entries may shrink or disappear freely; adding one, or raising a count, is a ' +
          'deliberate act visible in review. Regenerate with: node ' +
          `${GATE_SCRIPT} --write-baseline`,
        config: TS_CONFIG,
        // The positive control's floor is derived from this. It is part of the
        // measurement, not metadata: without it the control is a magic number
        // that a shrinking tree walks straight under.
        scriptFilesInProgram,
        totalErrors: total,
        files,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `typecheck-scripts-gate: wrote baseline — ${total} error(s) across ${
      Object.keys(files).length
    } ` +
      `file(s), ${scriptFilesInProgram} scripts/ file(s) in program.` +
      (allowance.allowed
        ? `\ntypecheck-scripts-gate: ...WITH THE PLAUSIBILITY CONTROL DISARMED (${ALLOW_EMPTY_ENV}). ` +
          `Reason given: ${allowance.reason}\n` +
          `typecheck-scripts-gate: this baseline was NOT validated against the previous one. Review ` +
          `the diff as if it were unreviewed, because it is.`
        : '')
  );
  process.exit(0);
}

// ------------------------------------------------------------------- compare
const result = compare(current, baseline.files);

console.log('');
console.log(
  `typecheck-scripts-gate: ${result.currentTotal} error(s) across ${current.size} file(s) ` +
    `(baseline: ${result.baselineTotal} across ${Object.keys(baseline.files).length}).`
);

if (result.improved.length || result.fixed.length) {
  console.log(
    `typecheck-scripts-gate: ${result.fixed.length} file(s) now clean, ${result.improved.length} improved — ` +
      `lower the baseline when convenient (never required to merge). A file that reached ZERO can ` +
      `leave the quarantine entirely: drop it from tsconfig.json's exclude and from QUARANTINE in ` +
      `${GATE_SCRIPT}.`
  );
}

if (!result.blocked) {
  console.log('typecheck-scripts-gate: PASS — no new or worsened type errors under scripts/.');
  process.exit(0);
}

console.error('');
console.error('================================================================');
console.error('  TYPECHECK-SCRIPTS GATE: BLOCKED');
console.error('================================================================');
if (result.newlyDirty.length) {
  console.error(
    `  ${result.newlyDirty.length} file(s) under scripts/ have type errors and are NOT in the baseline:`
  );
  for (const { file, count } of result.newlyDirty) console.error(`    ${file}  (${count})`);
}
if (result.worsened.length) {
  console.error(`  ${result.worsened.length} baselined file(s) got WORSE:`);
  for (const { file, was, now } of result.worsened) console.error(`    ${file}  ${was} -> ${now}`);
}
if (result.renames.length) {
  console.error('');
  console.error(`  ${result.renames.length} of these look like a RENAME, not a regression:`);
  for (const { from, to, count } of result.renames)
    console.error(`    ${from}  ->  ${to}  (${count}, unchanged)`);
  console.error('    A moved file is a new path with no baseline entry, and this gate cannot see');
  console.error(
    '    file CONTENT, so it will not forgive one automatically — that is a hole a real'
  );
  console.error('    regression fits through. Re-run with --write-baseline in the same change.');
}
console.error('');
console.error('  These are real type errors in files tsconfig.json quarantines out of the');
console.error('  scripts/ typecheck. A file NOT in the baseline is the interesting case: it');
console.error('  means the quarantine grew, or a quarantined file was renamed.');
console.error('');
console.error('  Reproduce locally:');
console.error(`    pnpm typecheck -p ${TS_CONFIG}`);
console.error('================================================================');
process.exit(1);
