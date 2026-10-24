import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisCaches from '~/server/redis/caches';

const { mockCacheRefresh } = vi.hoisted(() => ({ mockCacheRefresh: vi.fn(async () => undefined) }));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  imageResourcesCache: { refresh: mockCacheRefresh },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { createImageResources } from '~/server/services/image.service';

type Row = {
  id: number;
  modelversionid: number | null;
  name: string | null;
  hash: string | null;
  strength: number | null;
  detected: boolean;
};

const row = (over: Partial<Row>): Row => ({
  id: 1,
  modelversionid: null,
  name: null,
  hash: null,
  strength: null,
  detected: true,
  ...over,
});

/** First $queryRaw is get_image_resources(); the second is the ImageResourceNew upsert. */
function givenDetected(rows: Row[], meta: Record<string, unknown>) {
  dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows).mockResolvedValue([]);
  dbMock.dbWrite.image.findUnique.mockResolvedValue({ meta } as never);
}

const metaWritten = () =>
  (dbMock.dbWrite.image.update.mock.calls[0][0] as { data: { meta: Record<string, any> } }).data
    .meta;

describe('createImageResources — unmatched resource meta', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a resource detected only via meta.hashes, which meta.resources cannot flag', async () => {
    givenDetected(
      [
        row({ name: 'Checkpoint', hash: 'aabbccddee', modelversionid: 7 }),
        row({ name: 'lycoris:local-lora', hash: '0123456789ab' }),
      ],
      { resources: [{ type: 'model', name: 'Checkpoint', hash: 'aabbccddee' }] }
    );

    await createImageResources({ imageId: 1 });

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    expect(metaWritten().unmatchedResources).toEqual([
      { hash: '0123456789ab', name: 'local-lora' },
    ]);
  });

  it('clears a flag that no longer holds, so the warning goes away after the model is uploaded', async () => {
    givenDetected([row({ name: 'now-published', hash: 'abcdef012345', modelversionid: 99 })], {
      resources: [{ type: 'lora', name: 'now-published', hash: 'abcdef012345', unmatched: true }],
    });

    await createImageResources({ imageId: 1 });

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    const meta = metaWritten();
    expect(meta.resources[0].unmatched).toBe(false);
    expect(meta.unmatchedResources).toEqual([]);
  });

  it('clears a stored list once nothing is unmatched, even though no flag has to flip', async () => {
    // The case the removed `unmatchedHashes.size > 0` guard skipped: no flag flips, but the stored
    // list still has to be cleared.
    givenDetected([row({ name: 'now-published', hash: 'abcdef012345', modelversionid: 99 })], {
      resources: [{ type: 'lora', name: 'now-published', hash: 'abcdef012345' }],
      unmatchedResources: [{ hash: 'abcdef012345', name: 'now-published' }],
    });

    await createImageResources({ imageId: 1 });

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    expect(metaWritten().unmatchedResources).toEqual([]);
  });

  it('writes nothing when the stored meta already matches', async () => {
    givenDetected([row({ name: 'lycoris:local-lora', hash: '0123456789ab' })], {
      resources: [],
      unmatchedResources: [{ hash: '0123456789ab', name: 'local-lora' }],
    });

    await createImageResources({ imageId: 1 });

    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('writes nothing for a fully matched image that never had the field', async () => {
    givenDetected([row({ name: 'Checkpoint', hash: 'aabbccddee', modelversionid: 7 })], {
      resources: [{ type: 'model', name: 'Checkpoint', hash: 'aabbccddee' }],
    });

    await createImageResources({ imageId: 1 });

    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });
});
