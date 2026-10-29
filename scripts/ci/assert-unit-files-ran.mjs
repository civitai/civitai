#!/usr/bin/env node
/**
 * Positive control for a NARROWED `Unit tests` job: the files vitest executed must be EXACTLY the
 * files scripts/ci/unit-targets.mjs selected for this job.
 *
 *   node scripts/ci/assert-unit-files-ran.mjs <vitest-json-report> <expected-files.txt>
 *
 * The narrowed job hands vitest its files as positional arguments, which vitest treats as
 * substring FILTERS, not paths. A filter that matches nothing is dropped without complaint and one
 * that matches a second file silently adds it, and both exit 0. So the executed set is compared
 * with the selected set file by file, in both directions.
 *
 * assert-shard-ran.mjs is the FULL run's equivalent; it checks counts against the whole suite's
 * size, which says nothing about a narrowed job.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

const [reportPath, listPath] = process.argv.slice(2);
if (!reportPath || !listPath) {
  console.error('usage: assert-unit-files-ran.mjs <vitest-json-report> <expected-files.txt>');
  process.exit(2);
}

const expected = readFileSync(listPath, 'utf8').split('\n').filter(Boolean);
if (expected.length === 0) {
  console.error(`${listPath} is empty: a narrowed job must be given at least one file.`);
  process.exit(1);
}

if (!existsSync(reportPath)) {
  console.error(
    `${reportPath} does not exist — vitest wrote no JSON report, so nothing proves this job ran.`
  );
  process.exit(1);
}
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  console.error(`${reportPath} is not valid JSON (${err.message}).`);
  process.exit(1);
}

const ran = new Set((report.testResults ?? []).map((r) => relative(process.cwd(), r.name)));
const want = new Set(expected);
const missing = expected.filter((f) => !ran.has(f));
const extra = [...ran].filter((f) => !want.has(f));

// Executed means passed or failed: a red file still ran. Skipped does not, for the reason
// assert-shard-ran.mjs gives.
let executed = 0;
for (const r of report.testResults ?? []) {
  for (const a of r.assertionResults ?? [])
    if (a.status === 'passed' || a.status === 'failed') executed++;
}

console.log(
  `narrowed job: ${ran.size} files ran of ${want.size} selected; ${executed} tests executed`
);
let ok = true;
if (missing.length) {
  ok = false;
  console.error(`\n${missing.length} SELECTED file(s) did not run:`);
  for (const f of missing) console.error(`  ${f}`);
}
if (extra.length) {
  ok = false;
  console.error(`\n${extra.length} file(s) ran that were NOT selected:`);
  for (const f of extra) console.error(`  ${f}`);
}
if (!ok) {
  console.error(
    '\nThe executed set must equal the selected set. Vitest reads each path as a substring filter,' +
      '\nso a path that no longer matches drops out and one that also matches another file adds it.'
  );
  process.exit(1);
}
if (executed === 0) {
  console.error(
    `\nEXECUTED ZERO TESTS across ${ran.size} files: every selected file skipped itself. ` +
      'That is not a pass.'
  );
  process.exit(1);
}
