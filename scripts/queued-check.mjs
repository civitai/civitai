/**
 * `node scripts/queued-check.mjs <kind> [args...]` - run one wrapped suite, through the queue.
 *
 * One wrapper for the lanes whose package script was a bare `vitest run`, rather than a file each:
 * the only thing that differs between them is the command on the direct path, and that lives in
 * `queued-check-rules.mjs` beside the decision.
 *
 * With CIVITAI_TEST_QUEUE set the run is handed to the lane named by `<kind>`, which spawns
 * `pnpm run <that lane's script>` back in this worktree with the flag off - so the child arrives
 * here again and takes the direct path below.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DIRECT_COMMANDS,
  directCommandFor,
  queuedCheckDecision,
} from './queued-check-rules.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [kind, ...args] = process.argv.slice(2);

const direct = DIRECT_COMMANDS[kind];
if (!direct) {
  // Naming a lane that has no command would otherwise queue a run whose child does nothing and
  // reports success - a whole suite silently not running, which is the failure this file is least
  // able to notice on its own.
  console.error(
    `queued-check: unknown kind "${kind}". Known: ${Object.keys(DIRECT_COMMANDS).join(', ')}.`
  );
  process.exit(2);
}

// Top-level await on purpose: a queued run never returns, because the client exits the process
// with the run's own verdict. Everything below is reached only when the queue could not take it.
if (queuedCheckDecision(args, process.env).queue) {
  const client = resolve(repoRoot, 'scripts/test-unit-run.mjs');
  if (existsSync(client)) {
    const { runQueued, queueAccepted } = await import(pathToFileURL(client).href);
    try {
      await runQueued([], { kind, fallback: () => undefined });
    } catch (err) {
      // After the queue has accepted the run, falling back would start a SECOND suite beside the
      // one the queue is holding a slot for. Exit instead and say where the run is.
      if (queueAccepted()) {
        console.error(
          `Lost contact with the test queue (${err?.message ?? err}). The run may still be queued.`
        );
        process.exit(2);
      }
      console.error(`Test queue failed (${err?.message ?? err}); running directly.`);
    }
  }
}

const command = directCommandFor(kind, args);
const child = spawn(
  process.platform === 'win32' && command.cmd === 'pnpm' ? 'pnpm.cmd' : command.cmd,
  command.argv,
  { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' }
);
child.on('error', (err) => {
  console.error(`queued-check: could not start ${direct.cmd}: ${err.message}`);
  process.exit(2);
});
// A signal-killed child reports null, and `process.exit(null)` is `process.exit(0)` - a suite
// killed mid-run would report as a pass.
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
