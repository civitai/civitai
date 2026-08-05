import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../cli';

/**
 * 🔴 A SOURCE FILE WITH A RAW NUL BYTE IS INVISIBLE TO REVIEW AND TO EVERY SAFETY GREP.
 *
 * `plan.ts` shipped with a literal NUL where `'\0'` was meant — `parts.join('<NUL>')`. Git
 * classified the file as BINARY, so GitHub rendered "Binary file not shown" and all 490
 * lines of the file that decides which production rows get DELETED were unreadable in the
 * pull request whose entire purpose was to be the auditable gate.
 *
 * The second-order damage is worse than the first. `grep` silently outputs nothing on a
 * file it deems binary and exits 1 — which reads as "0 matches", not as "I did not look".
 * A repository-wide grep for a hazard would have skipped this file and returned a clean
 * zero, and the public-repo secret scan run over the diff would have done the same.
 *
 * A comment could not have prevented this, because the byte is invisible in an editor. So
 * it is a test.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const moduleRoot = join(here, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') || name.endsWith('.md') ? [path] : [];
  });
}

const files = sourceFiles(moduleRoot);

describe('source hygiene', () => {
  it('found the module sources (positive control on the sweep below)', () => {
    // A zero-length file list would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('plan.ts'))).toBe(true);
  });

  it.each(files.map((f) => [f.slice(moduleRoot.length + 1), f]))(
    '%s contains no raw NUL byte',
    (_label, path) => {
      const bytes = readFileSync(path);
      expect(bytes.indexOf(0)).toBe(-1);
    }
  );

  it('POSITIVE control: the check can actually detect a NUL', () => {
    // Without this, `indexOf(0) === -1` could be a property of the assertion rather than
    // of the files — exactly the reassuring zero this suite exists to distrust.
    expect(Buffer.from("join('\0')", 'utf8').indexOf(0)).toBe(6);
  });
});

describe('the CLI refuses a bare --measure', () => {
  it('rejects --measure with no relation selector', () => {
    // Counting orphans for every relation is ~27 anti-joins, several over tables with
    // millions of rows, against whatever DATABASE_URL points at. Read-only is not cheap.
    expect(() => parseArgs(['--measure'])).toThrow(/Refusing a bare --measure/);
  });

  it('allows --measure when narrowed to a relation', () => {
    expect(() => parseArgs(['--measure', '--relation', 'ImageTagForReview.imageId'])).not.toThrow();
  });

  it('allows the wide sweep when it is asked for by name', () => {
    expect(() => parseArgs(['--measure', '--all-relations'])).not.toThrow();
  });

  it('still requires --apply to name exactly one relation', () => {
    expect(() => parseArgs(['--measure', '--all-relations', '--apply'])).toThrow(
      /exactly one --relation/
    );
  });

  it('refuses --apply against a captured catalog', () => {
    expect(() =>
      parseArgs(['--apply', '--measure', '--relation', 'X.y', '--catalog', 'c.json'])
    ).toThrow(/cannot be combined with --catalog/);
  });

  it('🔴 importing the CLI does not RUN it', () => {
    // This module has already been imported at the top of this file. If `main()` ran on
    // import it would parse the test runner's argv, fail, and set process.exitCode — and
    // in an environment with DATABASE_URL set it could open a connection from inside a
    // unit test. A tool whose contract is "the default does nothing" must not act merely
    // by being imported.
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });
});
