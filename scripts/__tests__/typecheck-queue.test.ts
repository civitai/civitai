import { describe, expect, it } from 'vitest';

import { typecheckQueueDecision } from '../typecheck-queue.mjs';

const ON = { CIVITAI_TEST_QUEUE: '1' };

describe('which typechecks go through the queue', () => {
  it('queues a full typecheck when the flag is on', () => {
    expect(typecheckQueueDecision([], ON)).toEqual({ queue: true });
  });

  it('never queues on CI', () => {
    expect(typecheckQueueDecision([], { ...ON, CI: 'true' }).queue).toBe(false);
  });

  it.each(['', '0', 'false', 'off', 'no'])('stays direct when the flag is %j', (flag) => {
    expect(typecheckQueueDecision([], { CIVITAI_TEST_QUEUE: flag }).queue).toBe(false);
  });

  // `-p tsconfig.scripts.json` is how the scripts gate runs tsc. Queueing that behind a full-repo
  // check turns a cheap narrow run into a wait, and pushes callers toward batching work into
  // fewer, bigger runs — the opposite of what the queue is for.
  it('stays direct when any argument narrows the run', () => {
    expect(typecheckQueueDecision(['-p', 'tsconfig.scripts.json'], ON).queue).toBe(false);
  });

  /**
   * 🔴 Without this the typecheck TESTS break on any machine with the flag set: each one drives
   * scripts/typecheck.mjs with a stub tsc through this seam, and a queued run is spawned by the
   * daemon, which runs the REAL tsc — so every case would wait behind real typechecks and then
   * assert on the wrong process's output.
   */
  it('stays direct when the tsc test seam is in use', () => {
    expect(typecheckQueueDecision([], { ...ON, TYPECHECK_TSC_PATH: '/stub/tsc.js' }).queue).toBe(
      false
    );
  });

  // A queued run is spawned with the daemon's environment, so the caller's heap override would be
  // silently dropped — they would ask for a size and get the default.
  it('stays direct when the caller overrides the heap', () => {
    expect(typecheckQueueDecision([], { ...ON, TYPECHECK_HEAP_MB: '12288' }).queue).toBe(false);
  });
});
