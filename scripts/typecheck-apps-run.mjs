/**
 * `pnpm run typecheck:apps` - typecheck every app under `apps/`, through the dev-server queue.
 *
 * The work itself lives in `scripts/ci/typecheck-apps.mjs` and predates this file; until now only
 * CI ran it, so a local app typecheck was either not run at all or run beside a full suite with
 * nothing arbitrating the box. This wrapper is the lane, not the check.
 *
 * With CIVITAI_TEST_QUEUE set the run is handed to the queue's `typecheckApps` lane, which spawns
 * `pnpm run typecheck:apps` back in this worktree with the flag off - so the child arrives here
 * again and takes the direct path below.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { typecheckAppsQueueDecision } from './typecheck-queue.mjs';

const args = process.argv.slice(2);

// Top-level await on purpose: a queued run never returns, because the client exits the process
// with the run's own verdict. Everything below is reached only when the queue could not take it.
if (typecheckAppsQueueDecision(args, process.env).queue) {
  const client = resolve(dirname(fileURLToPath(import.meta.url)), 'test-unit-run.mjs');
  if (existsSync(client)) {
    const { runQueued, queueAccepted } = await import(pathToFileURL(client).href);
    try {
      await runQueued([], { kind: 'typecheckApps', fallback: () => undefined });
    } catch (err) {
      // After the queue has accepted the run, falling back would start a SECOND app typecheck
      // beside the one the queue is holding a slot for. Exit instead and say where the run is.
      if (queueAccepted()) {
        console.error(
          `Lost contact with the test queue (${err?.message ?? err}). The run may still be queued.`
        );
        process.exit(2);
      }
      console.error(`App typecheck queue failed (${err?.message ?? err}); running directly.`);
    }
  }
}

const { runTypecheckApps } = await import('./ci/typecheck-apps.mjs');
process.exit(runTypecheckApps());
