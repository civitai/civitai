import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CoverVisibility from '~/server/services/collection-cover-visibility';
import type * as DbLag from '~/server/db/db-lag-helpers';

// Image rows that reach a non-moderator's response carry only the fields the caller uses: the
// Image fakes below answer like Prisma, a full row without a `select` and only its keys with one.

vi.mock('~/server/services/collection-cover-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverVisibility>()),
  getServableCoverCollectionIds: async (covers: { collectionId: number }[]) =>
    new Set(covers.map((c) => c.collectionId)),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => {
  const { dbMock } = await import('~/__tests__/mocks/db.mock');
  return {
    ...(await importOriginal<typeof DbLag>()),
    getDbWithoutLag: async () => dbMock.dbRead,
  };
});

const { getUserCollectionsWithPermissions } = await import('~/server/services/collection.service');
const { updateImageAcceptableMinor } = await import('~/server/services/image.service');

const IMAGE = {
  id: 7,
  url: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee7',
  type: 'image',
  userId: 99,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  acceptableMinor: false,
  poi: true,
  minor: true,
  tosViolation: true,
  scanJobs: { workflowId: 'wf', lastFailure: { reason: 'x' } },
  pHash: BigInt(1),
};

const pick = (row: Record<string, unknown>, select?: Record<string, unknown>) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;

beforeEach(() => {
  dbMock.dbRead.image.findMany.mockImplementation((async (args: {
    select?: Record<string, unknown>;
  }) => [pick(IMAGE, args?.select)]) as never);
  dbMock.dbWrite.image.update.mockImplementation((async (args: {
    select?: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => pick({ ...IMAGE, ...args.data }, args.select)) as never);
});

describe('image rows returned to non-moderators', () => {
  it("a collection's cover image keeps the cover gate flags and carries no scanJobs", async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([
      { id: 1, name: 'c', userId: 5, imageId: IMAGE.id, read: 'Public', write: 'Public' },
    ] as never);

    const [collection] = await getUserCollectionsWithPermissions({
      input: { userId: 1, permissions: [] } as never,
    });

    expect(collection.image).toMatchObject({
      id: IMAGE.id,
      // The blocks collections route gates covers on these.
      poi: true,
      minor: true,
      acceptableMinor: false,
      tosViolation: true,
    });
    expect(collection.image).not.toHaveProperty('scanJobs');
  });

  it('the acceptable-minor update returns no scanJobs', async () => {
    const image = await updateImageAcceptableMinor({
      csamReview: true,
      isModerator: true,
      id: IMAGE.id,
      collectionId: 1,
      acceptableMinor: true,
    });

    expect(image).toMatchObject({ id: IMAGE.id, acceptableMinor: true });
    expect(image).not.toHaveProperty('scanJobs');
  });
});
