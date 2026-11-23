import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  mergeShardReports,
  readShardReport,
  shardIndicesOnDisk,
  shardReportPath,
} from '../ci/merge-component-shard-reports.mjs';

/**
 * Failed-suite and failed-test totals differ (7 vs 14), so a merge that sums the wrong field
 * cannot match.
 */
function file(name: string, statuses: string[], status = 'passed') {
  return { name, status, assertionResults: statuses.map((s) => ({ status: s })) };
}

function report(files: ReturnType<typeof file>[], failedSuites: number, failedTests: number) {
  return {
    numFailedTestSuites: failedSuites,
    numFailedTests: failedTests,
    numTotalTests: files.reduce((n, f) => n + f.assertionResults.length, 0),
    testResults: files,
  };
}

const S1 = report([file('/r/src/a.browser.test.tsx', ['passed', 'passed', 'skipped'])], 1, 2);
const S2 = report(
  [file('/r/src/b.browser.test.tsx', ['passed', 'failed', 'passed', 'passed', 'passed'])],
  2,
  4
);
const S3 = report(
  [
    file('/r/src/c.browser.test.tsx', ['passed', 'passed', 'passed']),
    file('/r/src/d.browser.test.tsx', ['passed', 'passed', 'passed', 'passed']),
  ],
  4,
  8
);

describe('mergeShardReports', () => {
  it('merges every shard into one report and sums the failure counts', () => {
    const { ok, merged } = mergeShardReports(
      [
        { shard: 1, report: S1 },
        { shard: 2, report: S2 },
        { shard: 3, report: S3 },
      ],
      3
    );
    expect(ok).toBe(true);
    expect(merged.testResults.map((f: { name: string }) => f.name)).toEqual([
      '/r/src/a.browser.test.tsx',
      '/r/src/b.browser.test.tsx',
      '/r/src/c.browser.test.tsx',
      '/r/src/d.browser.test.tsx',
    ]);
    expect(merged.numFailedTestSuites).toBe(7);
    expect(merged.numFailedTests).toBe(14);
    expect(merged.numTotalTests).toBe(15);
  });

  it('fails, naming the shard, when one shard has no report', () => {
    const { ok, merged, lines } = mergeShardReports(
      [
        { shard: 1, report: S1 },
        { shard: 3, report: S3 },
      ],
      3
    );
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('shard 2/3: NO REPORT');
    // The shards that did report are still merged, so the full ledger can name missing files.
    expect(merged.testResults).toHaveLength(3);
  });

  it('fails when a shard report is present but unreadable', () => {
    const { ok, lines } = mergeShardReports(
      [
        { shard: 1, report: S1 },
        { shard: 2, report: null, problem: 'x is not valid JSON' },
        { shard: 3, report: S3 },
      ],
      3
    );
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('shard 2/3: NO REPORT (x is not valid JSON)');
  });

  // `--shard` not reaching vitest: every shard runs the whole suite, all present and green. Every
  // shard 1..total reports, so only the duplicate check can turn this red.
  it('fails, naming the file and both shards, when a test file is in two shard reports', () => {
    const S2_WITH_A = report(
      [...S2.testResults, file('/r/src/a.browser.test.tsx', ['passed'])],
      2,
      4
    );
    const { ok, lines } = mergeShardReports(
      [
        { shard: 1, report: S1 },
        { shard: 2, report: S2_WITH_A },
        { shard: 3, report: S3 },
      ],
      3
    );
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('1 test file(s) appear in MORE THAN ONE shard report');
    expect(lines.join('\n')).toContain('/r/src/a.browser.test.tsx (shards 1 and 2)');
  });

  it('sums the suite and skipped totals the apps ledger prints', () => {
    const withTotals = (r: ReturnType<typeof report>, suites: number, pending: number) => ({
      ...r,
      numTotalTestSuites: suites,
      numPendingTests: pending,
    });
    const { merged } = mergeShardReports(
      [
        { shard: 1, report: withTotals(S1, 3, 5) },
        { shard: 2, report: withTotals(S2, 11, 17) },
      ],
      2
    );
    expect(merged.numTotalTestSuites).toBe(14);
    expect(merged.numPendingTests).toBe(22);
  });

  // The matrix and the `/N` denominator drifted apart: shards 1..total all report, so only the
  // range check can turn this red. Shard 4's files stay out of the merge.
  it('fails on a report for a shard index outside 1..total, and leaves its files out', () => {
    const { ok, merged, lines } = mergeShardReports(
      [
        { shard: 1, report: S1 },
        { shard: 2, report: S2 },
        { shard: 4, report: S3 },
      ],
      2
    );
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('shard 4: a report OUTSIDE 1..2');
    expect(merged.testResults.map((f: { name: string }) => f.name)).toEqual([
      '/r/src/a.browser.test.tsx',
      '/r/src/b.browser.test.tsx',
    ]);
    expect(merged.numTotalTests).toBe(8);
  });
});

describe('readShardReport', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads the download-artifact layout, and reports missing or invalid files as problems', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-component-shards-'));
    const p1 = shardReportPath(dir, 1);
    mkdirSync(dirname(p1), { recursive: true });
    writeFileSync(p1, JSON.stringify(S1));
    const p3 = shardReportPath(dir, 3);
    mkdirSync(dirname(p3), { recursive: true });
    writeFileSync(p3, '{not json');

    expect(p1).toBe(join(dir, 'component-report-1', 'component-report.json'));
    expect(readShardReport(dir, 1).report).toEqual(S1);
    expect(readShardReport(dir, 2)).toMatchObject({ report: null });
    expect(readShardReport(dir, 2).problem).toContain('does not exist');
    expect(readShardReport(dir, 3).problem).toContain('not valid JSON');
  });

  it('lists every shard index on disk for a name, including ones outside the expected range', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-component-shards-'));
    for (const d of ['app-unit-report-0', 'app-unit-report-2', 'app-unit-report-7']) {
      mkdirSync(join(dir, d));
    }
    // Neither of these is a shard of `app-unit-report`.
    mkdirSync(join(dir, 'app-unit-report-x'));
    mkdirSync(join(dir, 'component-report-3'));

    expect(shardIndicesOnDisk(dir, 'app-unit-report')).toEqual([0, 2, 7]);
    expect(shardIndicesOnDisk(dir)).toEqual([3]);
    expect(shardIndicesOnDisk(join(dir, 'absent'))).toEqual([]);
  });

  it('reads another report name from the same layout', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-component-shards-'));
    const p2 = shardReportPath(dir, 2, 'app-unit-report');
    mkdirSync(dirname(p2), { recursive: true });
    writeFileSync(p2, JSON.stringify(S2));

    expect(p2).toBe(join(dir, 'app-unit-report-2', 'app-unit-report.json'));
    expect(readShardReport(dir, 2, 'app-unit-report').report).toEqual(S2);
    // The default name does not see it.
    expect(readShardReport(dir, 2).problem).toContain('does not exist');
  });
});

describe('the CLI', () => {
  const script = fileURLToPath(new URL('../ci/merge-component-shard-reports.mjs', import.meta.url));
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeShard(root: string, i: number, r: unknown) {
    const p = shardReportPath(root, i);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(r));
  }

  it('exits 1 on a missing shard but still writes the merged report for the full ledger', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-component-cli-'));
    writeShard(dir, 1, S1);
    writeShard(dir, 3, S3);
    const out = join(dir, 'merged.json');

    const run = spawnSync(process.execPath, [script, dir, '3', out], { encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('shard 2/3: NO REPORT');
    expect(existsSync(out)).toBe(true);
    expect(
      JSON.parse(readFileSync(out, 'utf8')).testResults.map((f: { name: string }) => f.name)
    ).toEqual([
      '/r/src/a.browser.test.tsx',
      '/r/src/c.browser.test.tsx',
      '/r/src/d.browser.test.tsx',
    ]);
  });

  it('exits 0 when every shard reported, and 2 on bad usage', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-component-cli-'));
    writeShard(dir, 1, S1);
    writeShard(dir, 2, S2);
    const out = join(dir, 'merged.json');

    expect(spawnSync(process.execPath, [script, dir, '2', out]).status).toBe(0);
    expect(spawnSync(process.execPath, [script, dir, 'x', out]).status).toBe(2);
    expect(spawnSync(process.execPath, [script, dir, '2', out, 'a', 'b']).status).toBe(2);
  });

  it('merges reports under the name given as the fourth argument', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-component-cli-'));
    for (const [i, r] of [S1, S2].entries()) {
      const p = shardReportPath(dir, i + 1, 'app-unit-report');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(r));
    }
    const out = join(dir, 'merged.json');

    const run = spawnSync(process.execPath, [script, dir, '2', out, 'app-unit-report'], {
      encoding: 'utf8',
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).numTotalTests).toBe(8);
    // Without the name it looks for component-report-<i> and finds nothing.
    expect(spawnSync(process.execPath, [script, dir, '2', out]).status).toBe(1);
  });

  // The CLI must find a report it was not told to expect: reading only 1..total is how a
  // too-small denominator used to drop a shard silently.
  it('exits 1 on a report directory beyond the shard total', () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-component-cli-'));
    writeShard(dir, 1, S1);
    writeShard(dir, 2, S2);
    writeShard(dir, 3, S3);
    const out = join(dir, 'merged.json');

    const run = spawnSync(process.execPath, [script, dir, '2', out], { encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('shard 3: a report OUTSIDE 1..2');
  });
});
