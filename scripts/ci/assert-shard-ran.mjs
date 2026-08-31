#!/usr/bin/env node
/**
 * Positive control for a SHARDED `Unit tests` job.
 *
 * Sharding introduces a failure this suite did not previously have: a `--shard=i/N`
 * expression that selects no files. Vitest exits 0 on an empty selection, the step is
 * green, the check is green, and nothing anywhere says the shard tested nothing. Four
 * green checks then read exactly like four green checks that ran 22,000 tests.
 *
 * That is the same silent-zero class this repo has been bitten by before — a suite that
 * fails to IMPORT reports "no tests" rather than a failure — and the reason every count
 * here is asserted rather than printed.
 *
 * It has already earned its keep: on this job's first live run it failed all four shards
 * while `Unit tests` reported SUCCESS. `pnpm run … -- --shard=…` forwards the `--`
 * literally, vitest DISCARDS every argument after it, and so both `--shard` and
 * `--outputFile` were silently dropped — each runner executed the entire suite and wrote
 * no report.
 *
 * Ways a shard reports success having run nothing, EXIT CODE 0 AND ALL:
 *
 *   - the shard index/total in the workflow drifts out of step with the matrix (a matrix
 *     grown to 6 while the `/4` denominator stays), so high shards select nothing;
 *   - `--shard` stops reaching vitest, so every shard runs the WHOLE suite instead. That
 *     is the inverse failure and it is also caught here, by the ceiling;
 *   - the `unit*` projects stop resolving, so every shard is empty at once.
 *
 * This deliberately checks ONE shard from inside that shard's own job, rather than summing
 * across shards in a dependent job. Summing needs artifact upload/download and a job that
 * runs after all four, which fails open the moment a sibling is cancelled — the check would
 * be skipped exactly when something went wrong.
 *
 * Usage:  node scripts/ci/assert-shard-ran.mjs <vitest-json-report> <shard-index> <shard-total>
 */
import { readFileSync, existsSync } from 'node:fs';

const [reportPath, shardRaw, totalRaw] = process.argv.slice(2);
const shard = Number(shardRaw);
const total = Number(totalRaw);

if (!reportPath || !Number.isInteger(shard) || !Number.isInteger(total)) {
  console.error('usage: assert-shard-ran.mjs <vitest-json-report> <shard-index> <shard-total>');
  process.exit(2);
}
// 🔴 THERE IS DELIBERATELY NO `total < 1` CLAUSE HERE. One used to be, and a mutation sweep
// showed it could not be killed: the range check immediately below requires
// 1 <= shard <= total, which already implies total >= 1, so `total=0` and `total=-4` exit 2
// either way — and with a strictly better message ("shard 1 is outside 1..0") than the
// generic usage line. It was not protection, only message-shaping, and an unkillable clause
// invites the next reader to believe a guard exists where none does. Do not re-add it.
if (shard < 1 || shard > total) {
  console.error(`shard ${shard} is outside 1..${total} — the matrix and the denominator disagree.`);
  process.exit(2);
}

/**
 * 🔴 THE BOUNDS SCALE WITH `total`, and that is the point. An earlier revision hardcoded a
 * floor and ceiling derived for N=4 from a suite size ten days stale. Two consequences, both
 * real rather than theoretical: a legitimate move to N=2 would have tripped the ceiling and
 * N>=16 the floor — changes the workflow comment explicitly invites — and ordinary suite
 * growth was on course to trip the ceiling on all four shards within weeks, printing a
 * confident and WRONG "`--shard` is probably not reaching vitest".
 *
 * BASE_TESTS is the whole suite's executed count, and it is the one number here that goes
 * stale. Measured 2026-08-25 from this job's own output across a green sharded run:
 * 5794 + 5142 + 5774 + 5447 = 22,157 executed (+25 skipped) across 1,417 files. The
 * previous figure, 16,784 across 1,065 files, was ten days older and 32% low.
 *
 * 🔴 So the ceiling message below names BOTH causes, and must keep doing so. "The suite
 * grew" and "sharding broke" are indistinguishable from inside one shard, and a gate that
 * asserts the wrong one of the two is worse than no gate — it sends the next person hunting
 * a bug that is not there.
 */
const BASE_TESTS = 22157;
const expected = BASE_TESTS / total;

/** Generous: catches a shard that collapsed, not one that is merely light. Observed
 *  imbalance on a real run was ~5% off the mean (5794 vs 5539 expected). */
const MIN_TESTS = Math.max(100, Math.round(expected * 0.3));

/**
 * Catches "this shard ran the whole suite", which is `total` x expected. At 1.8x it
 * separates that from real imbalance for every N >= 2, with ~1.7x headroom over the worst
 * shard actually observed.
 */
const MAX_TESTS = Math.round(expected * 1.8);

if (!existsSync(reportPath)) {
  console.error(
    `${reportPath} does not exist — the run produced no JSON report.\n` +
      'That is NOT a passing shard: it means vitest did not get far enough to write one,\n' +
      'or `--outputFile` never reached it (check for a stray `--` in the pnpm invocation).'
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
// `failed` counts as executed on purpose: a shard that ran and went RED still did the work
// this script is asserting happened. The suite step above owns the pass/fail verdict, and a
// guard that treated a red shard as "did not run" would fire on every genuine test failure.
const EXECUTED = new Set(['passed', 'failed']);
let executed = 0;
let skipped = 0;
for (const result of report.testResults ?? []) {
  for (const assertion of result.assertionResults ?? []) {
    if (EXECUTED.has(assertion.status)) executed += 1;
    else skipped += 1;
  }
}
const numFiles = Array.isArray(report.testResults) ? report.testResults.length : 0;

console.log(
  `shard ${shard}/${total}: ${executed} executed, ${skipped} skipped, across ${numFiles} files ` +
    `(expected ~${Math.round(expected)}, band ${MIN_TESTS}..${MAX_TESTS}; ` +
    `report.numTotalTests=${report.numTotalTests ?? '?'})`
);

if (executed === 0) {
  console.error(
    `\nSHARD ${shard}/${total} EXECUTED ZERO TESTS (${skipped} skipped).\n` +
      'A `--shard` expression that matches no files exits 0 and reports green, so this is a\n' +
      'silent failure, not a pass. Check that the matrix and the `/N` denominator agree, that\n' +
      'the `unit*` projects still resolve, and that the suite is not self-skipping wholesale.'
  );
  process.exit(1);
}

if (executed < MIN_TESTS) {
  console.error(
    `\nSHARD ${shard}/${total} executed only ${executed} tests (floor ${MIN_TESTS}, ` +
      `expected ~${Math.round(expected)}).\n` +
      'Too few to be a real 1/' +
      total +
      ' of this suite. Either the split has become badly\n' +
      "unbalanced — read the other shards' durations — or files stopped being collected.\n" +
      'Do NOT lower the floor to make this green.'
  );
  process.exit(1);
}

if (executed > MAX_TESTS) {
  console.error(
    `\nSHARD ${shard}/${total} executed ${executed} tests (ceiling ${MAX_TESTS}, ` +
      `expected ~${Math.round(expected)}).\n` +
      '🔴 TWO CAUSES, and this script CANNOT tell them apart from inside one shard:\n' +
      `  1. \`--shard\` is not reaching vitest, so every shard is running the WHOLE suite —\n` +
      `     ${total}x the runner cost, all of it green. Check for a stray \`--\` in the pnpm\n` +
      '     invocation (pnpm forwards it literally and vitest discards what follows).\n' +
      `  2. The suite has simply grown past BASE_TESTS=${BASE_TESTS}, measured 2026-08-25.\n` +
      '     Re-derive it by summing the four shards\' "executed" counts from a green run and\n' +
      '     update the constant.\n' +
      'Check the other shards: if all of them tripped and each took ~the full-suite runtime,\n' +
      'it is (1). If the counts look like a proportionate share, it is (2).'
  );
  process.exit(1);
}
