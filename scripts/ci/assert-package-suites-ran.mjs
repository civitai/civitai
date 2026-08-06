#!/usr/bin/env node
/**
 * Positive control for the `Workspace unit tests` CI job.
 *
 * A green vitest run is not evidence that anything ran. Three ways this job could report
 * success having tested nothing, all of which produce exit code 0:
 *
 *   - the `--project '@civitai/*'` filter matches no project (a rename, a quoting change,
 *     a Vitest version that reads the pattern differently) — vitest exits 0 on an empty
 *     selection;
 *   - the `packages/<pkg>/vitest.config.*` / `apps/<app>/vitest.config.*` globs in the root
 *     config stop resolving, so the projects are simply absent;
 *   - one workspace package quietly drops out — its config is renamed or its `include` stops
 *     matching — while the other twelve keep the totals looking healthy.
 *
 * So this reads the run's JSON report and asserts a LEDGER rather than a floor: every
 * workspace package that has a vitest config AND at least one test file on disk must appear
 * in the results with at least one test. The check fails when that set SHRINKS, which is the
 * regression, and adapts on its own when a fourteenth package is added.
 *
 * "Workspace package" means BOTH roots `pnpm-workspace.yaml` declares — `packages/*` and
 * `apps/*`. Scanning only `packages/` (which is what this did until the `apps/*` suites were
 * brought into CI) is not a loud failure: it is a ledger that structurally CANNOT observe an
 * `apps/*` regression, so the four app suites could have silently dropped back out of the run
 * and this check would still have printed OK. The roots are listed once, in WORKSPACE_ROOTS.
 *
 * Usage:  node scripts/ci/assert-package-suites-ran.mjs <vitest-json-report>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: assert-package-suites-ran.mjs <vitest-json-report>');
  process.exit(2);
}

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// The two workspace roots from `pnpm-workspace.yaml` (`.` is the app itself, covered by the
// separate `unit` project). Adding a third root here is the whole change needed to extend the
// ledger to it — the scan, the report matcher and the printed table all read this list.
const WORKSPACE_ROOTS = ['packages', 'apps'];

/**
 * Any test file anywhere under a package, recursively.
 *
 * Both halves of this are deliberately WIDE, because this function decides what the ledger
 * EXPECTS — and anything it fails to see is a package the ledger can never notice going
 * missing. A narrow rule here does not produce a loud error; it silently shrinks the thing
 * the check is checking.
 *
 * So: the whole package directory, not just `src/` (a package that keeps its tests in a
 * top-level `__tests__/` was invisible), and every extension Vitest will collect, not just
 * `.test.ts`/`.spec.tsx` (`.mts`, `.cts` and plain `.js` were invisible).
 */
const TEST_FILE = /\.(test|spec)\.(c|m)?(t|j)sx?$/;

function hasTestFile(dir) {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (hasTestFile(full)) return true;
    } else if (TEST_FILE.test(entry.name)) {
      return true;
    }
  }
  return false;
}

// Keyed `<root>/<dir>` (e.g. `packages/civitai-redis`, `apps/auth`) so the two roots cannot
// collide on a shared basename and so the printed table says which root a suite came from.
const expected = WORKSPACE_ROOTS.flatMap((root) => {
  const rootDir = join(repoRoot, root);
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      const dir = join(rootDir, name);
      const hasConfig = ['vitest.config.ts', 'vitest.config.mts'].some((f) =>
        existsSync(join(dir, f))
      );
      return hasConfig && hasTestFile(dir);
    })
    .map((name) => `${root}/${name}`);
}).sort();

// Per-root, not just overall: an `apps/` root that scans to zero is exactly the silent
// coverage hole this extension exists to close, and an overall non-zero total would hide it
// behind the nine `packages/` entries.
const emptyRoots = WORKSPACE_ROOTS.filter(
  (root) => !expected.some((key) => key.startsWith(`${root}/`))
);
if (emptyRoots.length > 0) {
  console.error(
    `FAIL: workspace root(s) ${emptyRoots.join(', ')} scanned to zero packages with both a ` +
      'vitest config and a test file. This check cannot have measured them — it is running ' +
      "from the wrong directory, or that root's layout changed. Fix the scan or drop the " +
      'root from WORKSPACE_ROOTS deliberately; do not leave it silently unmeasured.'
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`FAIL: could not read the vitest JSON report at ${reportPath}: ${error.message}`);
  console.error('An unreadable report is not a pass; the run may not have produced one at all.');
  process.exit(1);
}

// A SKIPPED test is not an executed one. Counting `assertionResults.length` meant a package
// that self-skipped in its entirety still satisfied the ledger — and self-skipping on a
// missing DATABASE_URL is exactly the pattern several of these suites use, so the failure
// mode is live rather than hypothetical. `executed` is what the ledger requires to be
// non-zero; `skipped` is reported beside it so a package quietly turning itself off is
// visible rather than merely absent from the arithmetic.
const EXECUTED = new Set(['passed', 'failed']);

// Built from WORKSPACE_ROOTS so the matcher and the scan can never disagree about which roots
// count — a hardcoded `packages/` here was the whole reason an `apps/*` dropout was invisible.
const ROOT_MATCH = new RegExp(`(?:^|/)(${WORKSPACE_ROOTS.join('|')})/([^/]+)/`);

const ran = new Map(); // `<root>/<dir>` -> { files, executed, skipped }
for (const result of report.testResults ?? []) {
  const match = ROOT_MATCH.exec(result.name ?? '');
  if (!match) continue;
  const key = `${match[1]}/${match[2]}`;
  const entry = ran.get(key) ?? { files: 0, executed: 0, skipped: 0 };
  entry.files += 1;
  for (const assertion of result.assertionResults ?? []) {
    if (EXECUTED.has(assertion.status)) entry.executed += 1;
    else entry.skipped += 1;
  }
  ran.set(key, entry);
}

const missing = expected.filter((name) => !ran.has(name) || ran.get(name).executed === 0);

console.log(`workspace packages with a vitest config and tests on disk : ${expected.length}`);
console.log(`workspace packages that appear in the run                 : ${ran.size}`);
for (const name of expected) {
  const entry = ran.get(name);
  const detail = entry
    ? `${entry.files} file(s), ${entry.executed} executed` +
      (entry.skipped > 0 ? `, ${entry.skipped} skipped` : '')
    : 'did not run';
  console.log(`  ${missing.includes(name) ? 'MISSING' : '     ok'}  ${name.padEnd(34)} ${detail}`);
}
console.log(
  `totals: ${report.numTotalTestSuites ?? '?'} suite(s), ${report.numTotalTests ?? 0} test(s), ` +
    `${report.numFailedTests ?? 0} failed, ${report.numPendingTests ?? 0} skipped`
);

if (missing.length > 0) {
  console.error(
    `\nFAIL: ${missing.length} workspace suite(s) executed no tests: ${missing.join(', ')}.\n` +
      'The job reported success without running them. Either the project was not selected ' +
      '(check the `packages/*/vitest.config.*` AND `apps/*/vitest.config.*` globs in the root ' +
      "vitest.config.mts and the --project '@civitai/*' filter — an app whose package.json " +
      '`name` stops being `@civitai/`-scoped drops out of that filter silently), or the suite ' +
      'skipped itself in its entirety — a wholly-skipped package is not a package that ran.'
  );
  process.exit(1);
}

// A floor as well as the ledger: the ledger passes if every package contributes one test,
// which is not the same as the suites being intact.
//
// 1000 against 1314 executed today (957 from `packages/*`, 361 from `apps/*`). Deliberately
// set ABOVE the packages-only total, so if every `apps/*` project vanished at once the floor
// fires even in the case where the ledger somehow did not — two independent tripwires on the
// regression this change exists to prevent, rather than one. Raise it when the corpus grows;
// do not lower it to make a red run green.
const MIN_TESTS = 1000;
const totalExecuted = [...ran.values()].reduce((sum, e) => sum + e.executed, 0);
if (totalExecuted < MIN_TESTS) {
  console.error(
    `\nFAIL: ${totalExecuted} tests executed, expected at least ${MIN_TESTS}. Every package ` +
      'is present, so this is a suite that collapsed rather than a project that vanished.'
  );
  process.exit(1);
}

console.log('\nOK: every workspace suite with tests on disk executed.');
