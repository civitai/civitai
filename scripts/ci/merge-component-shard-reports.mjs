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
 * 🔴 THE SPLIT ITSELF IS CHECKED, not only its presence. Two failures leave every shard green and
 * every report present, and each is a fact about the union that no single shard can see:
 *   - a test file in MORE THAN ONE shard report. That is `--shard` not reaching vitest (a stray
 *     `--`, see lint.yml's `unit` job), so every shard ran the WHOLE suite — N times the cost,
 *     all green, and the union ledger satisfied N times over;
 *   - a report for a shard index outside 1..total. That is the matrix and the `/N` denominator
 *     drifted apart (a matrix of [1, 2, 3, 4] read with total 3, so shard 4's files would be
 *     dropped from the union unnoticed). Found by listing `<reports-dir>`, not by reading only
 *     the indices the caller expects, which is how such a report used to be ignored.
 * Callers should also pass the denominator from `strategy.job-total` (apps.yml does) rather than
 * a literal, so the two cannot drift in the first place; these checks catch it if they do.
 *
 * There is no per-shard zero-tests check here. One was tried and is not reachable from a real
 * run: a shard that selects no files is the denominator drift above (now caught by index), and a
 * shard whose files all skip themselves is not something a ~1/N slice of mixed suites produces.
 * The component shards keep their own per-shard zero check (`--narrowed`).
 *
 * Also merges the sharded `App unit tests` reports (apps.yml), whose ledger
 * (`assert-workspace-suites-ran.mjs`) likewise needs every shard's files. Same layout under a
 * different name, hence `[report-name]`.
 *
 * Usage:  node scripts/ci/merge-component-shard-reports.mjs <reports-dir> <shard-total> <out>
 *           [report-name]
 *
 * `<reports-dir>` is what `actions/download-artifact` writes for a pattern download without
 * `merge-multiple`: one sub-directory per artifact, `<name>-<i>/<name>.json`, `<name>` being
 * `[report-name]` (default `component-report`).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tally } from './assert-component-suite-ran.mjs';

export const DEFAULT_REPORT_NAME = 'component-report';

/** Where shard `i`'s report lands under `<reports-dir>`. One place, so the workflow and this agree. */
export function shardReportPath(dir, i, name = DEFAULT_REPORT_NAME) {
  return join(dir, `${name}-${i}`, `${name}.json`);
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
  const sums = {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numTotalTests: 0,
    numTotalTestSuites: 0,
    numPendingTests: 0,
  };

  for (const r of reports) {
    if (!Number.isInteger(r.shard) || r.shard < 1 || r.shard > total) {
      ok = false;
      lines.push(
        `🔴 shard ${r.shard}: a report OUTSIDE 1..${total}. The matrix and the \`/N\` ` +
          "denominator disagree, so this shard's files are not in the merge and the run did " +
          'not split the way the ledger assumes. Derive the denominator from `strategy.job-total`.'
      );
    }
  }

  const shardOfFile = new Map(); // test file -> first shard that reported it
  const duplicated = [];
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
    for (const result of report.testResults ?? []) {
      const file = result?.name ?? '';
      const first = shardOfFile.get(file);
      if (first !== undefined && first !== i) duplicated.push({ file, shards: [first, i] });
      else if (first === undefined) shardOfFile.set(file, i);
    }
    testResults.push(...(report.testResults ?? []));
    for (const k of Object.keys(sums)) sums[k] += Number(report[k] ?? 0);
  }

  if (duplicated.length > 0) {
    ok = false;
    lines.push(
      `🔴 ${duplicated.length} test file(s) appear in MORE THAN ONE shard report, so the shards ` +
        'did not split the suite: `--shard` is probably not reaching vitest (check for a stray ' +
        '`--` before it) and every shard ran the whole suite. First few:'
    );
    for (const { file, shards } of duplicated.slice(0, 5)) {
      lines.push(`    ${file} (shards ${shards.join(' and ')})`);
    }
  }

  return { ok, merged: { ...sums, testResults }, lines };
}

/**
 * Every shard index a report directory holds for `name`, read from the directory itself, so an
 * index the caller does not expect is seen rather than skipped. `<name>-0` and anything above the
 * total are what the out-of-range check exists for.
 */
export function shardIndicesOnDisk(dir, name = DEFAULT_REPORT_NAME) {
  if (!existsSync(dir)) return [];
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => pattern.exec(e.name)?.[1])
    .filter((m) => m !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Read shard `i`'s report from disk as `{ shard, report, problem }`. */
export function readShardReport(dir, i, name = DEFAULT_REPORT_NAME) {
  const p = shardReportPath(dir, i, name);
  if (!existsSync(p)) return { shard: i, report: null, problem: `${p} does not exist` };
  try {
    return { shard: i, report: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (err) {
    return { shard: i, report: null, problem: `${p} is not valid JSON (${err.message})` };
  }
}

function main(argv) {
  const [dir, totalRaw, out, name = DEFAULT_REPORT_NAME, ...extra] = argv.slice(2);
  const total = Number(totalRaw);
  if (!dir || !out || !name || extra.length > 0 || !Number.isInteger(total) || total < 1) {
    console.error(
      'usage: merge-component-shard-reports.mjs <reports-dir> <shard-total> <out-report> [report-name]'
    );
    return 2;
  }
  const indices = new Set(shardIndicesOnDisk(dir, name));
  for (let i = 1; i <= total; i++) indices.add(i);
  const reports = [...indices].sort((a, b) => a - b).map((i) => readShardReport(dir, i, name));
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
