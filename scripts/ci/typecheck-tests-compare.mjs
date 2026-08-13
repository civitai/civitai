/**
 * The pure, side-effect-free half of `typecheck-tests-gate.mjs`.
 *
 * It lives in its own module for one reason: every function here is a place the
 * gate can produce a CONFIDENT WRONG ANSWER, and none of them should require a
 * multi-minute `tsc` run to exercise. `scripts/__tests__/typecheck-tests-gate.test.ts`
 * drives them directly.
 *
 * Nothing in this file reads the filesystem, spawns a process, or exits.
 */
import path from 'node:path';

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
 * Returns `{ counts, total, formats, sawAnyErrorTs }`:
 *   counts        Map<repo-relative posix path, number>
 *   total         sum of counts
 *   formats       Set of the diagnostic formats actually matched
 *   sawAnyErrorTs how many lines contain the literal marker at all — the
 *                 positive control on the parser itself. `sawAnyErrorTs > 0`
 *                 with `total === 0` means the output HAS diagnostics in a shape
 *                 this parser does not understand; that is not "clean".
 */
export function parseDiagnostics(output) {
  const counts = new Map();
  const formats = new Set();
  let total = 0;
  let sawAnyErrorTs = 0;

  for (const rawLine of String(output ?? '').split('\n')) {
    const line = rawLine.replace(ANSI, '');
    if (!line.includes('error TS')) continue;
    sawAnyErrorTs++;
    const plain = PLAIN_DIAG.exec(line);
    const m = plain ?? PRETTY_DIAG.exec(line);
    if (!m) continue;
    formats.add(plain ? 'plain' : 'pretty');
    total++;
    const file = m[1].split(path.sep).join('/').replace(/^\.\//, '');
    counts.set(file, (counts.get(file) || 0) + 1);
  }

  return { counts, total, formats, sawAnyErrorTs };
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
  if (parsed.sawAnyErrorTs > 0 && parsed.total === 0) {
    return {
      ok: false,
      reason:
        `${parsed.sawAnyErrorTs} output line(s) contain "error TS" but NONE parsed into a ` +
        `file/line diagnostic. The parser is blind to this output's format; a zero from it ` +
        `is a fact about the parser, not about the code.`,
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
export function checkPlausibility({ currentTotal, baselineTotal, allowEmpty = false }) {
  if (baselineTotal > 0 && currentTotal === 0 && !allowEmpty) {
    return {
      ok: false,
      reason:
        `the baseline records ${baselineTotal} error(s) but this run parsed 0. A checker that ` +
        `reports zero where the baseline says ${baselineTotal} has almost certainly not measured ` +
        `anything. If the test tree really is clean now, re-run with ` +
        `TYPECHECK_TESTS_ALLOW_EMPTY=1 (and regenerate the baseline in the same change).`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Positive-control floor for the number of test files in the program.
 *
 * Derived from the count STORED IN THE BASELINE rather than a magic constant. A
 * fixed floor of 400 against 938 real files meant 57% of the test tree could
 * vanish with the control still green — and vanished files score as `fixed`, so
 * the gate would have PASSED while measuring a little over a third of its
 * population. The floor now tracks whatever the baseline was measured over.
 *
 * `SHRINK_TOLERANCE` is the honest cost: some churn is normal, and a floor that
 * blocks on ordinary deletion is a floor people disable.
 */
export const SHRINK_TOLERANCE = 0.9;
export const FALLBACK_MIN_TEST_FILES = 400;

export function testFileFloor(baselineTestFiles) {
  if (!Number.isInteger(baselineTestFiles) || baselineTestFiles <= 0) {
    return { floor: FALLBACK_MIN_TEST_FILES, derived: false };
  }
  return { floor: Math.floor(baselineTestFiles * SHRINK_TOLERANCE), derived: true };
}

/** Structural validation of a parsed baseline object. Returns an array of problems. */
export function validateBaseline(baseline, expectedConfig) {
  const problems = [];
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return ['baseline is not a JSON object'];
  }
  if (typeof baseline.files !== 'object' || baseline.files === null || Array.isArray(baseline.files)) {
    problems.push('baseline is missing a `files` object');
  } else {
    for (const [file, count] of Object.entries(baseline.files)) {
      if (!Number.isInteger(count) || count <= 0) {
        problems.push(`baseline entry "${file}" is not a positive integer count (got ${count})`);
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
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
