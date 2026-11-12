import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hidden preferences are a user-safety setting: what a user hid must stay hidden when the cache
 * that normally serves the list is unavailable. A per-user hash read that rejects, or one that was
 * sent and never answered, must answer from the database — the source of truth — so the image the
 * user hid is still in the hidden list, and the answer arrives within the cache-read deadline
 * rather than after the client's 15s backstop.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';

const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

const HIDDEN_IMAGE_ID = 9137;
const HIDDEN_MODEL_ID = 4211;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([{ imageId: HIDDEN_IMAGE_ID }]);
  dbMock.dbRead.modelEngagement.findMany.mockResolvedValue([{ modelId: HIDDEN_MODEL_ID }]);
});

describe('getAllHiddenForUser with the cache unavailable', () => {
  it('a rejecting hash read answers from the database: the hidden image stays hidden', async () => {
    redisMock.redis.packed.hGetAll.mockRejectedValue(new Error('cluster down'));

    const result = await within(getAllHiddenForUser({ userId: 77 }), 2000);

    expect(result).not.toBe(HUNG);
    const prefs = result as Awaited<ReturnType<typeof getAllHiddenForUser>>;
    expect(prefs.hiddenImages).toContainEqual({ id: HIDDEN_IMAGE_ID, hidden: true });
    expect(prefs.hiddenModels).toContainEqual({ id: HIDDEN_MODEL_ID, hidden: true });
  });

  it('a hash read that never answers resolves from the database within 750ms', async () => {
    redisMock.redis.packed.hGetAll.mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const result = await within(getAllHiddenForUser({ userId: 78 }), 2000);
    const elapsed = Date.now() - started;

    expect(result).not.toBe(HUNG);
    const prefs = result as Awaited<ReturnType<typeof getAllHiddenForUser>>;
    expect(prefs.hiddenImages).toContainEqual({ id: HIDDEN_IMAGE_ID, hidden: true });
    expect(elapsed).toBeLessThan(750);
  });

  it('a cache write that never answers does not hold the answer either', async () => {
    // Read misses (the default), the database answers, and the write-back parks.
    redisMock.redis.packed.hSet.mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const result = await within(getAllHiddenForUser({ userId: 79 }), 2000);

    expect(result).not.toBe(HUNG);
    expect(Date.now() - started).toBeLessThan(750);
    const prefs = result as Awaited<ReturnType<typeof getAllHiddenForUser>>;
    expect(prefs.hiddenImages).toContainEqual({ id: HIDDEN_IMAGE_ID, hidden: true });
  });
});
