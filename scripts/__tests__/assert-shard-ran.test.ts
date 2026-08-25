import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression tests for scripts/ci/assert-shard-ran.mjs — the positive control on a sharded
 * `Unit tests` job.
 *
 * 🔴 An adversarial audit ran 12 mutants against an earlier version of this file and FIVE
 * survived. Each of the five now has a case below, named so it is obvious what breaks if it
 * is deleted:
 *
 *   - dropping 'failed' from the EXECUTED set        -> 'counts a FAILED test as executed'
 *   - floor  `<` -> `<=`                             -> 'exactly at the floor passes'
 *   - ceiling `>` -> `>=`                            -> 'exactly at the ceiling passes'
 *   - dropping the `total < 1` guard                 -> 'rejects a zero/negative shard total'
 *   - `skipped += 1` -> `+= 0`                       -> 'reports the skipped count'
 *
 * The lesson worth keeping: every one of those survived a suite that LOOKED thorough. A
 * guard is only covered at the boundaries and on the branches a fixture actually reaches,
 * and 'my docstring says it handles X' is not coverage of X.
 *
 * The other case this file exists for is `all tests skipped`. The guard counts EXECUTED
 * assertions (passed + failed), not `report.numTotalTests`, because the latter counts
 * skipped tests too — so a shard whose files all self-skip on a missing env var reports a
 * healthy-looking total while executing nothing. Not hypothetical: several suites in this
 * repo self-skip that way, and scripts/ci/assert-workspace-suites-ran.mjs documents having
 * had exactly this hole.
 */

const SCRIPT = resolve(__dirname, '../ci/assert-shard-ran.mjs');

// Kept in step with BASE_TESTS in the script. The band at N=4 is 1662..9971 around an
// expected ~5539, so the boundary cases below are computed rather than hardcoded.
const BASE_TESTS = 22157;
const expectedFor = (total: number) => BASE_TESTS / total;
const floorFor = (total: number) => Math.max(100, Math.round(expectedFor(total) * 0.3));
const ceilingFor = (total: number) => Math.round(expectedFor(total) * 1.8);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'assert-shard-ran-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a vitest-shaped JSON report with given numbers of passed / failed / skipped. */
function report(
  name: string,
  { passed = 0, failed = 0, skipped = 0, files = 10 }: Record<string, number>
) {
  const testResults = Array.from({ length: files }, (_, i) => ({
    name: `/repo/src/file-${i}.test.ts`,
    assertionResults: [] as { status: string }[],
  }));
  const push = (n: number, status: string) => {
    for (let i = 0; i < n; i++) testResults[i % files].assertionResults.push({ status });
  };
  push(passed, 'passed');
  push(failed, 'failed');
  push(skipped, 'skipped');
  const path = join(dir, `${name}.json`);
  // numTotalTests deliberately counts ALL THREE, exactly as vitest emits it.
  writeFileSync(path, JSON.stringify({ numTotalTests: passed + failed + skipped, testResults }));
  return path;
}

const run = (reportPath: string, shard = 1, total = 4) =>
  spawnSync(process.execPath, [SCRIPT, reportPath, String(shard), String(total)], {
    encoding: 'utf8',
  });

describe('assert-shard-ran', () => {
  it('passes a healthy shard', () => {
    expect(run(report('healthy', { passed: 5539, skipped: 12 })).status).toBe(0);
  });

  it('fails a shard that executed nothing', () => {
    const r = run(report('zero', { files: 1 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/EXECUTED ZERO TESTS/);
  });

  // numTotalTests is healthy; execution is zero.
  it('fails a shard whose tests ALL SKIPPED, despite a healthy numTotalTests', () => {
    const path = report('all-skipped', { skipped: 5539 });
    expect(JSON.parse(readFileSync(path, 'utf8')).numTotalTests).toBe(5539);
    const r = run(path);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/EXECUTED ZERO TESTS/);
  });

  // MUTANT: EXECUTED = new Set(['passed']). A shard of entirely failing tests DID the work.
  it('counts a FAILED test as executed — a red shard still ran', () => {
    const r = run(report('all-failed', { failed: 5539 }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/5539 executed/);
  });

  // MUTANT: `skipped += 1` -> `+= 0`.
  it('reports the skipped count alongside the executed count', () => {
    const r = run(report('mixed', { passed: 5000, failed: 39, skipped: 500 }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/5039 executed, 500 skipped/);
  });

  it('fails a shard far below the floor', () => {
    const r = run(report('too-few', { passed: 400 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/floor/i);
  });

  // MUTANT: floor `<` -> `<=`. Exactly at the floor is acceptable; one below is not.
  it('accepts exactly the floor and rejects one below it', () => {
    const floor = floorFor(4);
    expect(run(report('at-floor', { passed: floor })).status).toBe(0);
    expect(run(report('below-floor', { passed: floor - 1 })).status).toBe(1);
  });

  // The inverse failure: --shard stops reaching vitest, so every shard runs everything.
  it('fails a shard carrying the whole suite', () => {
    const r = run(report('whole-suite', { passed: BASE_TESTS, files: 1417 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ceiling/i);
  });

  // 🔴 And it must name BOTH causes — "sharding broke" and "the suite grew" are
  // indistinguishable from inside one shard, so asserting either one alone is a gate that
  // lies about why it is red.
  it('names both causes when the ceiling trips, not just a broken --shard', () => {
    const r = run(report('over-ceiling', { passed: BASE_TESTS, files: 1417 }));
    expect(r.stderr).toMatch(/not reaching vitest/);
    expect(r.stderr).toMatch(/grown past BASE_TESTS/);
  });

  // MUTANT: ceiling `>` -> `>=`. Exactly at the ceiling is acceptable; one above is not.
  it('accepts exactly the ceiling and rejects one above it', () => {
    const ceiling = ceilingFor(4);
    expect(run(report('at-ceiling', { passed: ceiling })).status).toBe(0);
    expect(run(report('above-ceiling', { passed: ceiling + 1 })).status).toBe(1);
  });

  // 🔴 The bounds must SCALE with `total`. A count that is a healthy quarter is a collapsed
  // half and an impossible sixteenth — the same number, three verdicts.
  it('scales its band with the shard total — one count, three verdicts', () => {
    // Bands at BASE_TESTS=22157:  N=2 3324..19941   N=4 1662..9971   N=16 415..2493
    // 3000 is the only interesting region: inside N=4, under N=2's floor, over N=16's
    // ceiling. Computed rather than hardcoded so it follows BASE_TESTS.
    const count = 3000;
    expect(count).toBeGreaterThan(ceilingFor(16));
    expect(count).toBeLessThan(floorFor(2));

    expect(run(report('n4', { passed: count }), 1, 4).status).toBe(0);
    // Same count at N=2 is barely a quarter of the half it should be — collapsed.
    expect(run(report('n2', { passed: count }), 1, 2).status).toBe(1);
    // Same count at N=16 is double a sixteenth — it is carrying other shards' work.
    expect(run(report('n16', { passed: count }), 1, 16).status).toBe(1);
  });

  it('fails when the report is missing or unparseable', () => {
    expect(run(join(dir, 'does-not-exist.json')).status).toBe(1);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'not json');
    expect(run(bad).status).toBe(1);
  });

  // exit 2 = a config mistake, deliberately distinct from exit 1 = a real finding.
  it('exits 2 when the matrix and the denominator disagree', () => {
    expect(run(report('drift', { passed: 5539 }), 6, 4).status).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });

  // A zero/negative total would make `expected` Infinity or NaN and silently disable every
  // bound. It is rejected by the RANGE check (1 <= shard <= total), not by a separate
  // `total < 1` clause — there used to be one and a mutation sweep proved it unkillable,
  // because the range check catches the same inputs first. This pins the behaviour, which is
  // real, rather than the redundant clause, which was not.
  it('rejects a zero or negative shard total instead of computing an infinite band', () => {
    const path = report('bad-total', { passed: 5539 });
    expect(run(path, 1, 0).status).toBe(2);
    expect(run(path, 1, -4).status).toBe(2);
    expect(run(path, 1, 0).stderr).toMatch(/outside 1\.\.0/);
  });
});
