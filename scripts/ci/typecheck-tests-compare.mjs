/**
 * The pure, side-effect-free half of `typecheck-tests-gate.mjs`.
 *
 * It lives in its own module for one reason: every function here is a place the
 * gate can produce a CONFIDENT WRONG ANSWER, and none of them should require a
 * multi-minute `tsc` run to exercise. `scripts/__tests__/typecheck-tests-gate.test.ts`
 * drives them directly.
 *
 * Nothing in this file reads the filesystem, spawns a process, or exits.
 *
 * Nothing in this file reads `path.sep` either, and that is load-bearing rather
 * than incidental — see `toPosixPath` below.
 */

/**
 * Normalise any path-ish string to forward slashes.
 *
 * EVERY path this gate compares is compared as TEXT — against the `/__tests__/`
 * marker, against `TESTS_PATH_RE`, against the keys of a committed baseline JSON.
 * So each of those comparisons needs one canonical separator, and the one thing
 * it must NOT be is the HOST's.
 *
 * `tsc` emits forward slashes on every platform it runs on, Windows included.
 * `path.sep` on Windows is `\`. Building a marker or a normalisation out of
 * `path.sep` therefore produces a value that matches tsc's output on Linux and
 * matches nothing at all on Windows — green in CI, red on a developer's machine,
 * for a reason no amount of extra cases written on Linux could surface.
 *
 * Forward slash is the canonical form because it is what the tool actually
 * emits, what the committed baseline's keys are written in, and what
 * `TESTS_PATH_RE` is written against. Backslashes are folded into it so a path
 * that DOES arrive win32-shaped still lands in the same space — a normalisation
 * that only handled the shape we expect would just move the assumption.
 */
export function toPosixPath(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

/**
 * The two path segments the positive control matches on, in canonical form.
 * They are plain constants, not host-derived: that is the whole fix.
 */
export const TESTS_DIR_SEGMENT = '/__tests__/';
export const NODE_MODULES_SEGMENT = '/node_modules/';

/**
 * Does this `--listFilesOnly` line name a file the positive control should
 * count? Both halves normalise — the `node_modules` exclusion was built from
 * `path.sep` too, and fixing only the marker would leave a control that passes
 * by counting vendored test files.
 */
export function isTestFileLine(line) {
  const p = toPosixPath(line);
  return p.includes(TESTS_DIR_SEGMENT) && !p.includes(NODE_MODULES_SEGMENT);
}

/**
 * The positive control's measurement: how many files under a `__tests__`
 * directory the program actually contains, given raw `--listFilesOnly` output.
 *
 * It lives here, in the pure module, rather than inline in the gate, because the
 * gate is only reachable by spawning a process and this is the exact computation
 * that was wrong. A predicate that can only be exercised end to end is one whose
 * platform assumptions nobody checks.
 */
export function countTestFilesInProgram(output) {
  return String(output ?? '')
    .split('\n')
    .filter(isTestFileLine).length;
}

/**
 * The root `tsconfig.json` excludes exactly `src/ ** /__tests__/ ** `, anchored at
 * the repo-root `src`. So the population this gate owns is files under a
 * `__tests__/` directory BELOW `src/` — and nothing else.
 *
 * This deliberately does NOT match `packages/ * /src/ ** /__tests__/`: those 68
 * files are in BOTH programs, `pnpm typecheck` already reports them, and claiming
 * them here would demand a baseline entry for an error the root check already
 * blocks on. A naive `f.includes('/__tests__/')` predicate does exactly that.
 */
export const TESTS_PATH_RE = /^src\/(?:.*\/)?__tests__\//;

/** Is this diagnostic path one this gate is responsible for? */
export function isGatedTestFile(file) {
  return TESTS_PATH_RE.test(file);
}

/**
 * `tsc` writes diagnostics in one of two formats, and the difference is invisible
 * to a reader who only ever sees one of them:
 *
 *   plain   path(line,col): error TS####: message
 *   pretty  path:line:col - error TS####: message      (+ ANSI, a caret rule, blank lines)
 *
 * `pretty` is a legal `compilerOptions` key, is inherited through `extends`, and
 * tsc also turns it on by itself when stdout is a TTY. A parser that knows only
 * the plain form silently returns ZERO on a pretty run — which is the exact
 * failure this whole gate exists to make impossible. So both are recognised, and
 * the format that produced the count is reported to the caller.
 */
const PLAIN_DIAG = /^(.*?)\((\d+),(\d+)\): error TS(\d+):/;
// ANSI is stripped before matching, so the pretty pattern is written against
// clean text. The leading path may not contain a colon-digit run of its own.
const PRETTY_DIAG = /^(.*?):(\d+):(\d+) - error TS(\d+):/;
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

/**
 * Parse tsc output into per-file error counts.
 *
 * Returns `{ counts, total, formats, sawAnyErrorTs, unparsed, unparsedSample }`:
 *   counts         Map<repo-relative posix path, number>
 *   total          sum of counts
 *   formats        Set of the diagnostic formats actually matched
 *   sawAnyErrorTs  how many lines contain the literal marker at all — the
 *                  positive control on the parser itself.
 *   unparsed       `sawAnyErrorTs - total`: lines that carry the marker but that
 *                  NEITHER regex understood. See `classifyRun` — this is the
 *                  number the "parser blind to the format" control reads, and it
 *                  is checked for ANY divergence, not only for a total of zero.
 *   unparsedSample the first few such lines, verbatim, so a refusal can name the
 *                  actual text instead of asserting one exists.
 *
 * `total <= sawAnyErrorTs` is structural: `total` only increments on a line that
 * matched, and every matching line contains the marker. So `unparsed` is never
 * negative and `unparsed === 0` is exactly "the parser accounted for every line
 * that claims to be a diagnostic".
 */
export function parseDiagnostics(output) {
  const counts = new Map();
  const formats = new Set();
  const unparsedSample = [];
  let total = 0;
  let sawAnyErrorTs = 0;

  for (const rawLine of String(output ?? '').split('\n')) {
    const line = rawLine.replace(ANSI, '');
    if (!line.includes('error TS')) continue;
    sawAnyErrorTs++;
    const plain = PLAIN_DIAG.exec(line);
    const m = plain ?? PRETTY_DIAG.exec(line);
    if (!m) {
      if (unparsedSample.length < 3) unparsedSample.push(line.trim().slice(0, 200));
      continue;
    }
    formats.add(plain ? 'plain' : 'pretty');
    total++;
    // Canonical forward slashes, NOT `split(path.sep)`: these strings become the
    // keys of the committed baseline and the input to `isGatedTestFile`, whose
    // regex is anchored on `/`. Splitting on the host separator made a Windows
    // run's keys and a Linux run's keys equal only by the accident of tsc
    // emitting one shape — and left a backslash key, if one ever arrived, both
    // unmatchable against the baseline and silently discarded as "outside
    // src/**/__tests__/".
    const file = toPosixPath(m[1]).replace(/^\.\//, '');
    counts.set(file, (counts.get(file) || 0) + 1);
  }

  return { counts, total, formats, sawAnyErrorTs, unparsed: sawAnyErrorTs - total, unparsedSample };
}

/**
 * Classify the OUTCOME of the measurement run before any comparison happens.
 *
 * This is the fix for the class the gate shipped with: it inferred "clean" from
 * "I parsed no diagnostics", so every way of failing to run — a bad env var, a
 * missing binary, a heap abort, an unparseable output format — arrived as a
 * confident zero and PASSED.
 *
 * The rule is a truth table over (exit status, parsed diagnostics), not a search
 * for a marker string. A marker is SPELLED: it only fires on the one code path
 * that remembers to print it, and `scripts/typecheck.mjs` has three failure
 * exits that print none (a rejected TYPECHECK_HEAP_MB, an unresolvable
 * `typescript`, and a spawn error). The status is structural.
 *
 *   signal        -> cannot-measure    (killed; says nothing about the code)
 *   status != 0, parsed  > 0 -> ok     (the ordinary "you have type errors" run)
 *   status != 0, parsed == 0 -> cannot-measure  (non-zero AND silent = it did not run)
 *   status == 0, parsed  > 0 -> cannot-measure  (tsc contradicting itself)
 *   status == 0, parsed == 0 -> ok, total 0     (genuinely clean — see plausibility)
 *
 * `crashMarker` is still honoured when present, purely so the wrapper's own,
 * better-worded diagnosis wins the message. It is no longer what makes a crash
 * fail: delete every marker and this function still refuses to call it clean.
 */
export function classifyRun({ status, signal, parsed, crashMarker = false }) {
  if (signal) {
    return {
      ok: false,
      reason:
        `the typecheck was killed by signal ${signal} — it did not finish, so it says ` +
        `NOTHING about whether the code typechecks.`,
    };
  }
  if (crashMarker) {
    return {
      ok: false,
      reason:
        'the underlying typecheck reported a CRASH — see the wrapper output above. ' +
        'Do not read the absence of errors as a pass.',
    };
  }
  if (status !== 0 && parsed.total === 0) {
    return {
      ok: false,
      reason:
        `the typecheck exited ${status} and produced 0 parseable diagnostics. A non-zero ` +
        `exit with no diagnostics is a FAILURE TO RUN (bad TYPECHECK_HEAP_MB -> 2, missing ` +
        `binary -> 127, V8 abort -> 134, ...), not a clean tree` +
        (parsed.sawAnyErrorTs
          ? `. ${parsed.sawAnyErrorTs} line(s) DO contain "error TS" but none parsed — the ` +
            `diagnostic format is not one this gate understands.`
          : '.'),
    };
  }
  if (status === 0 && parsed.total > 0) {
    return {
      ok: false,
      reason:
        `the typecheck exited 0 while emitting ${parsed.total} diagnostic(s) — a contradictory ` +
        `result. Whatever it measured, it is not a verdict worth ratcheting against.`,
    };
  }
  // The parse-accounting control. This used to fire ONLY when the parser
  // understood literally nothing (`total === 0`), which made it a cliff at
  // exactly zero: a run in which the parser understood 5 of 801 marker-carrying
  // lines was accepted, and then printed "136 file(s) now clean" — a 99%
  // undercount reported as an improvement. The invariant is not "did it parse
  // SOMETHING", it is "did it parse EVERYTHING that claims to be a diagnostic".
  //
  // Measured on this repository (801 diagnostics, 1451 output lines, 650 of them
  // message-continuation lines): unparsed === 0 exactly. The continuation lines
  // do not carry the `error TS` marker, so they are never counted. The divergent
  // cases that DO exist in tsc are the FILELESS diagnostics — TS18003 "No inputs
  // were found in config file", TS6053 "File not found" — which carry the marker
  // with no `path(line,col)` prefix. Those are precisely the outputs that mean
  // the program was not built as intended, so refusing on them is correct rather
  // than merely safe.
  const unparsed = parsed.unparsed ?? (parsed.sawAnyErrorTs ?? parsed.total) - parsed.total;
  if (unparsed > 0) {
    const sample = parsed.unparsedSample?.length
      ? `\n    first unparsed line(s):\n      ${parsed.unparsedSample.join('\n      ')}`
      : '';
    return {
      ok: false,
      reason:
        `${unparsed} of ${parsed.sawAnyErrorTs} output line(s) containing "error TS" did NOT parse ` +
        `into a file/line diagnostic (${parsed.total} did). The parser did not account for every ` +
        `diagnostic in this output, so its count is a fact about the parser, not about the code. ` +
        `A partial parse is not a smaller measurement — it is an unknown one.${sample}`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * The second half of the same defence: a run can exit 0, parse cleanly, and still
 * be measuring nothing at all (wrong `-p`, an exclude that swallowed the tree, a
 * program that no longer contains test files).
 *
 * A measurement of ZERO against a baseline that records hundreds is the single
 * most likely shape of that failure, and it is indistinguishable from "someone
 * fixed everything" without saying so out loud. So it is refused rather than
 * celebrated, with a named escape hatch for the day it is genuinely true.
 */
export const COLLAPSE_RATIO = 0.25;
export const COLLAPSE_MIN_BASELINE = 20;

export function checkPlausibility({ currentTotal, baselineTotal, allowEmpty = false }) {
  if (baselineTotal > 0 && currentTotal === 0 && !allowEmpty) {
    return {
      ok: false,
      kind: 'empty',
      reason:
        `the baseline records ${baselineTotal} error(s) but this run parsed 0. A checker that ` +
        `reports zero where the baseline says ${baselineTotal} has almost certainly not measured ` +
        `anything. If the test tree really is clean now, regenerate the baseline in the same ` +
        `change (${ALLOW_EMPTY_ENV} is honoured on --write-baseline only — see its policy).`,
    };
  }
  // The zero above is the extreme of a spectrum, not a category of its own. A
  // run that reports 5 against a baseline of 801 is the same failure with one
  // digit changed, and it PASSES the ratchet (everything scores `improved` or
  // `fixed`) while printing a congratulatory "N file(s) now clean".
  //
  // This is deliberately NOT symmetric with the zero case, because the two
  // differ in reversibility: a collapsed VERDICT run is loud but harmless — it
  // cannot hide a regression, since a regression is what the ratchet blocks on
  // — whereas a collapsed --write-baseline REWRITES the ratchet to the smaller
  // number and the evidence of what was lost is gone. So the caller warns on the
  // first and refuses the second. Both are reported; neither is silent.
  if (
    baselineTotal >= COLLAPSE_MIN_BASELINE &&
    currentTotal > 0 &&
    currentTotal < baselineTotal * COLLAPSE_RATIO &&
    !allowEmpty
  ) {
    const pct = ((1 - currentTotal / baselineTotal) * 100).toFixed(1);
    return {
      ok: false,
      kind: 'collapse',
      reason:
        `this run parsed ${currentTotal} error(s) against a baseline of ${baselineTotal} — a ${pct}% ` +
        `drop, below the ${
          COLLAPSE_RATIO * 100
        }% plausibility floor. Either a great deal was genuinely ` +
        `fixed, or the instrument measured a smaller program than the baseline was taken over ` +
        `(a changed -p, a widened exclude, a partially-parsed output). Those two produce the same ` +
        `number and only one of them is common.`,
    };
  }
  return { ok: true, kind: null, reason: null };
}

/**
 * Policy for the plausibility escape hatch.
 *
 * The hatch shipped as `TYPECHECK_TESTS_ALLOW_EMPTY=1`, honoured on every path.
 * That is one environment variable in one job definition away from reinstating
 * the exact failure this gate exists to eliminate: with it set, a wrapper that
 * measures nothing produced `0 error(s) across 0 file(s) (baseline: 801 across
 * 141)` -> `141 file(s) now clean` -> `PASS`, exit 0, with nothing anywhere in
 * the output recording that a control had been switched off.
 *
 * Three properties fix that, and the first is the one that matters:
 *
 *  1. SCOPE. The hatch is honoured on `--write-baseline` ONLY. It cannot make a
 *     verdict run green, so it cannot be used — deliberately or accidentally —
 *     to turn CI green. This is not a weakening of the hatch's legitimate use:
 *     the day the test tree is genuinely clean, the action required is to
 *     REGENERATE the baseline, and after that regeneration the baseline total is
 *     0 and the control never fires again. A verdict run that hits the control
 *     is correctly telling you to do that regeneration.
 *  2. IT IS NOT IGNORED ON A VERDICT RUN — it is REFUSED. Silently ignoring a
 *     control-disabling variable is its own confident-wrong: the operator
 *     believes the control is off, the gate believes it is on, and the log says
 *     nothing. Setting it on a verdict run is an error that names itself.
 *  3. IT REQUIRES A REASON, not a truthy token. `=1` is refused; the value must
 *     be a human-readable justification, and it is echoed into the output, so
 *     the log of a disarmed run carries WHY it was disarmed and by whose claim.
 */
export const ALLOW_EMPTY_ENV = 'TYPECHECK_TESTS_ALLOW_EMPTY';
const BARE_TOKENS = new Set(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n']);
export const MIN_REASON_CHARS = 12;

/**
 * `envName` and `gateScript` are parameters purely so a SECOND gate built on this
 * module reports its OWN variable and its OWN regeneration command. They default
 * to this gate's, so every existing caller is unchanged.
 *
 * They are parameters rather than a copy of this function living next to the
 * other gate: the policy encoded here (scope to --write-baseline, refuse rather
 * than ignore, demand a written reason) is the thing that must not drift between
 * two gates, and a duplicated predicate is wrong at one of its copies eventually.
 * The only per-gate facts are the two strings a human is told to act on.
 */
export function classifyEmptyAllowance({
  raw,
  writeBaseline,
  envName = ALLOW_EMPTY_ENV,
  gateScript = 'scripts/ci/typecheck-tests-gate.mjs',
}) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { allowed: false, refuse: null, reason: null };

  if (!writeBaseline) {
    return {
      allowed: false,
      reason: null,
      refuse:
        `${envName} is set on a VERDICT run. It is honoured on --write-baseline only, and ` +
        `is refused here rather than ignored — a run whose plausibility control has been switched ` +
        `off must never be able to report PASS. If the measured tree is genuinely clean, regenerate ` +
        `the baseline (node ${gateScript} --write-baseline) in the same ` +
        `change; the regenerated baseline makes this control a no-op honestly. If you are seeing ` +
        `this in CI, some job definition is exporting ${envName} — remove it.`,
    };
  }

  if (
    BARE_TOKENS.has(value.toLowerCase()) ||
    value.length < MIN_REASON_CHARS ||
    !/\s/.test(value)
  ) {
    return {
      allowed: false,
      reason: null,
      refuse:
        `${envName}=${JSON.stringify(value)} is not a reason. Disabling the plausibility ` +
        `control requires a written justification of at least ${MIN_REASON_CHARS} characters and ` +
        `more than one word, which is echoed into this run's output — e.g. ` +
        `${envName}="test tree genuinely clean after PR #1234, regenerating". A control ` +
        `that can be switched off by typing "1" is one nobody has to justify switching off.`,
    };
  }

  return { allowed: true, refuse: null, reason: value };
}

// `SHRINK_TOLERANCE` is the honest cost of the derived half of the floor: some
// churn is normal, and a floor that blocks on ordinary deletion is a floor
// people disable. `FALLBACK_MIN_TEST_FILES` is the fixed half — see
// `testFileFloor` below, which takes the MAX of the two. Neither is sufficient
// alone, and the docblock there says why.
export const SHRINK_TOLERANCE = 0.9;
export const FALLBACK_MIN_TEST_FILES = 400;
// Nothing in this repository's history is within an order of magnitude of this.
// A recorded count above it is a corrupt or hand-edited baseline, and the damage
// it does is the opposite of the usual one: it makes the positive control
// PERMANENTLY RED, which is the failure mode that teaches people to delete the
// control. So it is refused with a message, not silently obeyed.
export const ABSURD_MAX_TEST_FILES = 100_000;

/**
 * Positive-control floor for the number of test files in the program.
 *
 * Two separate defects lived here.
 *
 * The first was a magic 400 against 938 real files: 57% of the test tree could
 * vanish with the control still green, and vanished files score as `fixed`, i.e.
 * PASS. That was fixed by deriving the floor from the baseline.
 *
 * The second was introduced BY that fix, and is the more interesting one: a
 * derived control is only ever as good as the value it derives from, and this
 * one had no lower bound at all. `testFileFloor(1)` returned `{floor: 0}` — a
 * floor no program can fail — while still reporting `derived: true`, i.e. while
 * still LOGGING that it was derived from the baseline and therefore trustworthy.
 * A one-character edit to a JSON file disabled the control and improved the
 * wording of the log. Hence `Math.max`: the derived floor may raise the fixed
 * one, never lower it.
 *
 * The fixed floor is an assertion about THIS repository — it has 938 test files,
 * so a program containing fewer than 400 is not a program worth measuring —
 * rather than a general constant.
 *
 * Returns `{ ok, floor, derived, reason }`. `ok: false` means the recorded value
 * is unusable and the caller must refuse: a corrupt count is not the same as an
 * ABSENT one, and quietly treating it as absent is how a broken baseline reads
 * as a working control.
 */
export function testFileFloor(baselineTestFiles) {
  // Genuinely absent — an older baseline written before the field existed. Fall
  // back, and say the floor is not derived.
  if (baselineTestFiles === undefined || baselineTestFiles === null) {
    return { ok: true, floor: FALLBACK_MIN_TEST_FILES, derived: false, reason: null };
  }
  if (typeof baselineTestFiles !== 'number' || !Number.isInteger(baselineTestFiles)) {
    return {
      ok: false,
      floor: null,
      derived: false,
      reason:
        `the baseline records testFilesInProgram = ${JSON.stringify(
          baselineTestFiles
        )}, which is ` +
        `not an integer. This value is the positive control's floor; a baseline that cannot say ` +
        `how many files it was measured over cannot validate anything. Regenerate it with ` +
        `--write-baseline rather than editing it by hand.`,
    };
  }
  if (baselineTestFiles <= 0) {
    return {
      ok: false,
      floor: null,
      derived: false,
      reason:
        `the baseline records testFilesInProgram = ${baselineTestFiles}. A baseline measured over ` +
        `zero or fewer test files is not a baseline, and deriving a floor from it yields a floor ` +
        `no program can fail. Regenerate it with --write-baseline.`,
    };
  }
  if (baselineTestFiles > ABSURD_MAX_TEST_FILES) {
    return {
      ok: false,
      floor: null,
      derived: false,
      reason:
        `the baseline records testFilesInProgram = ${baselineTestFiles}, above the sanity ceiling ` +
        `of ${ABSURD_MAX_TEST_FILES}. Deriving a floor from it would make the positive control ` +
        `permanently red, which is worse than having no control. Regenerate it with --write-baseline.`,
    };
  }

  const derivedFloor = Math.floor(baselineTestFiles * SHRINK_TOLERANCE);
  return {
    ok: true,
    floor: Math.max(FALLBACK_MIN_TEST_FILES, derivedFloor),
    // `derived` drives the wording of the log line, so it must mean "the
    // baseline actually RAISED the floor" — strictly greater, not >=. At a tie
    // the floor is the fixed one and would have been the fixed one anyway;
    // reporting it as "derived from the baseline" credits the baseline with a
    // number it did not determine, which is the same misattribution that let a
    // floor of 0 log as derived.
    derived: derivedFloor > FALLBACK_MIN_TEST_FILES,
    reason: null,
  };
}

/** Structural validation of a parsed baseline object. Returns an array of problems. */
export function validateBaseline(baseline, expectedConfig) {
  const problems = [];
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return ['baseline is not a JSON object'];
  }
  if (
    typeof baseline.files !== 'object' ||
    baseline.files === null ||
    Array.isArray(baseline.files)
  ) {
    problems.push('baseline is missing a `files` object');
  } else {
    let sum = 0;
    let summable = true;
    for (const [file, count] of Object.entries(baseline.files)) {
      if (!Number.isInteger(count) || count <= 0) {
        problems.push(`baseline entry "${file}" is not a positive integer count (got ${count})`);
        summable = false;
      } else {
        sum += count;
      }
    }
    // `totalErrors` is written by --write-baseline and read by nobody, which is
    // exactly what makes it dangerous: it is the number a human skims in review
    // and the number a hand-edit changes, and until now nothing compared it to
    // the entries it claims to summarise. A baseline whose header says 801 while
    // its body sums to 5 is not a cosmetic defect — it is a baseline that has
    // been edited by something other than the generator, and the entries are the
    // half that decides what merges.
    if (summable && baseline.totalErrors !== undefined) {
      if (!Number.isInteger(baseline.totalErrors) || baseline.totalErrors < 0) {
        problems.push(
          `baseline totalErrors is ${JSON.stringify(
            baseline.totalErrors
          )}, not a non-negative integer`
        );
      } else if (baseline.totalErrors !== sum) {
        problems.push(
          `baseline totalErrors says ${baseline.totalErrors} but its ${
            Object.keys(baseline.files).length
          } file entries sum to ${sum}. The file has been edited by hand or truncated; regenerate ` +
            'it with --write-baseline rather than reconciling the number.'
        );
      }
    }
  }
  if (baseline.config !== expectedConfig) {
    problems.push(
      `baseline was measured against "${baseline.config}", this gate runs "${expectedConfig}". ` +
        'Re-measure before trusting it.'
    );
  }
  return problems;
}

/**
 * The comparison itself. `current` and `baselineFiles` are plain
 * path -> count maps; nothing here knows where either came from.
 */
export function compare(current, baselineFiles) {
  const newlyDirty = [];
  const worsened = [];
  const improved = [];
  const fixed = [];

  const currentMap = current instanceof Map ? current : new Map(Object.entries(current ?? {}));
  const baseMap = new Map(Object.entries(baselineFiles ?? {}));

  for (const [file, count] of currentMap) {
    const was = baseMap.get(file);
    if (was === undefined) newlyDirty.push({ file, count });
    else if (count > was) worsened.push({ file, was, now: count });
    else if (count < was) improved.push({ file, was, now: count });
  }
  for (const [file, was] of baseMap) {
    if (!currentMap.has(file)) fixed.push({ file, was });
  }

  const currentTotal = [...currentMap.values()].reduce((a, b) => a + b, 0);
  const baselineTotal = [...baseMap.values()].reduce((a, b) => a + b, 0);

  return {
    newlyDirty,
    worsened,
    improved,
    fixed,
    currentTotal,
    baselineTotal,
    blocked: newlyDirty.length > 0 || worsened.length > 0,
    renames: detectRenames(newlyDirty, fixed),
  };
}

/**
 * A pure `git mv` of a baselined dirty file BLOCKS: the new path is not in the
 * baseline (-> newlyDirty) and the old one is gone (-> fixed). That is reported,
 * not silently forgiven — an auto-pass on "looks like a rename" is a hole a real
 * regression fits through, since nothing here can see file CONTENT.
 *
 * What it does instead is name the probable former path in the block message, so
 * the author is told the remedy (`--write-baseline`) instead of hunting a
 * regression that is not there. Matching is on basename + identical count, and
 * an AMBIGUOUS match (two candidates sharing a basename) yields no claim at all
 * rather than a confident wrong one.
 */
export function detectRenames(newlyDirty, fixed) {
  const byBasename = new Map();
  for (const entry of fixed) {
    const base = entry.file.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(entry);
  }

  const renames = [];
  for (const { file, count } of newlyDirty) {
    const base = file.split('/').pop();
    const candidates = (byBasename.get(base) ?? []).filter((c) => c.was === count);
    if (candidates.length === 1) renames.push({ from: candidates[0].file, to: file, count });
  }
  return renames;
}

/**
 * Assert that `tsconfig.tests.json`'s exclude list is the base config's list
 * minus exactly one entry.
 *
 * The two lists are written out verbatim, so a future addition to
 * `tsconfig.json`'s exclude silently fails to apply to the measurement program
 * and NOTHING notices — the two programs quietly stop being the same program
 * minus one line, which is the only property that makes the 801 trustworthy.
 */
export function diffExcludes(baseExclude, testsExclude, expectedRemoved) {
  const base = [...(baseExclude ?? [])];
  const tests = [...(testsExclude ?? [])];
  const removed = base.filter((e) => !tests.includes(e));
  const added = tests.filter((e) => !base.includes(e));
  const ok = added.length === 0 && removed.length === 1 && removed[0] === expectedRemoved;
  return { ok, removed, added };
}

/**
 * Strip comments from a tsconfig so `JSON.parse` can read it. Handles `//` and
 * `/* *\/` outside of string literals, and trailing commas.
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
