import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `scripts/typecheck.mjs` exists to stop a CRASHED typecheck from reading as a
 * clean one. The crash it was built for — V8 aborting on heap exhaustion — emits
 * zero diagnostics and writes its explanation to stderr, so a caller that greps
 * for type errors, or that captures only stdout, sees an empty log.
 *
 * These cases drive the wrapper with stub "typecheckers" that exit the way each
 * real outcome does. That keeps the classifier under test at sub-second cost; a
 * real repo-wide `tsc` run is minutes, so nobody would run it per-case.
 */

const WRAPPER = path.resolve(__dirname, '../typecheck.mjs');

let dir: string;
const stub = (name: string, body: string) => {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
};

// The wrapper always appends --noEmit; stubs ignore argv.
const run = (tscPath: string) =>
  spawnSync(process.execPath, [WRAPPER], {
    encoding: 'utf8',
    env: { ...process.env, TYPECHECK_TSC_PATH: tscPath, GITHUB_ACTIONS: '' },
  });

const CRASH_MARKER = 'TYPECHECK CRASHED';
const OK_MARKER = 'typecheck: OK';
// Built by concatenation so this file's own source cannot be mistaken for a
// diagnostic by the same greps the wrapper is defending against.
const DIAGNOSTIC_MARKER = `error${' '}TS`;
const DIAGNOSTIC_LINE = `src/foo.ts(1,1): ${DIAGNOSTIC_MARKER}2322: Type 'string' is not assignable to type 'number'.`;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'typecheck-guard-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('typecheck wrapper outcome classification', () => {
  it('reports a clean run explicitly rather than by silence', () => {
    const res = run(stub('clean', 'process.exit(0);\n'));

    expect(res.status).toBe(0);
    // The success line is the point: a clean `tsc` prints nothing, which is
    // byte-identical to a crash whose stderr was dropped.
    expect(res.stdout).toContain(OK_MARKER);
    expect(res.stdout).not.toContain(CRASH_MARKER);
  });

  it('passes ordinary type errors through untouched', () => {
    const res = run(
      stub('errors', `console.log(${JSON.stringify(DIAGNOSTIC_LINE)});\nprocess.exit(2);\n`)
    );

    expect(res.status).toBe(2);
    expect(res.stdout).toContain(DIAGNOSTIC_MARKER);
    // A real type error is not a crash, and must not be dressed up as one.
    expect(res.stdout).not.toContain(CRASH_MARKER);
    expect(res.stdout).not.toContain(OK_MARKER);
  });

  it('names heap exhaustion when V8 aborts with no diagnostics', () => {
    const res = run(
      stub(
        'oom',
        [
          "console.error('<--- Last few GCs --->');",
          "console.error('FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory');",
          'process.abort();',
        ].join('\n')
      )
    );

    expect(res.status).not.toBe(0);
    // Loud on stdout, because the log that hid this originally was stdout-only.
    expect(res.stdout).toContain(CRASH_MARKER);
    expect(res.stdout).not.toContain(OK_MARKER);
    expect(res.stderr).toContain('ran out of old-space heap');
    // And the wrapper's own crash report must not contain the marker callers
    // grep for, or the report itself reads as a type error. Checked on BOTH
    // streams: the report is written to stderr, so a stdout-only assertion here
    // passes with the marker reintroduced (it did, until this line was added).
    expect(res.stdout).not.toContain(DIAGNOSTIC_MARKER);
    expect(res.stderr).not.toContain(DIAGNOSTIC_MARKER);
  });

  it('distinguishes an outside kill from V8 running out of heap', () => {
    const res = run(stub('sigkill', "process.kill(process.pid, 'SIGKILL');\n"));

    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(CRASH_MARKER);
    // Different cause, different fix: more RAM / a LOWER cap, not a higher one.
    expect(res.stderr).toContain('killed from outside');
    expect(res.stderr).not.toContain('ran out of old-space heap');
  });

  it('refuses to call it a pass when tsc exits 0 while printing diagnostics', () => {
    const res = run(
      stub('contradiction', `console.log(${JSON.stringify(DIAGNOSTIC_LINE)});\nprocess.exit(0);\n`)
    );

    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(CRASH_MARKER);
    expect(res.stdout).not.toContain(OK_MARKER);
  });
});
