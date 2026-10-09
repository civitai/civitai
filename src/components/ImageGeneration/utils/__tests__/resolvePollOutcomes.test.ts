import { describe, expect, it } from 'vitest';
import { POLLABLE_STATUSES } from '~/shared/constants/orchestrator.constants';
import { resolvePollOutcomes } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';

type Outcome = Parameters<typeof resolvePollOutcomes>[1][number];

// Taken FROM the production constant rather than spelled out. `@civitai/client`'s `WorkflowStatus`
// members read as `undefined` under Vitest though they are real strings in a build, so a literal
// 'processing' matches nothing and a literal 'succeeded' matches everything — both silently.
const RUNNING = POLLABLE_STATUSES[0];
const FINISHED = '__not_a_pollable_status__';

const ok = (id: string, status: unknown): Outcome =>
  ({ status: 'fulfilled', value: { id, status, steps: [] } } as unknown as Outcome);
const gone = (): Outcome => ({ status: 'fulfilled', value: undefined } as unknown as Outcome);
const failed = (code?: string): Outcome =>
  ({ status: 'rejected', reason: code ? { data: { code } } : new TypeError('network') } as Outcome);

describe('resolvePollOutcomes', () => {
  // Positive control. Without it every assertion below passes against an empty or all-undefined
  // constant, which is exactly the state this suite runs in.
  it('has fixtures the production constant can tell apart', () => {
    expect(POLLABLE_STATUSES.length).toBeGreaterThan(0);
    expect(POLLABLE_STATUSES).toContain(RUNNING);
    expect(POLLABLE_STATUSES).not.toContain(FINISHED);
  });

  it('applies the healthy updates even when a sibling in the batch failed', () => {
    // The regression: one rejection threw past the prune AND the cache write, so a finished job
    // kept its queue slot until reload. On a revert this reports no updates at all.
    const { updates } = resolvePollOutcomes(
      ['bad', 'done', 'running'],
      [failed(), ok('done', FINISHED), ok('running', RUNNING)]
    );

    expect(updates.map((u) => u.id)).toEqual(['done', 'running']);
  });

  it('stops polling a finished job and keeps polling a running one', () => {
    const { drop } = resolvePollOutcomes(
      ['done', 'running'],
      [ok('done', FINISHED), ok('running', RUNNING)]
    );

    expect([...drop]).toEqual(['done']);
  });

  it('stops polling a workflow the orchestrator no longer has', () => {
    // It resolves undefined rather than throwing, so `filter(isDefined)` dropped it before the
    // prune and it was re-requested every minute for the rest of the session.
    const { drop, updates } = resolvePollOutcomes(['vanished'], [gone()]);

    expect([...drop]).toEqual(['vanished']);
    expect(updates).toEqual([]);
  });

  it('gives up on NOT_FOUND but retries a transient failure', () => {
    const { drop } = resolvePollOutcomes(
      ['missing', 'blip', 'offline'],
      [failed('NOT_FOUND'), failed('INTERNAL_SERVER_ERROR'), failed()]
    );

    expect([...drop]).toEqual(['missing']);
  });
});
