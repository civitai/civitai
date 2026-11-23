import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

// CI and TYPECHECK_COMPILER are pinned because both change what the wrapper runs, and the suite
// itself runs in CI.
const run = (tscPath: string, env: Record<string, string> = {}, args: string[] = []) =>
  spawnSync(process.execPath, [WRAPPER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TYPECHECK_TSC_PATH: tscPath,
      GITHUB_ACTIONS: '',
      CI: '',
      TYPECHECK_COMPILER: '',
      ...env,
    },
  });

const ARGV_STUB =
  'console.log(JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv }));\nprocess.exit(0);\n';
const received = (stdout: string) =>
  JSON.parse(stdout.split('\n').find((l) => l.startsWith('{"argv"')) ?? 'null') as {
    argv: string[];
    execArgv: string[];
  };

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

  it('names heap exhaustion when V8 aborts with no diagnostics (TypeScript 5.9)', () => {
    const res = run(
      stub(
        'oom',
        [
          "console.error('<--- Last few GCs --->');",
          "console.error('FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory');",
          // Exit 134 is how a shell reports V8's abort; a real abort() dumps core and costs seconds.
          'process.exit(134);',
        ].join('\n')
      ),
      { TYPECHECK_COMPILER: '5' }
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

  // Windows has no signals: `process.kill(pid, 'SIGKILL')` terminates the child with
  // exit code 1 and `signal === null`, so the shape this case exists to produce cannot
  // occur there and the wrapper correctly reports the generic crash instead. The 137
  // case below carries the same classification on every platform.
  it.skipIf(process.platform === 'win32')(
    'distinguishes an outside kill (by signal) from V8 running out of heap',
    () => {
      const res = run(stub('sigkill', "process.kill(process.pid, 'SIGKILL');\n"));

      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain(CRASH_MARKER);
      // Different cause, different fix: more RAM / a LOWER cap, not a higher one.
      expect(res.stderr).toContain('killed from outside');
      expect(res.stderr).not.toContain('ran out of old-space heap');
    }
  );

  // The other half of the same branch, and the half a container actually delivers: a
  // shell reports an OOM-killed child as 128+9 rather than as a signal.
  it('distinguishes an outside kill (exit 137) from V8 running out of heap', () => {
    const res = run(stub('exit137', 'process.exit(137);\n'));

    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(CRASH_MARKER);
    expect(res.stderr).toContain('killed from outside');
    expect(res.stderr).not.toContain('ran out of old-space heap');
  });

  it('names out-of-memory when the TypeScript 7 runtime aborts with no diagnostics', () => {
    const res = run(
      stub(
        'go-oom',
        [
          "console.error('fatal error: runtime: out of memory');",
          // The Go runtime exits 2 on a fatal error.
          'process.exit(2);',
        ].join('\n')
      )
    );

    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(CRASH_MARKER);
    expect(res.stderr).toContain('ran out of memory');
    // The heap cap is a 5.9 setting; telling a TS7 user to raise it would be the wrong fix.
    expect(res.stderr).not.toContain('old-space heap');
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

// Threading rule: single-threaded on dev machines so several agents typechecking at once cannot
// exhaust memory; two checkers in CI.
describe('typecheck wrapper compiler selection', () => {
  it('runs TypeScript 7 single-threaded outside CI, with its own .tsbuildinfo', () => {
    const res = run(stub('argv-dev', ARGV_STUB));

    expect(res.status).toBe(0);
    const { argv, execArgv } = received(res.stdout);
    expect(argv).toContain('--singleThreaded');
    expect(argv).not.toContain('--checkers');
    const buildInfo = argv[argv.indexOf('--tsBuildInfoFile') + 1];
    expect(buildInfo).toMatch(
      /node_modules[\\/]\.cache[\\/]typecheck[\\/]ts7-tsconfig\.tsbuildinfo$/
    );
    expect(execArgv.some((a) => a.startsWith('--max-old-space-size'))).toBe(false);
    expect(res.stdout).toContain('TypeScript 7');
  });

  it('runs TypeScript 7 with two checkers in CI', () => {
    const res = run(stub('argv-ci', ARGV_STUB), { CI: 'true' });

    expect(res.status).toBe(0);
    const { argv } = received(res.stdout);
    expect(argv.slice(argv.indexOf('--checkers'), argv.indexOf('--checkers') + 2)).toEqual([
      '--checkers',
      '2',
    ]);
    expect(argv).not.toContain('--singleThreaded');
  });

  it('keeps a per-project .tsbuildinfo for a narrowed run passed through pnpm', () => {
    const res = run(stub('argv-scripts', ARGV_STUB), {}, ['--', '-p', 'tsconfig.scripts.json']);

    const { argv } = received(res.stdout);
    expect(argv).not.toContain('--');
    expect(argv[argv.indexOf('--tsBuildInfoFile') + 1]).toMatch(
      /ts7-tsconfig\.scripts\.tsbuildinfo$/
    );
  });

  it('gives two projects whose configs share a file name separate .tsbuildinfo files', () => {
    const buildInfoFor = (project: string) => {
      const { argv } = received(run(stub('argv-same-name', ARGV_STUB), {}, ['-p', project]).stdout);
      return argv[argv.indexOf('--tsBuildInfoFile') + 1];
    };

    expect(buildInfoFor('tsconfig.json')).not.toBe(buildInfoFor('apps/moderator/tsconfig.json'));
  });

  it('runs TypeScript 5.9 with the heap cap under TYPECHECK_COMPILER=5', () => {
    const res = run(stub('argv-ts5', ARGV_STUB), { TYPECHECK_COMPILER: '5' });

    expect(res.status).toBe(0);
    const { argv, execArgv } = received(res.stdout);
    expect(execArgv).toContain('--max-old-space-size=8192');
    expect(argv).not.toContain('--singleThreaded');
    expect(argv).not.toContain('--tsBuildInfoFile');
    expect(res.stdout).toContain('TypeScript 5.9');
  });

  it('refuses an unknown TYPECHECK_COMPILER instead of guessing', () => {
    const res = run(stub('never-runs', 'process.exit(0);\n'), { TYPECHECK_COMPILER: '6' });

    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain(OK_MARKER);
  });
});

// Through the real resolver, not the seam: a TypeScript 7 that cannot be installed must stop the
// run, never fall back to 5.9 and report a clean typecheck that checked nothing.
describe('typecheck wrapper when TypeScript 7 cannot be installed', () => {
  it('exits 2 with the install command and never runs 5.9', () => {
    const repo = path.join(dir, 'no-ts7-repo');
    const scripts = path.resolve(__dirname, '..');
    mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
    for (const f of ['typecheck.mjs', 'typecheck-queue.mjs', 'typecheck-apps-gate.mjs']) {
      cpSync(path.join(scripts, f), path.join(repo, 'scripts', f));
    }
    cpSync(path.join(scripts, 'lib', 'ts7.mjs'), path.join(repo, 'scripts', 'lib', 'ts7.mjs'));
    mkdirSync(path.join(repo, 'tools', 'ts7'), { recursive: true });
    writeFileSync(path.join(repo, 'tools', 'ts7', 'package.json'), '{"name":"ts7-fixture"}');
    // A 5.9 that leaves a marker if anything runs it.
    const ran5 = path.join(repo, 'ran-5.9');
    mkdirSync(path.join(repo, 'node_modules', 'typescript', 'lib'), { recursive: true });
    writeFileSync(
      path.join(repo, 'node_modules', 'typescript', 'lib', 'tsc.js'),
      `require('fs').writeFileSync(${JSON.stringify(ran5)}, '');\n`
    );
    // A `next typegen` that only writes the validator, so the run gets as far as the compiler.
    mkdirSync(path.join(repo, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
    writeFileSync(
      path.join(repo, 'node_modules', 'next', 'dist', 'bin', 'next'),
      "const fs = require('fs');\nfs.mkdirSync('.next/types', { recursive: true });\n" +
        "fs.writeFileSync('.next/types/validator.ts', '');\n"
    );
    for (const pkg of ['next', 'typescript']) {
      writeFileSync(
        path.join(repo, 'node_modules', pkg, 'package.json'),
        JSON.stringify({ name: pkg, version: '0.0.0-stub' })
      );
    }
    // A pnpm whose install fails.
    const bin = path.join(repo, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'pnpm'), '#!/usr/bin/env node\nprocess.exit(1);\n');
    chmodSync(path.join(bin, 'pnpm'), 0o755);
    writeFileSync(path.join(bin, 'pnpm.cmd'), '@node "%~dp0pnpm" %*\r\n');

    const res = spawnSync(process.execPath, ['scripts/typecheck.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TYPECHECK_TSC_PATH: '',
        TYPECHECK_COMPILER: '',
        CIVITAI_TEST_QUEUE: '',
        CI: '',
        GITHUB_ACTIONS: '',
      },
    });

    expect(res.status).toBe(2);
    expect(res.stdout).toContain('Nothing was checked');
    expect(res.stderr).toContain('pnpm -C tools/ts7 install');
    expect(res.stdout).not.toContain(OK_MARKER);
    expect(existsSync(ran5)).toBe(false);
    // The lock is released even though the install failed, so the next run can retry.
    expect(existsSync(path.join(repo, 'tools', 'ts7', '.install.lock'))).toBe(false);
  });
});
