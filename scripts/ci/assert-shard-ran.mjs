#!/usr/bin/env node
/**
 * Positive control for a SHARDED `Unit tests` job.
 *
 * Sharding introduces a failure this suite did not previously have: a `--shard=i/N`
 * expression that selects no files. Vitest exits 0 on an empty selection, the step is
 * green, the check is green, and nothing anywhere says the shard tested nothing. Four
 * green checks then read exactly like four green checks that ran 16,000 tests.
 *
 * That is the same silent-zero class this repo has been bitten by before — a suite that
 * fails to IMPORT reports "no tests" rather than a failure — and the reason every count
 * here is asserted rather than printed.
 *
 * Ways a shard reports success having run nothing, EXIT CODE 0 AND ALL:
 *
 *   - the shard index/total in the workflow drifts out of step with the matrix (a matrix
 *     grown to 6 while the `/4` denominator stays), so high shards select nothing;
 *   - `--shard` stops being forwarded — `scripts/test-unit-run.mjs` passes
 *     `process.argv.slice(2)` through to vitest, and if that ever changes, every shard
 *     silently runs the WHOLE suite instead. That is the inverse failure and it is also
 *     caught here: a shard carrying ~the full suite is not a shard;
 *   - the `unit*` projects stop resolving, so every shard is empty at once.
 *
 * This deliberately checks ONE shard from inside that shard's own job, rather than summing
 * across shards in a dependent job. Summing needs artifact upload/download and a job that
 * runs after all four, which fails open the moment `fail-fast` cancels a sibling — the
 * check would be skipped exactly when something went wrong. A per-shard assertion runs
 * under `if: always()` and cannot be skipped by a sibling's failure.
 *
 * Usage:  node scripts/ci/assert-shard-ran.mjs <vitest-json-report> <shard-index> <shard-total>
 */
import { readFileSync, existsSync } from 'node:fs';

const [reportPath, shardRaw, totalRaw] = process.argv.slice(2);
const shard = Number(shardRaw);
const total = Number(totalRaw);

if (!reportPath || !Number.isInteger(shard) || !Number.isInteger(total) || total < 1) {
  console.error('usage: assert-shard-ran.mjs <vitest-json-report> <shard-index> <shard-total>');
  process.exit(2);
}
if (shard < 1 || shard > total) {
  console.error(`shard ${shard} is outside 1..${total} — the matrix and the denominator disagree.`);
  process.exit(2);
}

/**
 * The full unit suite measured 16,784 tests across 1,065 files on 2026-08-15
 * (claudedocs/test-perf-measurement-envelope-2026-08-15.md). Per shard at N=4 that is
 * ~4,196, but the split is by FILE and this suite's per-file test counts are uneven, so a
 * floor set near the mean would be flaky. It is set at 1,000 — comfortably under any real
 * shard, comfortably over zero — because the regression being caught is a shard that
 * collapses, not a shard that is 15% light.
 *
 * 🔴 Raise this deliberately, never to make a red run green. If a shard legitimately drops
 * below it, the split has become badly unbalanced and THAT is the finding.
 */
const MIN_TESTS_PER_SHARD = 1000;

/**
 * The inverse guard. If `--shard` stops reaching vitest, every shard runs the whole suite:
 * 4x the cost, four green checks, no error. A shard carrying more than this many tests is
 * not a shard. Set above a generous shard (~4,196 at N=4, doubled for imbalance) and well
 * under the full suite, so it separates the two cases without being tripped by skew.
 */
const MAX_TESTS_PER_SHARD = 9000;

if (!existsSync(reportPath)) {
  console.error(
    `${reportPath} does not exist — the run produced no JSON report.\n` +
      'That is NOT a passing shard: it means vitest did not get far enough to write one.'
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  console.error(`${reportPath} is not valid JSON (${err.message}) — cannot verify this shard ran.`);
  process.exit(1);
}

// 🔴 EXECUTED, NOT TOTAL. `report.numTotalTests` counts SKIPPED tests too, so a shard whose
// files all self-skip would satisfy a total-based floor while executing nothing — the exact
// hole scripts/ci/assert-workspace-suites-ran.mjs documents having had, where a package
// self-skipping on a missing DATABASE_URL still satisfied its ledger. Several suites here
// self-skip on absent env, so that failure mode is live rather than hypothetical.
//
// A shard that ran and went RED still counts as executed: this asserts that work HAPPENED,
// not that it succeeded. The suite step above owns the pass/fail verdict.
const EXECUTED = new Set(['passed', 'failed']);
let executed = 0;
let skipped = 0;
for (const result of report.testResults ?? []) {
  for (const assertion of result.assertionResults ?? []) {
    if (EXECUTED.has(assertion.status)) executed += 1;
    else skipped += 1;
  }
}
const numTotalTests = executed;
const numFiles = Array.isArray(report.testResults) ? report.testResults.length : 0;

console.log(
  `shard ${shard}/${total}: ${executed} executed, ${skipped} skipped, across ${numFiles} files ` +
    `(report.numTotalTests=${report.numTotalTests ?? '?'})`
);

if (numTotalTests === 0) {
  console.error(
    `\nSHARD ${shard}/${total} RAN ZERO TESTS.\n` +
      'A `--shard` expression that matches no files exits 0 and reports green, so this is a\n' +
      'silent failure, not a pass. Check that the matrix and the `/N` denominator agree, and\n' +
      'that the `unit*` projects still resolve.'
  );
  process.exit(1);
}

if (numTotalTests < MIN_TESTS_PER_SHARD) {
  console.error(
    `\nSHARD ${shard}/${total} ran only ${numTotalTests} tests (floor ${MIN_TESTS_PER_SHARD}).\n` +
      'Too few to be a real quarter of this suite. Either the split has become badly\n' +
      "unbalanced — read the other shards' durations — or files stopped being collected.\n" +
      'Do NOT lower the floor to make this green.'
  );
  process.exit(1);
}

if (numTotalTests > MAX_TESTS_PER_SHARD) {
  console.error(
    `\nSHARD ${shard}/${total} ran ${numTotalTests} tests (ceiling ${MAX_TESTS_PER_SHARD}).\n` +
      'That is too many to be one shard: `--shard` is probably not reaching vitest, so every\n' +
      'shard is running the WHOLE suite — 4x the runner cost, all of it green, no error.\n' +
      'Check that scripts/test-unit-run.mjs still forwards process.argv.slice(2).'
  );
  process.exit(1);
}
