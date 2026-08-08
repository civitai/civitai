#!/usr/bin/env node
/**
 * Positive control for the `Package unit tests` and `App unit tests` CI jobs.
 *
 * A green vitest run is not evidence that anything ran. Ways either job could report success
 * having tested nothing, EXIT CODE 0 AND ALL:
 *
 *   - one workspace member quietly drops out — its `include` stops matching, or (for an app)
 *     its `test.name` is dropped so the `--project` pattern no longer selects it — while the
 *     others keep the totals looking healthy. Both measured: vitest exited 0 either way;
 *   - a member's suite self-skips in its entirety on a missing env var;
 *   - the `<workspace>/<name>/vitest.config.*` globs in the root config stop resolving, so
 *     the projects are simply absent.
 *
 * A `--project` filter matching NOTHING at all is the one case this no longer has to catch:
 * vitest 4.0.18 fails startup with `No projects matched the filter` and exits 1. Do not
 * assume that across upgrades — it is version-dependent behaviour, and if it ever softens
 * back to a silent empty run, the ledger below is what notices.
 *
 * So this reads the run's JSON report and asserts a LEDGER rather than a floor: every
 * directory under the given workspace root that has a vitest config AND at least one test
 * file on disk must appear in the results with at least one test. The check fails when that
 * set SHRINKS, which is the regression, and adapts on its own when a new one is added.
 *
 * Usage:  node scripts/ci/assert-workspace-suites-ran.mjs <vitest-json-report> <packages|apps>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/**
 * A floor as well as the ledger: the ledger passes if every workspace contributes one test,
 * which is not the same as the suites being intact. Measured on the run that introduced each
 * entry — 957 for packages, 369 for apps — and set below it, so ordinary churn does not trip
 * it but a suite collapsing does.
 */
const WORKSPACES = {
  packages: { minTests: 500 },
  apps: { minTests: 250 },
};

const [reportPath, workspace] = process.argv.slice(2);
if (!reportPath || !WORKSPACES[workspace]) {
  const choices = Object.keys(WORKSPACES).join('|');
  console.error(`usage: assert-workspace-suites-ran.mjs <vitest-json-report> <${choices}>`);
  process.exit(2);
}

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspaceDir = join(repoRoot, workspace);

/**
 * Any test file anywhere under a workspace member, recursively.
 *
 * Both halves of this are deliberately WIDE, because this function decides what the ledger
 * EXPECTS — and anything it fails to see is a member the ledger can never notice going
 * missing. A narrow rule here does not produce a loud error; it silently shrinks the thing
 * the check is checking.
 *
 * So: the whole directory, not just `src/` (a package that keeps its tests in a top-level
 * `__tests__/` was invisible), and every extension Vitest will collect, not just
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

const expected = readdirSync(workspaceDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    const dir = join(workspaceDir, name);
    const hasConfig = ['vitest.config.ts', 'vitest.config.mts'].some((f) =>
      existsSync(join(dir, f))
    );
    return hasConfig && hasTestFile(dir);
  })
  .sort();

if (expected.length === 0) {
  console.error(
    `FAIL: found no directory under ${workspace}/ with both a vitest config and a test file. ` +
      'This check cannot have measured anything — it is running from the wrong directory, or ' +
      `the ${workspace}/ layout changed.`
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

const memberOfWorkspace = new RegExp(`(?:^|/)${workspace}/([^/]+)/`);
const ran = new Map(); // member name -> { files, executed, skipped }
for (const result of report.testResults ?? []) {
  const match = memberOfWorkspace.exec(result.name ?? '');
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

console.log(`${workspace}/ dirs with a vitest config and tests on disk : ${expected.length}`);
console.log(`${workspace}/ dirs that appear in the run                 : ${ran.size}`);
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
    `\nFAIL: ${missing.length} ${workspace}/ suite(s) executed no tests: ${missing.join(', ')}.\n` +
      'The job reported success without running them. Either the project was not selected — ' +
      `check the \`${workspace}/*/vitest.config.*\` globs in the root vitest.config.mts and ` +
      'the --project filter; an app that lost its `test.name` falls back to its `@civitai/*` ' +
      'package name and lands in the packages job instead — or the suite skipped itself in ' +
      'its entirety, and a wholly-skipped suite is not a suite that ran.'
  );
  process.exit(1);
}

const { minTests } = WORKSPACES[workspace];
const totalExecuted = [...ran.values()].reduce((sum, e) => sum + e.executed, 0);
if (totalExecuted < minTests) {
  console.error(
    `\nFAIL: ${totalExecuted} tests executed, expected at least ${minTests}. Every ${workspace}/ ` +
      'suite is present, so this is a suite that collapsed rather than a project that vanished.'
  );
  process.exit(1);
}

console.log(`\nOK: every ${workspace}/ suite with tests on disk executed.`);
