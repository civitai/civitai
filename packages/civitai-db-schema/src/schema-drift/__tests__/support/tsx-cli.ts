import { execFile, type ExecFileOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * `node_modules/.bin/tsx` is a POSIX shell script — Windows gets `tsx.CMD` alongside it and
 * `execFile` cannot exec the extensionless one, so every spawn there failed `ENOENT` before the
 * CLI started. Resolving tsx's own entry module and running it under the current `node` is the
 * same command on every platform and skips the shim entirely.
 *
 * 🔴 Resolved per call, NOT at module scope. All three drift test files import this module, so a
 * resolve that throws at module scope — a tsx release dropping the `./cli` export subpath, a
 * partial install — takes all three down during module evaluation, and each collects ZERO tests
 * while the failure count stays at 0. Inside the function it surfaces as a test failure naming
 * the module, which is the same reason the spawn failure below throws instead of returning.
 */
const resolveTsxCli = () => createRequire(import.meta.url).resolve('tsx/cli');

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one of this package's CLIs as a real process and report what an operator would get.
 *
 * A spawn that never produced an exit code THROWS rather than reporting one. `execFile` puts
 * `ENOENT` in the same `code` field as a real exit status, so returning it made a CLI that never
 * ran indistinguishable from one that ran and exited — 32 tests read `expected 'ENOENT' to be 2`,
 * which names the assertion and not the cause.
 */
export async function runTsxCli(
  script: string,
  args: string[],
  options: ExecFileOptions
): Promise<CliRun> {
  const tsxCli = resolveTsxCli();
  try {
    const { stdout, stderr } = await run(process.execPath, [tsxCli, script, ...args], options);
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const e = error as {
      code?: number | string;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    if (typeof e.code !== 'number') {
      // A signal kill DID run — saying otherwise sends the reader looking for a spawn failure.
      const how = e.signal
        ? `was killed by ${e.signal}`
        : `did not run: ${e.code ?? String(error)}`;
      throw new Error(`${script} ${how}\n${e.stderr ?? ''}`);
    }
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
