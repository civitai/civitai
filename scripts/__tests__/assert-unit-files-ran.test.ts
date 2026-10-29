import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/ci/assert-unit-files-ran.mjs: the executed set of a narrowed unit job must equal the
 * selected set. Report paths are absolute (as vitest writes them) and the list is relative to the
 * cwd, so each case runs the script from a temp dir that plays the repo root.
 */

const SCRIPT = resolve(__dirname, '../ci/assert-unit-files-ran.mjs');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'assert-unit-files-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';
const result = (file: string, ...statuses: Status[]) => ({
  name: join(dir, file),
  assertionResults: statuses.map((status) => ({ status })),
});

const run = (testResults: unknown[] | null, list: string[]) => {
  if (testResults) writeFileSync(join(dir, 'report.json'), JSON.stringify({ testResults }));
  writeFileSync(join(dir, 'files.txt'), list.map((f) => `${f}\n`).join(''));
  const r = spawnSync('node', [SCRIPT, 'report.json', 'files.txt'], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};

describe('assert-unit-files-ran', () => {
  it('passes when exactly the selected files ran', () => {
    const r = run(
      [result('src/alpha.test.ts', 'passed', 'passed'), result('scripts/beta.test.ts', 'failed')],
      ['src/alpha.test.ts', 'scripts/beta.test.ts']
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('2 files ran of 2 selected; 3 tests executed');
  });

  it('fails, naming the file, when a selected file did not run', () => {
    const r = run(
      [result('src/alpha.test.ts', 'passed')],
      ['src/alpha.test.ts', 'src/gamma.test.ts']
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('1 SELECTED file(s) did not run:\n  src/gamma.test.ts');
  });

  it('fails, naming the file, when an unselected file ran', () => {
    // Vitest reads each path as a substring filter, which can match more than the file it names.
    const r = run(
      [result('src/alpha.test.ts', 'passed'), result('src/delta.test.ts', 'passed')],
      ['src/alpha.test.ts']
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('1 file(s) ran that were NOT selected:\n  src/delta.test.ts');
  });

  it('fails when every selected file skipped itself', () => {
    const r = run(
      [result('src/alpha.test.ts', 'skipped', 'todo'), result('src/epsilon.test.ts', 'pending')],
      ['src/alpha.test.ts', 'src/epsilon.test.ts']
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('EXECUTED ZERO TESTS across 2 files');
  });

  it('counts a failed test as executed', () => {
    expect(run([result('src/alpha.test.ts', 'failed')], ['src/alpha.test.ts']).status).toBe(0);
  });

  it('fails when there is no report', () => {
    const r = run(null, ['src/alpha.test.ts']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('vitest wrote no JSON report');
  });

  it('fails on an empty selection list', () => {
    const r = run([], []);
    expect(r.status).toBe(1);
    expect(r.out).toContain('is empty');
  });

  it('exits 2 without arguments', () => {
    expect(spawnSync('node', [SCRIPT], { cwd: dir }).status).toBe(2);
  });
});
