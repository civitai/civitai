import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { MediaType } from '~/shared/utils/prisma/enums';

const findMany = dbMock.dbRead.image.findMany;
const { getMyImages } = await import('~/server/services/image-detail.service');

const whereOf = () => findMany.mock.calls[0][0].where;

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe('getMyImages — published only', () => {
  it('lists published media only, by default', async () => {
    await getMyImages({
      userId: 42,
      mediaTypes: [MediaType.image],
      limit: 10,
      publishedOnly: true,
    });

    expect(whereOf()).toMatchObject({
      userId: 42,
      post: { publishedAt: { lte: expect.any(Date) } },
    });
    expect(whereOf().OR).toBeUndefined();
  });

  it("also lists unpublished media from the crucible entry modal's drafts, still only the caller's own", async () => {
    await getMyImages({
      userId: 42,
      mediaTypes: [MediaType.image],
      limit: 10,
      publishedOnly: true,
      includeEntryDrafts: true,
    });

    const where = whereOf();
    expect(where.userId).toBe(42);
    // One relation filter, not an OR of two: a top-level OR keeps Postgres from semi-joining Post.
    expect(where.OR).toBeUndefined();
    expect(where).toMatchObject({
      needsReview: null,
      tosViolation: false,
      post: {
        OR: [
          { publishedAt: { lte: expect.any(Date) } },
          { publishedAt: null, metadata: { path: ['crucibleEntryDraft'], equals: true } },
        ],
      },
    });
  });
});
