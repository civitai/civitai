import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  mergeShardReports,
  readShardReport,
  shardReportPath,
} from '../ci/merge-component-shard-reports.mjs';

/**
 * Tests for the merge step of the sharded browser `component` suite. Each case kills one
 * mutation of the merge: a missing shard treated as nothing-to-merge, a shard's results dropped
 * from the merged report, or the failure counts not summed.
 *
 * Fixture counts are pairwise distinct (3, 5 and 7 assertions; failure counts 1, 2 and 4), so a
 * merge that keeps only one shard, or sums the wrong field, cannot land on the expected value.
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
  1
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
    expect(merged.numFailedTests).toBe(7);
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

  it('ignores a report for a shard index outside 1..total', () => {
    const { ok, lines } = mergeShardReports(
      [
        { shard: 1, report: S1 },
        { shard: 4, report: S3 },
      ],
      2
    );
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('shard 2/2: NO REPORT');
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
});
