#!/usr/bin/env node
/**
 * Merge the per-shard JSON reports of the SHARDED browser `component` suite into one report,
 * so the full ledger in `scripts/ci/assert-component-suite-ran.mjs` (zero check, on-disk file
 * ledger, test floor) can grade the WHOLE suite exactly as it graded the unsharded run.
 *
 * 🔴 WHY THE LEDGER RUNS ON THE MERGE AND NOT PER SHARD. Inside one shard the run is narrowed
 * (`--shard=i/N`), so the file ledger and the floor have to be switched off there — which
 * shard a file lands on is vitest's hash, not anything a shard can check against the disk.
 * Only the union of all shards can be compared with the `*.browser.test.tsx` files on disk.
 * Each shard still runs the zero check (`--narrowed`) on its own report.
 *
 * A missing or unreadable shard report fails the merge and names the shard (aborted shard,
 * failed upload, or matrix and `/N` drifted apart); the on-disk ledger alone could not say which.
 *
 * Usage:  node scripts/ci/merge-component-shard-reports.mjs <reports-dir> <shard-total> <out>
 *
 * `<reports-dir>` is what `actions/download-artifact` writes for a pattern download without
 * `merge-multiple`: one sub-directory per artifact, `component-report-<i>/component-report.json`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tally } from './assert-component-suite-ran.mjs';

/** Where shard `i`'s report lands under `<reports-dir>`. One place, so the workflow and this agree. */
export function shardReportPath(dir, i) {
  return join(dir, `component-report-${i}`, 'component-report.json');
}

/**
 * Merge parsed shard reports. `reports` is `[{ shard, report }]`, `report` null when the shard
 * produced none or it was unreadable (`problem` then says which).
 *
 * Returns `{ ok, merged, lines }`. `merged` is built even when `ok` is false, so the caller can
 * still hand it to the full ledger and get its file-level diagnosis too.
 */
export function mergeShardReports(reports, total) {
  const lines = [];
  let ok = true;
  const testResults = [];
  const sums = { numFailedTestSuites: 0, numFailedTests: 0, numTotalTests: 0 };

  const byShard = new Map(reports.map((r) => [r.shard, r]));
  for (let i = 1; i <= total; i++) {
    const entry = byShard.get(i);
    if (!entry || !entry.report) {
      ok = false;
      lines.push(
        `🔴 shard ${i}/${total}: NO REPORT (${entry?.problem ?? 'not downloaded'}). That shard ` +
          'did not finish, its upload failed, or it never ran — its files are unaccounted for, ' +
          'which is not a pass.'
      );
      continue;
    }
    const { report } = entry;
    const counts = tally(report);
    lines.push(
      `shard ${i}/${total}: ${counts.executed} executed, ${counts.skipped} skipped, across ` +
        `${counts.files} files`
    );
    testResults.push(...(report.testResults ?? []));
    for (const k of Object.keys(sums)) sums[k] += Number(report[k] ?? 0);
  }

  return { ok, merged: { ...sums, testResults }, lines };
}

/** Read shard `i`'s report from disk as `{ shard, report, problem }`. */
export function readShardReport(dir, i) {
  const p = shardReportPath(dir, i);
  if (!existsSync(p)) return { shard: i, report: null, problem: `${p} does not exist` };
  try {
    return { shard: i, report: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (err) {
    return { shard: i, report: null, problem: `${p} is not valid JSON (${err.message})` };
  }
}

function main(argv) {
  const [dir, totalRaw, out] = argv.slice(2);
  const total = Number(totalRaw);
  if (!dir || !out || !Number.isInteger(total) || total < 1) {
    console.error(
      'usage: merge-component-shard-reports.mjs <reports-dir> <shard-total> <out-report>'
    );
    return 2;
  }
  const reports = [];
  for (let i = 1; i <= total; i++) reports.push(readShardReport(dir, i));
  const { ok, merged, lines } = mergeShardReports(reports, total);
  writeFileSync(out, JSON.stringify(merged));
  for (const line of lines) (ok ? console.log : console.error)(line);
  return ok ? 0 : 1;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv));
}
