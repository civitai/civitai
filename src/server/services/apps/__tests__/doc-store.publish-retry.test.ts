import { describe, expect, it } from 'vitest';
import { retryOnDeadlock } from '~/server/services/apps/doc-store';
import { DocStoreError } from '~/server/services/apps/doc-store.types';

/**
 * `retryOnDeadlock`, which re-runs a whole publish or unpublish transaction Postgres aborted as a
 * deadlock (40P01). The interleaving that produces one (a third writer committing a key between
 * two publishes' lock reads) is not forced here; this pins the wrapper.
 */

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

describe('retryOnDeadlock', () => {
  it('re-runs the transaction after a deadlock and returns its result', async () => {
    let calls = 0;
    const out = await retryOnDeadlock(async () => {
      calls += 1;
      if (calls < 3) throw deadlock();
      return 'landed';
    });
    expect([out, calls]).toEqual(['landed', 3]);
  });

  it('gives up after two retries with the retryable contention refusal', async () => {
    let calls = 0;
    const err = await retryOnDeadlock(async () => {
      calls += 1;
      throw deadlock();
    }).catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(DocStoreError);
    expect([(err as DocStoreError).code, (err as DocStoreError).details]).toEqual([
      'rate_limited',
      { reason: 'contention', retryAfter: 1 },
    ]);
  });

  it('does not retry any other error', async () => {
    let calls = 0;
    const boom = Object.assign(new Error('serialization'), { code: '40001' });
    const err = await retryOnDeadlock(async () => {
      calls += 1;
      throw boom;
    }).catch((e: unknown) => e);
    expect([err, calls]).toEqual([boom, 1]);
  });
});
