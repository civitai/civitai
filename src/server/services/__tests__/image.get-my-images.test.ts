import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { NsfwLevel } from '~/server/common/enums';
import { MediaType } from '~/shared/utils/prisma/enums';

const { getIsImageBlocked } = vi.hoisted(() => ({
  getIsImageBlocked: vi.fn<(hash: bigint) => Promise<boolean>>(),
}));
vi.mock('~/server/services/blocked-image-hash', () => ({ getIsImageBlocked }));

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

  const holdCheck = dbMock.dbWrite.$queryRaw;
  const blockedHashes = getIsImageBlocked;

  beforeEach(() => {
    findMany.mockImplementation(async ({ where }) =>
      where.ingestion === 'Error' ? [failedUpload] : [listed]
    );
    holdCheck.mockReset();
    holdCheck.mockResolvedValue([{ held: false }] as never);
    blockedHashes.mockReset();
    blockedHashes.mockResolvedValue(false);
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
    expect(findMany).toHaveBeenCalledTimes(1);
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
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('leaves other published-only callers without failed uploads', async () => {
    await getMyImages({
      userId: 42,
      mediaTypes: [MediaType.image],
      limit: 10,
      publishedOnly: true,
    });
    expect(errorQueryOf()).toBeUndefined();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('checks the hold of the caller, and only lists failed uploads the caller owns', async () => {
    await listForEntry();
    expect(holdCheck).toHaveBeenCalledTimes(1);
    const boundValues = (holdCheck.mock.calls[0].slice(1) as { values?: unknown[] }[]).flatMap(
      (value) => value.values ?? [value]
    );
    expect(boundValues).toContain(42);
    // The statement as Postgres gets it: the owner the hold SQL reads is the caller.
    const [strings, ...values] = holdCheck.mock.calls[0] as unknown as [string[], ...unknown[]];
    const statement = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    expect(statement.sql).toMatch(/FROM \(SELECT \?::int AS "userId"\) m$/);
    expect(statement.sql).toContain('m."userId"');
    expect(statement.values.filter((value) => value === 42)).toEqual([42]);
    for (const [args] of findMany.mock.calls) expect(args.where.userId).toBe(42);
  });

  it('lists none for an owner whose content is held', async () => {
    holdCheck.mockResolvedValue([{ held: true }] as never);
    const { items } = await listForEntry();
    expect(items.map((x) => x.id)).toEqual([800]);
    expect(errorQueryOf()).toBeUndefined();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('lists none when the hold cannot be read', async () => {
    holdCheck.mockRejectedValue(new Error('replica down'));
    const { items } = await listForEntry();
    expect(items.map((x) => x.id)).toEqual([800]);
  });

  it('leaves out a failed upload that a block reason was written on', async () => {
    const rows = [
      { id: 904, ingestion: 'Error', blockedFor: 'reason' },
      { id: 905, ingestion: 'Error', blockedFor: null },
    ];
    findMany.mockImplementation(async ({ where }) =>
      where.ingestion === 'Error'
        ? rows
            .filter((row) => !('blockedFor' in where) || row.blockedFor === where.blockedFor)
            .map(({ blockedFor: _blockedFor, ...row }) => row)
        : [listed]
    );
    const { items } = await listForEntry();
    expect(items.map((x) => x.id)).toEqual([905, 800]);
  });

  it('leaves out a failed upload rated Blocked, even with no block reason written', async () => {
    await listForEntry();
    expect(errorQueryOf()?.where).toMatchObject({ nsfwLevel: { not: NsfwLevel.Blocked } });
  });

  it('pages by the main listing alone: failed uploads never move the cursor', async () => {
    findMany.mockImplementation(async ({ where }) =>
      where.ingestion === 'Error'
        ? [
            { id: 950, ingestion: 'Error' },
            { id: 10, ingestion: 'Error' },
          ]
        : [{ id: 900 }, { id: 800 }, { id: 700 }]
    );
    const { items, nextCursor } = await getMyImages({
      userId: 42,
      mediaTypes: [MediaType.video],
      limit: 2,
      publishedOnly: true,
      includeEntryDrafts: true,
    });
    expect(nextCursor).toBe(700);
    expect(items.map((x) => x.id)).toEqual([950, 900, 800, 10]);
  });

  it('leaves out a failed upload on a blocked hash, and never returns the hash', async () => {
    findMany.mockImplementation(async ({ where }) =>
      where.ingestion === 'Error'
        ? [
            { id: 901, ingestion: 'Error', pHash: BigInt(7) },
            { id: 902, ingestion: 'Error', pHash: BigInt(8) },
            { id: 903, ingestion: 'Error', pHash: null },
          ]
        : [listed]
    );
    blockedHashes.mockImplementation(async (hash) => hash === BigInt(7));
    const { items } = await listForEntry();
    expect(items.map((x) => x.id)).toEqual([903, 902, 800]);
    expect(blockedHashes.mock.calls.map(([hash]) => hash)).toEqual([BigInt(7), BigInt(8)]);
    for (const item of items) expect(item).not.toHaveProperty('pHash');
  });

  it('lists none when the blocked-hash lookup fails', async () => {
    findMany.mockImplementation(async ({ where }) =>
      where.ingestion === 'Error' ? [{ id: 901, ingestion: 'Error', pHash: BigInt(7) }] : [listed]
    );
    blockedHashes.mockRejectedValue(new Error('timeout'));
    const { items } = await listForEntry();
    expect(items.map((x) => x.id)).toEqual([800]);
  });
});
