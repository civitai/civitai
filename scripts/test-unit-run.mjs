#!/usr/bin/env node
/**
 * `pnpm run test:unit:run` — runs the unit suite, optionally through the dev-server queue.
 *
 * Off by default: with no flag set this spawns exactly the vitest command the script used to be,
 * so CI and anyone who does not run the daemon see no change at all.
 *
 * With CIVITAI_TEST_QUEUE set, a full-suite run is routed through the daemon's queue instead, which
 * serialises it against every other agent on the machine. Routing rather than refusing is the whole
 * point: there is no second command to learn, nothing to wrap around, and an agent that never read
 * the guidance still gets queued.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(repoRoot, '.claude/skills/dev-server/cli.mjs');
// The queue module owns the one rule that decides pass from fail. It is imported dynamically
// rather than at the top of the file because it lives under `.claude/`, which the direct path
// must keep working without: a static import would fail the whole script when the skill is absent.
const QUEUE = resolve(repoRoot, '.claude/skills/dev-server/scripts/test-queue.mjs');
// Same override the CLI and the daemon honour, and from the same module, so no two of the three
// can disagree about where the daemon is. Without it this file could only ever talk to the shared
// daemon, which is why the verdict below had no test: there was no way to stand a fake one up
// beside it. Imported on the queue path only, for the reason given above QUEUE.
const PORT_MODULE = resolve(repoRoot, '.claude/skills/dev-server/scripts/daemon-port.mjs');
let DAEMON = null;
const POLL_MS = 2000;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function queueDecision(args, env) {
  if (env.CI) return { queue: false, why: 'CI runs the suite directly' };
  if (!env.CIVITAI_TEST_QUEUE || /^(0|false|off|no)$/i.test(env.CIVITAI_TEST_QUEUE)) {
    return { queue: false, why: 'CIVITAI_TEST_QUEUE is not set' };
  }
  // A narrow run is cheap and is the fast iteration loop. Queueing it behind a full suite would
  // turn a two-second check into a nine-minute wait, and push callers toward batching more work
  // into each run — the opposite of what this is for.
  if (args.some((a) => TEST_FILE.test(a))) return { queue: false, why: 'run names specific files' };
  return { queue: true };
}

function runDirect(args) {
  // Resolved from node_modules rather than PATH, so this behaves the same when run directly as it
  // does under `pnpm run`, which is the only context that puts .bin on PATH.
  const local = resolve(
    repoRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
  );
  const bin = existsSync(local) ? local : 'vitest';
  const child = spawn(bin, ['run', '--project', 'unit*', ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
  child.on('error', (err) => {
    console.error(`Failed to start vitest: ${err.message}`);
    process.exit(1);
  });
}

async function post(path, body) {
  const res = await fetch(`${DAEMON}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`daemon returned ${res.status}`);
  return res.json();
}

function ensureDaemon() {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, 'status'], { cwd: repoRoot, stdio: 'ignore' });
    child.on('exit', () => done());
    child.on('error', () => done());
  });
}

/**
 * The queue keeps a bounded window of a run's output. Dropping the oldest lines is fine; dropping
 * them SILENTLY is not, because a truncated log is indistinguishable from a complete one — that is
 * how a clipped log gets quoted as a full-suite pass. Say the number out loud instead.
 */
function warnIfLogsDropped(state) {
  if (!state.logsDropped) return;
  console.error(
    `WARNING: this log is INCOMPLETE — the queue dropped the oldest ${state.logsDropped} of ` +
      `${state.logIndex} output lines. Do not read the text above as the whole run.`
  );
}

async function runQueued(args) {
  // Resolved once, up front: this is the module that decides pass from fail, and a waiter that
  // discovers it cannot load that rule at the moment it must apply it has no verdict to give.
  const { exitCodeFor } = await import(pathToFileURL(QUEUE).href);

  // Resolving the daemon's address can THROW — a malformed DEV_DAEMON_PORT is rejected rather
  // than silently becoming NaN. That must not cost the caller their test run: the guarantee at
  // :123 is that the queue being unusable degrades to a direct run, and an unusable ADDRESS is
  // the queue being unusable. Before this catch existed the throw escaped an un-awaited
  // `runQueued` as an unhandled rejection and no tests ran at all.
  try {
    const { resolveDaemonUrl } = await import(pathToFileURL(PORT_MODULE).href);
    DAEMON = resolveDaemonUrl();
  } catch (err) {
    console.error(`Test queue address unusable (${err.message}); running directly.`);
    return runDirect(args);
  }

  let run;
  try {
    run = await post('/test-runs', { worktree: repoRoot, args });
  } catch {
    await ensureDaemon();
    try {
      run = await post('/test-runs', { worktree: repoRoot, args });
    } catch (err) {
      // Never leave a caller unable to run tests because the queue is unavailable.
      console.error(`Test queue unreachable (${err.message}); running directly.`);
      return runDirect(args);
    }
  }

  if (run.status === 'queued') {
    console.error(
      run.paused
        ? `Queued at position ${run.position}. The queue is PAUSED (concurrency 0) — nothing starts until it is raised.`
        : `Queued at position ${run.position} of ${run.queueLength} (${run.running}/${run.concurrency} running).`
    );
  }

  let lastLog = -1;
  for (;;) {
    const res = await fetch(`${DAEMON}/test-runs/${run.id}`);
    if (res.status === 404) {
      console.error(
        `The daemon forgot run ${run.id} — it was most likely restarted. Re-run this command.`
      );
      process.exit(2);
    }
    if (!res.ok) {
      console.error(`Lost contact with the test queue (${res.status}).`);
      process.exit(2);
    }
    const state = await res.json();

    const logs = await fetch(`${DAEMON}/test-runs/${run.id}/logs?since=${lastLog}`).then((r) =>
      r.json()
    );
    for (const entry of logs.logs ?? []) {
      console.log(entry.message);
      lastLog = entry.index;
    }

    if (state.status !== 'queued' && state.status !== 'running') {
      if (state.status !== 'completed')
        console.error(`Run ${state.status}${state.error ? `: ${state.error}` : ''}`);
      warnIfLogsDropped(state);
      // The verdict comes from the queue's own `exitCodeFor`, never from a second copy of the rule
      // here. The copy that used to live on this line read `state.exitCode || 1`, which passes a
      // signal-killed run's recorded -1 straight through: `process.exit(-1)` gives the shell 255,
      // the exact number `exitCodeFor` exists to avoid, and `[ $? -eq 1 ]` misreads it.
      process.exit(exitCodeFor(state));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const decision = queueDecision(args, process.env);
  if (decision.queue && existsSync(CLI) && existsSync(QUEUE) && existsSync(PORT_MODULE)) {
    // Un-awaited at top level, so anything runQueued throws would otherwise be an unhandled
    // rejection that kills the process with no tests run. The same guarantee as :123.
    runQueued(args).catch((err) => {
      console.error(`Test queue failed (${err.message}); running directly.`);
      runDirect(args);
    });
  } else runDirect(args);
}
