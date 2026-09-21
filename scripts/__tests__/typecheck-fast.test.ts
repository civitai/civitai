import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `scripts/typecheck-fast.mjs` runs a different compiler from the authoritative one, so the
 * two ways it can lie are the ones that matter: reporting a crash as a pass, and being
 * mistaken for `pnpm run typecheck`. These cases drive the classifier with stubs that exit
 * the way each outcome does, at sub-second cost — a real run is ~29s cold.
 *
 * Mirrors scripts/__tests__/typecheck.test.ts, which guards the 5.9 wrapper the same way.
 */

const WRAPPER = path.resolve(__dirname, '../typecheck-fast.mjs');

let dir: string;
const stub = (name: string, body: string) => {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
};

const run = (tscPath: string, args: string[] = []) =>
  spawnSync(process.execPath, [WRAPPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TYPECHECK_FAST_TSC_PATH: tscPath },
  });

const CRASH_MARKER = 'TYPECHECK:FAST CRASHED';
const OK_MARKER = 'typecheck:fast: 0 diagnostics';
const NOT_AUTHORITATIVE = 'NOT authoritative';
// Built by concatenation so this file's own source cannot be mistaken for a diagnostic by
// the same greps the wrapper defends against.
const DIAGNOSTIC_MARKER = `error${' '}TS`;
const DIAGNOSTIC_LINE = `src/foo.ts(1,1): ${DIAGNOSTIC_MARKER}2322: Type 'string' is not assignable to type 'number'.`;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'typecheck-fast-guard-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('typecheck:fast outcome classification', () => {
  it('reports a clean run explicitly rather than by silence', () => {
    const res = run(stub('clean', 'process.exit(0);\n'));

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(OK_MARKER);
    expect(res.stdout).not.toContain(CRASH_MARKER);
  });

  it('passes diagnostics through without dressing them as a crash', () => {
    const res = run(
      stub('errors', `console.log(${JSON.stringify(DIAGNOSTIC_LINE)});\nprocess.exit(2);\n`)
    );

    expect(res.status).toBe(2);
    expect(res.stdout).toContain(DIAGNOSTIC_MARKER);
    expect(res.stdout).not.toContain(CRASH_MARKER);
    expect(res.stdout).not.toContain(OK_MARKER);
  });

  it('calls a non-zero exit with no diagnostics a CRASH, never a pass', () => {
    // The failure this whole wrapper exists for: an empty log is byte-identical to a clean
    // run, so silence plus a bad exit code must never be reported as a result.
    const res = run(stub('crash', 'process.exit(134);\n'));

    expect(res.status).toBe(134);
    expect(res.stdout).toContain(CRASH_MARKER);
    expect(res.stdout).not.toContain(OK_MARKER);
    // The crash report must not itself look like a diagnostic to a caller grepping for one.
    expect(res.stdout).not.toContain(DIAGNOSTIC_MARKER);
    expect(res.stderr).not.toContain(DIAGNOSTIC_MARKER);
  });

  it('treats a zero exit that printed diagnostics as a crash rather than a verdict', () => {
    const res = run(
      stub('contradictory', `console.log(${JSON.stringify(DIAGNOSTIC_LINE)});\nprocess.exit(0);\n`)
    );

    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(CRASH_MARKER);
    expect(res.stdout).not.toContain(OK_MARKER);
  });
});

describe('typecheck:fast does not pass for the authoritative check', () => {
  // The named risk is someone quoting this run as if it were `pnpm run typecheck`. The
  // disclaimer is on the LAST line as well as the first, because a header scrolls off and
  // the tail is what gets pasted.
  it.each([
    ['clean', 'process.exit(0);\n'],
    ['errors', `console.log(${JSON.stringify(DIAGNOSTIC_LINE)});\nprocess.exit(2);\n`],
    ['crash', 'process.exit(134);\n'],
  ])('says so on the last line of output for a %s run', (name, body) => {
    const res = run(stub(`disclaimer-${name}`, body));
    const combined = `${res.stdout}${res.stderr}`;
    const lines = combined.trimEnd().split(/\r?\n/);

    expect(combined).toContain(NOT_AUTHORITATIVE);
    expect(lines[lines.length - 1]).toContain(NOT_AUTHORITATIVE);
  });
});

describe('typecheck:fast constrains what the compiler is asked to check', () => {
  // Without these two, "0 diagnostics" means only "the process I spawned exited 0 quietly",
  // which a compiler asked to check one file — or none — also satisfies. Reported against
  // 8183a2e75a, where `typecheck-fast.mjs --version` printed "0 diagnostics" and exited 0.
  it('asks for exactly --noEmit over the whole project, and nothing else', () => {
    const res = run(stub('argv', 'console.log(process.argv.slice(2).join(" "));\n'));
    // The stub echoes its argv on the line after the wrapper's banner.
    const echoed = res.stdout.split(/\r?\n/)[1];

    expect(res.status).toBe(0);
    expect(echoed.startsWith('--noEmit -p tsconfig.json --tsBuildInfoFile ')).toBe(true);
    // Asserted by equality, not by `toContain`: a substring check is blind to an insertion
    // BESIDE the anchor, and one appended token is enough to undo the guard — `--noCheck`
    // measured at exit 0 with no output on a project holding a real type error.
    expect(echoed.split(' ').filter((token) => token.startsWith('-'))).toEqual([
      '--noEmit',
      '-p',
      '--tsBuildInfoFile',
    ]);
  });

  it('refuses caller arguments rather than forwarding them to the compiler', () => {
    // tsc's parser is last-wins, so a forwarded `-p` silently replaces the project.
    const res = run(stub('rejects', 'process.exit(0);\n'), ['-p', 'somewhere/else.json']);

    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain(OK_MARKER);
    expect(res.stderr).toContain('takes no arguments');
  });

  it('accepts the bare -- that pnpm forwards', () => {
    const res = run(stub('dashdash', 'process.exit(0);\n'), ['--']);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(OK_MARKER);
  });

  it('ignores the test seam outside vitest, rather than compiling whatever it names', () => {
    // Constraining the compiler's arguments is worth nothing while an exported variable can
    // still choose which program IS the compiler: a stray export made this report
    // "0 diagnostics" for a script that compiled nothing.
    const { VITEST, VITEST_WORKER_ID, VITEST_POOL_ID, ...envWithoutVitest } = process.env;
    const res = spawnSync(process.execPath, [WRAPPER], {
      encoding: 'utf8',
      env: { ...envWithoutVitest, TYPECHECK_FAST_TSC_PATH: stub('stray', 'process.exit(0);\n') },
    });

    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain(OK_MARKER);
    expect(res.stderr).toContain('only under vitest');
  });
});
