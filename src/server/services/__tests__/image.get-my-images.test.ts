import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { MediaType } from '~/shared/utils/prisma/enums';

const findMany = dbMock.dbRead.image.findMany;
const { getMyImages } = await import('~/server/services/image.service');

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

describe('getMyImages — entry drafts whose scan failed', () => {
  const failedUpload = { id: 900, ingestion: 'Error' };
  const listed = { id: 800, ingestion: 'Scanned' };
  const errorQueryOf = () =>
    findMany.mock.calls.map(([args]) => args).find((args) => args.where.ingestion === 'Error');

  beforeEach(() => {
    findMany.mockImplementation(async ({ where }) =>
      where.ingestion === 'Error' ? [failedUpload] : [listed]
    );
  });

  const listForEntry = (cursor?: number) =>
    getMyImages({
      userId: 42,
      mediaTypes: [MediaType.video],
      limit: 10,
      publishedOnly: true,
      includeEntryDrafts: true,
      cursor,
    });

  it('lists an upload whose scan failed, newest first, so the modal can say so', async () => {
    const { items } = await listForEntry();
    expect(items.map((x) => x.id)).toEqual([900, 800]);
    expect(items[0].ingestion).toBe('Error');
  });

  it("only from the caller's own unpublished entry-draft posts, not a failed image on a normal post", async () => {
    await listForEntry();
    expect(errorQueryOf()?.where).toMatchObject({
      userId: 42,
      type: { in: [MediaType.video] },
      needsReview: null,
      tosViolation: false,
      post: { publishedAt: null, metadata: { path: ['crucibleEntryDraft'], equals: true } },
      createdAt: { gte: expect.any(Date) },
    });
    const since = errorQueryOf()!.where.createdAt.gte as Date;
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });

  it('adds them to the first page only, so paging never repeats one', async () => {
    const { items } = await listForEntry(800);
    expect(items.map((x) => x.id)).toEqual([800]);
    expect(errorQueryOf()).toBeUndefined();
  });

  it('leaves callers that list unpublished media too without them', async () => {
    await getMyImages({
      userId: 42,
      mediaTypes: [MediaType.image],
      limit: 10,
      publishedOnly: false,
      includeEntryDrafts: true,
    });
    expect(errorQueryOf()).toBeUndefined();
  });

  it('leaves other published-only callers without failed uploads', async () => {
    await getMyImages({
      userId: 42,
      mediaTypes: [MediaType.image],
      limit: 10,
      publishedOnly: true,
    });
    expect(errorQueryOf()).toBeUndefined();
  });
});
