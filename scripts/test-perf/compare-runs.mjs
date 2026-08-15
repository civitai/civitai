#!/usr/bin/env node
/**
 * Diff two `.test-perf/runs/<label>.perf.json` files PER FILE.
 *
 *   node scripts/test-perf/compare-runs.mjs pilot-before-iso-4 pilot-after-noiso-4
 *
 * 🔴 A summary line is not evidence on this suite. Under `--no-isolate` a file whose
 * module scope throws collects ZERO tests: the failure count does not rise, the run can
 * read as green, and the tests simply are not there. So the success criterion is a COUNT
 * matched against a control, not a colour — this prints collected-count regressions
 * first, before failures.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [controlLabel, candidateLabel] = process.argv.slice(2);
if (!controlLabel || !candidateLabel) {
  console.error('usage: compare-runs.mjs <control-label> <candidate-label>');
  process.exit(2);
}

const load = (label) =>
  JSON.parse(readFileSync(path.join(repoRoot, `.test-perf/runs/${label}.perf.json`), 'utf8'));

const control = load(controlLabel);
const candidate = load(candidateLabel);
const byFile = (run) => Object.fromEntries(run.files.map((f) => [f.file, f]));
const a = byFile(control);
const b = byFile(candidate);

const collected = (f) => (f ? f.passed + f.failed + f.skipped : 0);

const missing = [];
const lostTests = [];
const newFailures = [];
const fixed = [];

for (const file of Object.keys(a)) {
  const before = a[file];
  const after = b[file];
  if (!after) {
    missing.push(file);
    continue;
  }
  if (collected(after) < collected(before))
    lostTests.push({ file, before: collected(before), after: collected(after) });
  if (after.failed > before.failed) newFailures.push({ file, before: before.failed, after: after.failed });
  if (before.failed > 0 && after.failed === 0) fixed.push({ file, was: before.failed });
}
const added = Object.keys(b).filter((f) => !a[f]);

const totals = (run) => ({
  files: run.files.length,
  tests: run.files.reduce((n, f) => n + collected(f), 0),
  failed: run.totals.failed,
  zeroTestFiles: run.files.filter((f) => collected(f) === 0).length,
});
const ta = totals(control);
const tb = totals(candidate);

console.log(`control   ${controlLabel.padEnd(28)} files ${ta.files}  tests ${ta.tests}  failed ${ta.failed}  zero-test files ${ta.zeroTestFiles}`);
console.log(`candidate ${candidateLabel.padEnd(28)} files ${tb.files}  tests ${tb.tests}  failed ${tb.failed}  zero-test files ${tb.zeroTestFiles}`);
console.log(`wall ${(control.wallMs / 1000).toFixed(1)}s -> ${(candidate.wallMs / 1000).toFixed(1)}s`);

report('FILES ABSENT FROM CANDIDATE', missing.map((f) => `  ${f}`));
report(
  'FILES THAT COLLECTED FEWER TESTS',
  lostTests.map((x) => `  ${x.before} -> ${x.after}  ${x.file}`)
);
report(
  'FILES WITH MORE FAILURES',
  newFailures.map((x) => `  ${x.before} -> ${x.after}  ${x.file}`)
);
report('FILES FIXED', fixed.map((x) => `  was ${x.was}  ${x.file}`));
if (added.length) report('FILES ONLY IN CANDIDATE', added.map((f) => `  ${f}`));

const clean = !missing.length && !lostTests.length && !newFailures.length && tb.tests >= ta.tests;
console.log(`\n${clean ? 'CLEAN' : 'REGRESSION'}: ${tb.tests}/${ta.tests} tests collected, ${tb.failed} failed`);
process.exit(clean ? 0 : 1);

function report(title, lines) {
  if (!lines.length) return;
  console.log(`\n${title} (${lines.length})`);
  for (const l of lines) console.log(l);
}
