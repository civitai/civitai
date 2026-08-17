import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Eligibility from '~/server/jobs/refresh-featured-collections-eligibility';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';

const SYSTEM_BLOCK_ID = 388990;

const systemBlock = { id: SYSTEM_BLOCK_ID, metadata: {} as HomeBlockMetaSchema };
const homeBlockUpdate = dbMock.dbWrite.homeBlock.update;

dbMock.dbRead.collection.findUnique.mockImplementation(async () => ({
  id: 555,
  name: 'Val’s Picks',
  write: 'Private',
}));
dbMock.dbWrite.homeBlock.findFirst.mockImplementation(async () => systemBlock);

vi.mock('~/server/jobs/refresh-featured-collections-eligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof Eligibility>()),
  computeFeaturedCollectionsState: vi.fn(),
}));

const {
  addCollectionToFeaturedPool,
  removeCollectionFromFeaturedPool,
  acknowledgeFeaturedCollection,
} = await import('~/server/services/home-block.service');

const autoFeature = {
  collectionId: 107,
  dryRun: false,
  perRun: 5,
  intervalHours: 6,
} as NonNullable<NonNullable<HomeBlockMetaSchema['featuredCollections']>['autoFeature']>;

const writtenPool = () => {
  expect(homeBlockUpdate).toHaveBeenCalledTimes(1);
  const metadata = homeBlockUpdate.mock.calls[0][0].data.metadata as HomeBlockMetaSchema;
  return metadata.featuredCollections;
};

beforeEach(() => {
  homeBlockUpdate.mockClear();
  systemBlock.metadata = {
    title: 'Featured Collections',
    featuredCollections: {
      collectionIds: [111, 222],
      limit: 40,
      rows: 2,
      renderCount: 3,
      nameSnapshots: { '111': 'One', '222': 'Two' },
      writeSnapshots: { '111': 'Private', '222': 'Private' },
      autoFeature,
    },
  } as HomeBlockMetaSchema;
});

describe('featured pool edits preserve fields they do not manage', () => {
  it('keeps autoFeature when a collection is added', async () => {
    await addCollectionToFeaturedPool({ collectionId: 555 });
    const pool = writtenPool();
    expect(pool?.collectionIds).toEqual([111, 222, 555]);
    expect(pool?.autoFeature).toEqual(autoFeature);
  });

  it('keeps autoFeature when a collection is removed', async () => {
    await removeCollectionFromFeaturedPool({ collectionId: 222 });
    const pool = writtenPool();
    expect(pool?.collectionIds).toEqual([111]);
    expect(pool?.autoFeature).toEqual(autoFeature);
  });

  it('keeps autoFeature when a collection is acknowledged', async () => {
    await acknowledgeFeaturedCollection({ collectionId: 555 });
    expect(writtenPool()?.autoFeature).toEqual(autoFeature);
  });

  // The bug was field-by-field reconstruction, so pinning autoFeature alone would leave the next
  // field added here in exactly the same position. This fails for any key that is dropped.
  it('carries every stored key through a pool edit', async () => {
    const before = Object.keys(systemBlock.metadata.featuredCollections ?? {}).sort();
    await addCollectionToFeaturedPool({ collectionId: 555 });
    expect(Object.keys(writtenPool() ?? {}).sort()).toEqual(expect.arrayContaining(before));
  });
});
