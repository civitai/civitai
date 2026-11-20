import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

const { preventReplicationLag, logSysRedisFailOpen } = vi.hoisted(() => ({
  preventReplicationLag: vi.fn(),
  logSysRedisFailOpen: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  preventReplicationLag,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen }));

const { rejudgeEntries } = await import('~/server/services/challenge-judge-review.service');
const { collectionItemLagId } = await import('~/server/db/db-lag-helpers');

const COLLECTION_ID = 10;
const JUDGED_ENTRIES = [11, 12];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce(JUDGED_ENTRIES.map((imageId) => ({ imageId })) as never)
    .mockResolvedValueOnce([] as never);
  dbMock.dbWrite.$transaction.mockResolvedValue([] as never);
  preventReplicationLag.mockResolvedValue(undefined);
});

const rejudge = () =>
  rejudgeEntries({ challengeId: 1, collectionId: COLLECTION_ID, judgeUserId: 2, judgedTagId: 3 });

describe('rejudgeEntries and the entries it clears', () => {
  it('flags each cleared entry as just written, so a re-save reads it from the primary', async () => {
    await rejudge();
    expect(preventReplicationLag.mock.calls).toEqual(
      JUDGED_ENTRIES.map((imageId) => [
        'collectionItem',
        collectionItemLagId(COLLECTION_ID, 'imageId', imageId),
      ])
    );
  });

  it('still clears the entries when the flag cannot be written', async () => {
    preventReplicationLag.mockRejectedValue(new Error('redis unavailable'));
    await expect(rejudge()).resolves.toEqual({ entries: 2, comments: 0 });
    expect(logSysRedisFailOpen).toHaveBeenCalledTimes(JUDGED_ENTRIES.length);
  });
});
