import { describe, expect, it } from 'vitest';

import { typecheckAppsQueueDecision, typecheckQueueDecision } from '../typecheck-queue.mjs';

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

describe('which app typechecks go through the queue', () => {
  it('queues a full app typecheck when the flag is on', () => {
    expect(typecheckAppsQueueDecision([], ON)).toEqual({ queue: true });
  });

  it('never queues on CI', () => {
    expect(typecheckAppsQueueDecision([], { ...ON, CI: 'true' }).queue).toBe(false);
  });

  it.each(['', '0', 'false', 'off', 'no'])('stays direct when the flag is %j', (flag) => {
    expect(typecheckAppsQueueDecision([], { CIVITAI_TEST_QUEUE: flag }).queue).toBe(false);
  });

  it('stays direct when any argument narrows the run', () => {
    expect(typecheckAppsQueueDecision(['moderator'], ON).queue).toBe(false);
  });

  /**
   * 🔴 This lane does NOT honour the root typecheck's env seams, and that is deliberate. If you are
   * here because you are collapsing the two decisions into one shared function: these two cases are
   * the reason not to. `TYPECHECK_TSC_PATH` is a stub-tsc seam for the ROOT typecheck's own tests,
   * and `TYPECHECK_HEAP_MB` sizes the ROOT typecheck's heap. Neither reaches the per-app `pnpm
   * --filter ... run typecheck` children, so honouring them here would mean a variable exported for
   * an unrelated test silently un-queued the app typechecks - a lane that quietly stops arbitrating
   * the box while still reporting that it ran.
   */
  it('still queues when the root typecheck tsc seam is set, which is not its seam', () => {
    expect(
      typecheckAppsQueueDecision([], { ...ON, TYPECHECK_TSC_PATH: '/stub/tsc.js' }).queue
    ).toBe(true);
  });

  it('still queues when the root typecheck heap override is set, which is not its heap', () => {
    expect(typecheckAppsQueueDecision([], { ...ON, TYPECHECK_HEAP_MB: '4096' }).queue).toBe(true);
  });
});
