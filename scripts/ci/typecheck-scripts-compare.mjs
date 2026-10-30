/**
 * The pure, side-effect-free half of `typecheck-scripts-gate.mjs`.
 *
 * Everything region-agnostic — diagnostic parsing, run classification,
 * plausibility, the ratchet comparison, rename detection, baseline validation,
 * the tsconfig comment stripper — is IMPORTED from
 * `typecheck-tests-compare.mjs` and re-exported here, not copied. Those
 * functions are where a confident wrong answer gets produced, they were each
 * fixed once already in response to a real defect, and a second copy would
 * regenerate every one of those defects on its own schedule.
 *
 * What lives here is only what genuinely differs between the two gates:
 *
 *   - which files the gate is RESPONSIBLE for (`scripts/`, not `src/**\/__tests__/`);
 *   - how the positive control counts them, which needs the repo root because
 *     `/scripts/` is an ambiguous substring in this repo (see below);
 *   - the positive control's floor constants, which are assertions about the
 *     size of THIS population;
 *   - `diffLists`, because this config's delta from the base is a SET of
 *     excluded files rather than the single entry `diffExcludes` pins.
 *
 * Nothing in this file reads the filesystem, spawns a process, or exits, and
 * nothing in it reads `path.sep` — see `toPosixPath` in the imported module for
 * why that is load-bearing rather than incidental.
 */
import { NODE_MODULES_SEGMENT, toPosixPath } from './typecheck-tests-compare.mjs';

export {
  ALLOW_EMPTY_ENV as TESTS_ALLOW_EMPTY_ENV,
  checkPlausibility,
  classifyEmptyAllowance,
  classifyRun,
  compare,
  detectRenames,
  parseDiagnostics,
  stripJsonComments,
  toPosixPath,
  validateBaseline,
} from './typecheck-tests-compare.mjs';

/** This gate's own plausibility escape hatch. Distinct from the tests gate's. */
export const ALLOW_EMPTY_ENV = 'TYPECHECK_SCRIPTS_ALLOW_EMPTY';
export const GATE_SCRIPT = 'scripts/ci/typecheck-scripts-gate.mjs';

/**
 * Files under the repo-root `scripts/` directory are this gate's business, and
 * nothing else is. Diagnostic paths from `tsc` are already repo-relative, so the
 * anchor is all that is needed.
 *
 * Errors in `src/` or `packages/` belong to `pnpm typecheck`, which blocks on
 * them directly; claiming them here would demand a baseline entry for an error
 * the root check already fails on.
 */
export const SCRIPTS_PATH_RE = /^scripts\//;

/** Is this diagnostic path one this gate is responsible for? */
export function isGatedScriptFile(file) {
  return SCRIPTS_PATH_RE.test(toPosixPath(file));
}

/**
 * Make an absolute path from `tsc --listFilesOnly` repo-relative, or return null
 * if it does not live under `repoRoot`.
 *
 * `tsc` prints absolute paths here, and the repo root is stripped by TEXT rather
 * than by `path.relative` so this stays a pure function over strings. The
 * trailing separator matters: without it a sibling directory named
 * `<repo>-worktree` would prefix-match the repo root and have its files counted
 * as if they were ours.
 */
export function relativizeToRepo(line, repoRoot) {
  const p = toPosixPath(line).trim();
  if (!p) return null;
  const root = toPosixPath(repoRoot).replace(/\/+$/, '');
  if (!root) return null;
  const prefix = `${root}/`;
  if (!p.startsWith(prefix)) return null;
  return p.slice(prefix.length);
}

/**
 * Does this `--listFilesOnly` line name a file the positive control should count?
 *
 * 🔴 The substring test the sibling gate uses (`p.includes('/__tests__/')`) is
 * NOT safe for this one, and that is the reason this function takes a repo root
 * at all. `/scripts/` appears in paths that are NOT the population being
 * measured — `.claude/skills/dev-server/scripts/daemon.mjs` and four of its
 * siblings are pulled into the program transitively, and every vendored package
 * with a `scripts/` directory would match too. A substring control would count
 * those, so it could stay green while the entire repo-root `scripts/` tree
 * dropped out of the program — a positive control that cannot fail is not one.
 *
 * Anchoring at the repo root is what makes the count mean "the files this gate
 * measures". `node_modules` is excluded on the already-relativized path.
 */
export function isScriptFileLine(line, repoRoot) {
  const rel = relativizeToRepo(line, repoRoot);
  if (rel === null) return false;
  if (`/${rel}`.includes(NODE_MODULES_SEGMENT)) return false;
  return SCRIPTS_PATH_RE.test(rel);
}

/**
 * The positive control's measurement: how many files under the repo-root
 * `scripts/` directory the program actually contains, given raw
 * `--listFilesOnly` output.
 */
export function countScriptFilesInProgram(output, repoRoot) {
  return String(output ?? '')
    .split('\n')
    .filter((line) => isScriptFileLine(line, repoRoot)).length;
}

// `SHRINK_TOLERANCE` is the honest cost of the derived half of the floor: some
// churn is normal, and a floor that blocks on ordinary deletion is a floor
// people disable. `FALLBACK_MIN_SCRIPT_FILES` is the fixed half.
//
// The fixed value is an assertion about THIS population and is deliberately much
// smaller than the sibling gate's 400: `tsconfig.scripts.json` contains 38 files
// under `scripts/`, not 938. It is set below the real count by enough that
// ordinary growth and deletion do not trip it, and far enough above zero that a
// program which has lost the tree cannot pass.
export const SHRINK_TOLERANCE = 0.9;
export const FALLBACK_MIN_SCRIPT_FILES = 20;
export const ABSURD_MAX_SCRIPT_FILES = 100_000;

/**
 * Positive-control floor for the number of `scripts/` files in the program.
 *
 * Identical in shape and in reasoning to `testFileFloor` in the sibling module,
 * and it is a separate function ONLY because both constants differ. The two
 * defects that module records are both defended against here:
 *
 *  - a bare fixed floor lets most of the population vanish while staying green,
 *    and vanished files score as `fixed`, i.e. PASS. Hence the derived half.
 *  - a purely derived floor is only as good as a number in a JSON file:
 *    `scriptFileFloor(1)` would yield a floor of ZERO while still reporting
 *    `derived: true`. Hence `Math.max` — the derived floor may RAISE the fixed
 *    one, never lower it.
 *
 * A corrupt, negative or absurd recorded count is refused, not silently
 * downgraded to the fallback: a broken baseline must not read as a working
 * control.
 */
export function scriptFileFloor(baselineScriptFiles) {
  if (baselineScriptFiles === undefined || baselineScriptFiles === null) {
    return { ok: true, floor: FALLBACK_MIN_SCRIPT_FILES, derived: false, reason: null };
  }
  if (typeof baselineScriptFiles !== 'number' || !Number.isInteger(baselineScriptFiles)) {
    return {
      ok: false,
      floor: null,
      derived: false,
      reason:
        `the baseline records scriptFilesInProgram = ${JSON.stringify(
          baselineScriptFiles
        )}, which ` +
        `is not an integer. This value is the positive control's floor; a baseline that cannot say ` +
        `how many files it was measured over cannot validate anything. Regenerate it with ` +
        `--write-baseline rather than editing it by hand.`,
    };
  }
  if (baselineScriptFiles <= 0) {
    return {
      ok: false,
      floor: null,
      derived: false,
      reason:
        `the baseline records scriptFilesInProgram = ${baselineScriptFiles}. A baseline measured ` +
        `over zero or fewer files is not a baseline, and deriving a floor from it yields a floor ` +
        `no program can fail. Regenerate it with --write-baseline.`,
    };
  }
  if (baselineScriptFiles > ABSURD_MAX_SCRIPT_FILES) {
    return {
      ok: false,
      floor: null,
      derived: false,
      reason:
        `the baseline records scriptFilesInProgram = ${baselineScriptFiles}, above the sanity ` +
        `ceiling of ${ABSURD_MAX_SCRIPT_FILES}. Deriving a floor from it would make the positive ` +
        `control permanently red, which is worse than having no control. Regenerate it with ` +
        `--write-baseline.`,
    };
  }

  const derivedFloor = Math.floor(baselineScriptFiles * SHRINK_TOLERANCE);
  return {
    ok: true,
    floor: Math.max(FALLBACK_MIN_SCRIPT_FILES, derivedFloor),
    // Strictly greater, not >=: at a tie the floor is the fixed one and would
    // have been the fixed one anyway, and reporting it as "derived" credits the
    // baseline with a number it did not determine.
    derived: derivedFloor > FALLBACK_MIN_SCRIPT_FILES,
    reason: null,
  };
}

/**
 * Assert that `tsconfig.scripts.json`'s exclude list is the base config's list
 * minus exactly the quarantined entries, and nothing else.
 *
 * The sibling gate pins a single removed entry (`diffExcludes`); this one pins a
 * SET, because the quarantine holds five files and will hold fewer over time.
 * Both lists are written out verbatim in their configs, so without this control
 * an addition to the base exclude list silently fails to reach the measurement
 * program and NOTHING notices — the two programs quietly stop being "the same
 * program with the quarantine added back", which is the only property that makes
 * the measured number mean anything.
 *
 * `expectedRemoved` is compared as a SET: order is not meaningful in a tsconfig
 * list, and pinning it would turn a cosmetic reordering into a CANNOT MEASURE.
 */
export function diffLists(baseList, variantList, expectedRemoved) {
  const base = [...(baseList ?? [])];
  const variant = [...(variantList ?? [])];
  const variantSet = new Set(variant);
  const baseSet = new Set(base);

  const removed = base.filter((e) => !variantSet.has(e));
  const added = variant.filter((e) => !baseSet.has(e));

  const expected = new Set(expectedRemoved ?? []);
  const missing = [...expected].filter((e) => !removed.includes(e));
  const unexpected = removed.filter((e) => !expected.has(e));

  return {
    ok: added.length === 0 && missing.length === 0 && unexpected.length === 0,
    removed,
    added,
    missing,
    unexpected,
  };
}
