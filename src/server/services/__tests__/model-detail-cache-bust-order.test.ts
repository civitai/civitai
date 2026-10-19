import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as CivitaiDb from '@civitai/db';

/**
 * With lag tracking on, a model write must finish setting the model's lag mark BEFORE it deletes the
 * cached row. A reader refilling the cache re-checks the mark after storing, so the mark landing
 * first is what lets a refill that raced the write find out and drop the old row it stored.
 *
 * The lag tracker is replaced by a recorder whose mark lands a few milliseconds late, as a real
 * round trip does, so a delete issued alongside the mark (rather than after it) shows up first.
 * `db-lag-helpers` builds its tracker when it loads, and the shared setup has already loaded it, so
 * each test loads it again.
 */

const MODEL_ID = 7711;
const events = vi.hoisted(() => [] as string[]);

vi.mock('@civitai/db', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiDb>()),
  createLagTracker: () => ({
    isStale: async () => false,
    markFresh: async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (key.endsWith(`:model:${MODEL_ID}`)) events.push('model-marked');
    },
  }),
}));

async function loadLagHelpers(): Promise<typeof DbLagHelpers> {
  vi.resetModules();
  return import('~/server/db/db-lag-helpers');
}

beforeEach(() => {
  events.length = 0;
  // The batch helpers skip the mark when lag tracking is off.
  envMock.set({ REPLICATION_LAG_DELAY: 10 });
  redisMock.redis.del.mockImplementation((async (keys: string | string[]) => {
    for (const key of [keys].flat())
      if (key.includes('model-detail-public')) events.push('row-deleted');
    return 1;
  }) as never);
});
afterEach(() => {
  envMock.reset();
  vi.resetModules();
});

describe('model write ordering with lag tracking on', () => {
  it.each([
    [
      'preventReplicationLag',
      (m: typeof DbLagHelpers) => m.preventReplicationLag('model', MODEL_ID),
    ],
    [
      'preventReplicationLagBatch',
      (m: typeof DbLagHelpers) => m.preventReplicationLagBatch('model', [MODEL_ID]),
    ],
    [
      'preventModelVersionLagBatch',
      (m: typeof DbLagHelpers) => m.preventModelVersionLagBatch(MODEL_ID, []),
    ],
  ])('%s sets the lag mark before deleting the cached row', async (_, write) => {
    await write(await loadLagHelpers());
    expect(events).toEqual(['model-marked', 'row-deleted']);
  });
});
