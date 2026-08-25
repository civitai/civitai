import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression tests for scripts/ci/assert-shard-ran.mjs — the positive control on a sharded
 * `Unit tests` job.
 *
 * 🔴 The case this file exists for is `all tests skipped`. The guard counts EXECUTED
 * assertions (passed + failed), not `report.numTotalTests`, because the latter counts
 * skipped tests too — so a shard whose files all self-skip on a missing env var reports a
 * healthy-looking total while executing nothing. That is not hypothetical: several suites
 * in this repo self-skip that way, and the sibling guard
 * (scripts/ci/assert-workspace-suites-ran.mjs) documents having had exactly this hole.
 *
 * Anyone "simplifying" the counting back to `numTotalTests` should see this go red.
 */

const SCRIPT = resolve(__dirname, '../ci/assert-shard-ran.mjs');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'assert-shard-ran-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a vitest-shaped JSON report with a given number of executed / skipped assertions. */
function report(name: string, executed: number, skipped: number, files = 10) {
  const testResults = Array.from({ length: files }, (_, i) => ({
    name: `/repo/src/file-${i}.test.ts`,
    assertionResults: [] as { status: string }[],
  }));
  for (let i = 0; i < executed; i++)
    testResults[i % files].assertionResults.push({ status: 'passed' });
  for (let i = 0; i < skipped; i++)
    testResults[i % files].assertionResults.push({ status: 'skipped' });
  const path = join(dir, `${name}.json`);
  // numTotalTests deliberately counts BOTH, exactly as vitest emits it.
  writeFileSync(path, JSON.stringify({ numTotalTests: executed + skipped, testResults }));
  return path;
}

const run = (reportPath: string, shard = 1, total = 4) =>
  spawnSync(process.execPath, [SCRIPT, reportPath, String(shard), String(total)], {
    encoding: 'utf8',
  });

describe('assert-shard-ran', () => {
  it('passes a healthy shard', () => {
    expect(run(report('healthy', 4200, 12)).status).toBe(0);
  });

  it('fails a shard that executed nothing', () => {
    const r = run(report('zero', 0, 0, 1));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/RAN ZERO TESTS/);
  });

  // THE ONE THAT MATTERS. numTotalTests is healthy; execution is zero.
  it('fails a shard whose tests ALL SKIPPED, despite a healthy numTotalTests', () => {
    const path = report('all-skipped', 0, 4200);
    expect(JSON.parse(readFileSync(path, 'utf8')).numTotalTests).toBe(4200);
    const r = run(path);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/RAN ZERO TESTS/);
  });

  it('fails a shard far below the floor', () => {
    const r = run(report('too-few', 400, 0));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/floor/i);
  });

  // The inverse failure: --shard stops reaching vitest, so every shard runs everything.
  it('fails a shard carrying the whole suite', () => {
    const r = run(report('whole-suite', 16784, 0, 1065));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ceiling|WHOLE suite/i);
  });

  it('fails when the report is missing or unparseable', () => {
    expect(run(join(dir, 'does-not-exist.json')).status).toBe(1);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'not json');
    expect(run(bad).status).toBe(1);
  });

  // exit 2 = a config mistake, deliberately distinct from exit 1 = a real finding.
  it('exits 2 when the matrix and the denominator disagree', () => {
    expect(run(report('drift', 4200, 0), 6, 4).status).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });
});
