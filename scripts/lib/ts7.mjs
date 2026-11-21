/**
 * The TypeScript 7 compiler from `tools/ts7`, for `scripts/typecheck.mjs` and
 * `scripts/ci/typecheck-tests-gate.mjs`.
 *
 * `tools/ts7` sits outside the pnpm workspace on purpose (see its README), so a root
 * `pnpm install` does not fetch it. Every place that runs `pnpm run typecheck` (a fresh
 * worktree, a CI job) would otherwise fail until someone installed it by hand, so
 * `resolveTs7` installs it from its own lockfile when it is missing.
 *
 * Two typechecks can start at once in one fresh worktree (runs with arguments, the brake and
 * the gates all bypass the queue), so the install takes an exclusive lock file and a second
 * caller waits for it rather than installing over a half-written `node_modules`.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TS7_TOOL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'ts7'
);
export const TS7_INSTALL_COMMAND = 'pnpm -C tools/ts7 install --ignore-workspace --frozen-lockfile';

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 3 * 60_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function packageDir(toolDir) {
  return join(toolDir, 'node_modules', 'typescript');
}

function isInstalled(toolDir) {
  return existsSync(join(packageDir(toolDir), 'lib', 'getExePath.js'));
}

function install(toolDir, log) {
  const lock = join(toolDir, '.install.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // A lock left by a killed install would otherwise block every later run.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // Gone between the check and the stat: the other install finished.
      }
      if (isInstalled(toolDir)) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for another TypeScript 7 install (${lock})`);
      }
      sleep(1000);
    }
  }
  try {
    if (isInstalled(toolDir)) return;
    log(`TypeScript 7 is not installed in tools/ts7; installing it (${TS7_INSTALL_COMMAND}).`);
    const res = spawnSync('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile'], {
      cwd: toolDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    if (res.status !== 0 || !isInstalled(toolDir)) {
      const detail = [res.error?.message, res.stdout, res.stderr].filter(Boolean).join('\n').trim();
      throw new Error(
        `the tools/ts7 install failed (exit ${res.status})${detail ? `:\n${detail}` : ''}`
      );
    }
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * The native binary's path and the version it was installed as, installing `tools/ts7` first
 * when it is missing. Throws with the install command on any failure, so a caller can never fall
 * back to another compiler without saying so.
 */
export async function resolveTs7({ toolDir = TS7_TOOL_DIR, log = console.log } = {}) {
  if (!isInstalled(toolDir)) install(toolDir, log);
  const dir = packageDir(toolDir);
  try {
    const { default: getExePath } = await import(
      pathToFileURL(join(dir, 'lib', 'getExePath.js')).href
    );
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    return { exe: getExePath(), version };
  } catch (err) {
    // A missing platform package makes getExePath() throw.
    throw new Error(
      `could not resolve the TypeScript 7 binary: ${
        err?.message ?? err
      }. Run: ${TS7_INSTALL_COMMAND}`
    );
  }
}
