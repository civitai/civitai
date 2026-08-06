#!/usr/bin/env node
/**
 * Positive control for the `Package unit tests` CI job.
 *
 * A green vitest run is not evidence that anything ran. Three ways this job could report
 * success having tested nothing, all of which produce exit code 0:
 *
 *   - the `--project '@civitai/*'` filter matches no project (a rename, a quoting change,
 *     a Vitest version that reads the pattern differently) — vitest exits 0 on an empty
 *     selection;
 *   - the `packages/<pkg>/vitest.config.*` globs in the root config stop resolving, so the
 *     projects are simply absent;
 *   - one package quietly drops out — its config is renamed or its `include` stops matching
 *     — while the other eight keep the totals looking healthy.
 *
 * So this reads the run's JSON report and asserts a LEDGER rather than a floor: every
 * workspace package that has a vitest config AND at least one test file on disk must appear
 * in the results with at least one test. The check fails when that set SHRINKS, which is the
 * regression, and adapts on its own when a tenth package is added.
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
const packagesDir = join(repoRoot, 'packages');

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

const expected = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    const dir = join(packagesDir, name);
    const hasConfig = ['vitest.config.ts', 'vitest.config.mts'].some((f) =>
      existsSync(join(dir, f))
    );
    return hasConfig && hasTestFile(dir);
  })
  .sort();

if (expected.length === 0) {
  console.error(
    'FAIL: found no workspace package with both a vitest config and a test file. This check ' +
      'cannot have measured anything — it is running from the wrong directory, or the ' +
      'packages/ layout changed.'
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

const ran = new Map(); // package name -> { files, executed, skipped }
for (const result of report.testResults ?? []) {
  const match = /(?:^|\/)packages\/([^/]+)\//.exec(result.name ?? '');
  if (!match) continue;
  const entry = ran.get(match[1]) ?? { files: 0, executed: 0, skipped: 0 };
  entry.files += 1;
  for (const assertion of result.assertionResults ?? []) {
    if (EXECUTED.has(assertion.status)) entry.executed += 1;
    else entry.skipped += 1;
  }
  ran.set(match[1], entry);
}

const missing = expected.filter((name) => !ran.has(name) || ran.get(name).executed === 0);

console.log(`packages with a vitest config and tests on disk : ${expected.length}`);
console.log(`packages that appear in the run                 : ${ran.size}`);
for (const name of expected) {
  const entry = ran.get(name);
  const detail = entry
    ? `${entry.files} file(s), ${entry.executed} executed` +
      (entry.skipped > 0 ? `, ${entry.skipped} skipped` : '')
    : 'did not run';
  console.log(`  ${missing.includes(name) ? 'MISSING' : '     ok'}  ${name.padEnd(28)} ${detail}`);
}
console.log(
  `totals: ${report.numTotalTestSuites ?? '?'} suite(s), ${report.numTotalTests ?? 0} test(s), ` +
    `${report.numFailedTests ?? 0} failed, ${report.numPendingTests ?? 0} skipped`
);

if (missing.length > 0) {
  console.error(
    `\nFAIL: ${missing.length} package suite(s) executed no tests: ${missing.join(', ')}.\n` +
      'The job reported success without running them. Either the project was not selected ' +
      '(check the `packages/*/vitest.config.*` globs in the root vitest.config.mts and the ' +
      "--project '@civitai/*' filter), or the suite skipped itself in its entirety — a " +
      'wholly-skipped package is not a package that ran.'
  );
  process.exit(1);
}

// A floor as well as the ledger: the ledger passes if every package contributes one test,
// which is not the same as the suites being intact.
const MIN_TESTS = 500;
const totalExecuted = [...ran.values()].reduce((sum, e) => sum + e.executed, 0);
if (totalExecuted < MIN_TESTS) {
  console.error(
    `\nFAIL: ${totalExecuted} tests executed, expected at least ${MIN_TESTS}. Every package ` +
      'is present, so this is a suite that collapsed rather than a project that vanished.'
  );
  process.exit(1);
}

console.log('\nOK: every package suite with tests on disk executed.');
