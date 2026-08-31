#!/usr/bin/env node
/**
 * Positive control for the `preview / component-tests` tier.
 *
 * 🔴 WHY: THE BROWSER SUITE HAS A FAILURE MODE THAT COLLECTS ZERO TESTS AND IS
 * INDISTINGUISHABLE, TO EVERY CONSUMER, FROM A SUITE THAT RAN.
 *
 * A `vi.mock` factory that throws in browser mode is resolved over the browser<->node
 * channel inside a Playwright route handler that does not catch
 * (`@vitest/browser-playwright/dist/index.js`, `await module.resolve()` inside `page.route`).
 * The rejection escapes as an `Unhandled Rejection` in the ORCHESTRATOR and kills the run
 * before any reporter prints: no `Test Files` line, no `Tests` line, no per-file results,
 * exit 1. Measured on `main` at d353f785c3 — one file
 * (`src/tests/pages/apps/review/review-queue-nav.browser.test.tsx`) zeroed all 201 files.
 *
 * The tier that runs this — the shared `npm-report-only-suite` Tekton task in the
 * datapacket-talos repo — computes its verdict from the runner's EXIT CODE alone. So an
 * abort that executed nothing and a genuine list of failing assertions both render as
 * `component:fail` / "Component suite failed": the same words, the same colour, in the same
 * place. A tier that cannot say "this run tested nothing" is a tier people learn to click
 * through, which is strictly worse than no tier at all.
 *
 * So this asserts a LEDGER over the run's JSON report. It never converts red to green — the
 * caller keeps vitest's exit code whenever the ledger is satisfied. It only ever ADDS a
 * failure, and it says which KIND.
 *
 * Usage:  node scripts/ci/assert-component-suite-ran.mjs <vitest-json-report> [--narrowed]
 *
 * `--narrowed` skips the floor (not the zero check) because the caller passed a file or
 * `-t` filter, which makes the collected count a property of the filter rather than of the
 * suite. The floor guards the CI invocation, which passes no filters.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The floor, and the reason it is a floor rather than an exact count.
 *
 * Measured 2026-08-31 on a full green run of this project:
 * `Test Files 201 passed (201) / Tests 2254 passed (2254)`, against 201 `*.browser.test.tsx`
 * files on disk. Set at ~55% of that so ordinary churn — a file deleted, a describe block
 * folded away, a legitimately smaller run on a branch — does not trip it, while the failure
 * this exists for (zero, or a handful of files surviving a collection-time abort) does.
 *
 * 🔴 Do NOT lower this to make a run green. If the suite has genuinely shrunk by half,
 * re-derive the number from a run you have READ, and say so in the commit.
 */
export const MIN_TESTS = 1240;
export const BASELINE = { files: 201, tests: 2254, measuredOn: '2026-08-31' };

/**
 * 🔴 THIS MESSAGE NAMES EVERY CAUSE IT CANNOT TELL APART, AND MUST KEEP DOING SO.
 *
 * "Collected nothing" is an ABSENCE, and an absence is the observable that the most causes
 * share — so it identifies none of them. A message that asserts one cause sends the next
 * reader hunting a bug that is not there, which is worse than saying "here are the three,
 * read the error above". All three below have been observed on this suite.
 */
export const ABORT_DIAGNOSIS = `
🔴 THE COMPONENT SUITE COLLECTED NOTHING. THIS IS NOT A TEST FAILURE AND IT IS NOT A PASS —
   nothing executed, so this tier verified NOTHING on this commit. Read the error printed
   ABOVE this line; it is the only thing that separates the causes below.

   1. A \`vi.mock\` FACTORY THREW.  Vitest resolves manual mocks over the browser<->node
      channel inside a Playwright route handler that does not catch, so the rejection escapes
      as an "Unhandled Rejection" in the ORCHESTRATOR and kills the whole run — no summary,
      no per-file results. The printed error is generic ("[vitest] There was an error when
      mocking a module ... make sure there are no top level variables inside"): the real cause
      is wrapped twice and its innermost \`cause\` is dropped in transit, so it names neither
      the file nor the error, and its advice about hoisting is usually WRONG.
      Two defects produce it:
        - a WHOLESALE factory that no longer names an export something in the file's module
          graph imports ("does not provide an export named X") — add the export to the factory
          (an \`importOriginal\` spread is the usual cure but is not always available: see
          src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts);
        - a factory reading a module-scope binding still in its temporal dead zone — \`vi.mock\`
          is hoisted above the imports and the factory fires during import evaluation, BEFORE
          the file's own \`const\`s initialise. Move the binding into \`vi.hoisted(() => ...)\`.
      To attribute it to a FILE, bisect by file set — the run names no file on its own:
          pnpm exec vitest run --project component <a subset of the files>

   2. THE BROWSER DIED, OR NEVER CAME UP.  Two signatures, both host CONTENTION rather than a
      defect in the code under test — check the load average and free memory, and re-run
      serially (--max-workers=1) before believing anything else this run says:
        - "Failed to connect to the browser session ... within the timeout" — it never started;
        - "Browser connection was closed while running tests. Was the page closed
          unexpectedly?" — it started, ran, and was killed part-way. 🔴 THIS ONE ARRIVES
          WEARING THE MOCKING ERROR ABOVE: it is wrapped by the same \`createHelpfulError\`, so
          the headline blames a \`vi.mock\` factory and the real cause is on the "Caused by:"
          line. Read that line before chasing a mock. Note that ONE crash zeroes the WHOLE
          run, however many files had already gone green above it.
      On NixOS the first signature is also what a playwright/Chromium REVISION MISMATCH looks
      like — it collects files and executes none. See CLAUDE.md, "Browser/component tests on
      NixOS".

   3. THE PROJECT SELECTED NOTHING.  A \`--project\`/glob that matches no file exits without
      running, and an empty selection is not a pass.
`;

/**
 * Count what a vitest JSON report says actually happened.
 *
 * 🔴 EXECUTED, NOT TOTAL. `numTotalTests` counts SKIPPED tests, so a suite that skipped
 * itself wholesale would satisfy a total-based floor having run nothing. `failed` counts as
 * executed on purpose: a red test did the work this script asserts happened, and the caller's
 * exit code already owns the pass/fail verdict — a guard that treated a red run as "did not
 * run" would fire on every genuine test failure.
 */
export function tally(report) {
  const EXECUTED = new Set(['passed', 'failed']);
  let executed = 0;
  let skipped = 0;
  for (const file of report?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      if (EXECUTED.has(assertion.status)) executed += 1;
      else skipped += 1;
    }
  }
  return {
    executed,
    skipped,
    files: Array.isArray(report?.testResults) ? report.testResults.length : 0,
    failedSuites: report?.numFailedTestSuites ?? 0,
    failedTests: report?.numFailedTests ?? 0,
    // A file that fails to IMPORT is a failed SUITE with zero assertions. That pair is the
    // per-file version of the whole-run abort: nothing in the file is collected, so a failure
    // count and a per-test list both read as clean. Named, not merely counted — the count is
    // the thing people read past.
    suitesWithNoAssertions: (report?.testResults ?? [])
      .filter((f) => f?.status === 'failed' && (f?.assertionResults ?? []).length === 0)
      .map((f) => f?.name)
      .filter(Boolean),
  };
}

/** The verdict, as data. `{ ok, code, lines[] }`; `code` is what the caller should exit with. */
export function verdict(counts, { narrowed = false } = {}) {
  const lines = [
    `test:component ledger: ${counts.executed} executed, ${counts.skipped} skipped, ` +
      `across ${counts.files} files; ${counts.failedSuites} failed suites, ` +
      `${counts.failedTests} failed tests (baseline ${BASELINE.tests} tests / ` +
      `${BASELINE.files} files measured ${BASELINE.measuredOn}` +
      (narrowed ? '; floor SKIPPED — narrowed by a filter' : `; floor ${MIN_TESTS}`) +
      ')',
  ];

  if (counts.suitesWithNoAssertions.length > 0) {
    lines.push(
      `\n⚠️  ${counts.suitesWithNoAssertions.length} FILE(S) FAILED WITHOUT RUNNING A SINGLE ` +
        'ASSERTION — these did not fail a test, they failed to IMPORT, so every test in them\n' +
        '   was silently NOT RUN. A failure count and a per-test list both read as clean here.\n' +
        counts.suitesWithNoAssertions.map((n) => `     ${n}`).join('\n') +
        '\n   The usual cause is a wholesale `vi.mock` factory that no longer names an export\n' +
        "   something in the file's module graph imports — read that file's error above."
    );
  }

  if (counts.executed === 0) {
    return { ok: false, code: 1, lines: [...lines, ABORT_DIAGNOSIS] };
  }

  if (!narrowed && counts.executed < MIN_TESTS) {
    return {
      ok: false,
      code: 1,
      lines: [
        ...lines,
        `\n🔴 THE COMPONENT SUITE EXECUTED ONLY ${counts.executed} TESTS (floor ${MIN_TESTS}, ` +
          `baseline ${BASELINE.tests}).\n` +
          '   Too few to be this suite. Either a large number of files stopped being COLLECTED —\n' +
          '   which reports as ABSENCE, not as failure — or the suite genuinely shrank. Compare\n' +
          '   the file count above against what is on disk:\n' +
          '       find src -name "*.browser.test.tsx" | wc -l\n' +
          '   Do NOT lower the floor to make this green.',
      ],
    };
  }

  return { ok: true, code: 0, lines };
}

function main(argv) {
  const args = argv.slice(2);
  const narrowed = args.includes('--narrowed');
  const reportPath = args.find((a) => !a.startsWith('--'));
  if (!reportPath) {
    console.error('usage: assert-component-suite-ran.mjs <vitest-json-report> [--narrowed]');
    return 2;
  }

  // 🔴 A MISSING OR UNREADABLE REPORT IS A FINDING, NOT A PASS. It is exactly what the abort
  // this guard exists for produces when it dies early enough, and treating it as "nothing to
  // check" would make the guard silent in the one case it was written for.
  if (!existsSync(reportPath)) {
    console.error(
      `\n${reportPath} does not exist — the run wrote no JSON report.\n` +
        'That is not evidence anything ran; it means vitest did not get far enough to write\n' +
        'one, or --outputFile never reached it.' +
        ABORT_DIAGNOSIS
    );
    return 1;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.error(
      `\n${reportPath} is not valid JSON (${err.message}) — cannot verify this run collected ` +
        'anything, so it does not count as one that did.' +
        ABORT_DIAGNOSIS
    );
    return 1;
  }

  const result = verdict(tally(report), { narrowed });
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  return result.code;
}

// Same main-guard shape as scripts/test-unit-run.mjs, so importing this from a test does not
// execute it.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv));
}
