import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbWrite = {
  blurb: {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  blurbReference: {
    groupBy: vi.fn(),
  },
};

vi.mock('~/server/db/client', () => ({ dbWrite, dbRead: dbWrite }));

const {
  createBlurb,
  updateBlurbContent,
  softDeleteBlurb,
  getBlurbsForUser,
  MAX_BLURBS_PER_USER,
} = await import('~/server/services/blurb.service');

beforeEach(() => {
  vi.clearAllMocks();
  dbWrite.blurb.count.mockResolvedValue(0);
  dbWrite.blurb.create.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
  dbWrite.blurb.findFirst.mockResolvedValue({ id: 1, userId: 10, content: 'old' });
  dbWrite.blurb.findMany.mockResolvedValue([]);
  dbWrite.blurb.update.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
  dbWrite.blurbReference.groupBy.mockResolvedValue([]);
});

describe('createBlurb', () => {
  it('stores a sha256 of the content', async () => {
    const blurb = await createBlurb({ userId: 10, name: 'footer', content: 'hello' });
    // sha256('hello')
    expect(blurb.contentHash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('refuses past the per-creator cap', async () => {
    dbWrite.blurb.count.mockResolvedValue(MAX_BLURBS_PER_USER);
    await expect(createBlurb({ userId: 10, name: 'x', content: 'y' })).rejects.toThrow(
      /limit of 20/i
    );
    expect(dbWrite.blurb.create).not.toHaveBeenCalled();
  });

  it('does not count soft-deleted blurbs toward the cap', async () => {
    await createBlurb({ userId: 10, name: 'x', content: 'y' });
    expect(dbWrite.blurb.count).toHaveBeenCalledWith({
      where: { userId: 10, deletedAt: null },
    });
  });
});

describe('updateBlurbContent', () => {
  it('recomputes the hash', async () => {
    const blurb = await updateBlurbContent({ userId: 10, id: 1, content: 'hello' });
    expect(blurb.contentHash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('never writes name', async () => {
    await updateBlurbContent({ userId: 10, id: 1, content: 'x' });
    const data = dbWrite.blurb.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('name');
  });

  it('refuses a blurb belonging to someone else', async () => {
    dbWrite.blurb.findFirst.mockResolvedValue(null);
    await expect(updateBlurbContent({ userId: 99, id: 1, content: 'x' })).rejects.toThrow(
      /not found/i
    );
  });
});

describe('softDeleteBlurb', () => {
  it('sets deletedAt instead of deleting the row', async () => {
    await softDeleteBlurb({ userId: 10, id: 1 });
    const call = dbWrite.blurb.update.mock.calls[0][0];
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });
});

describe('getBlurbsForUser', () => {
  it('folds the groupBy rows into a per-entityType breakdown and a summed referenceCount', async () => {
    dbWrite.blurb.findMany.mockResolvedValue([{ id: 1, userId: 10, name: 'footer' }]);
    dbWrite.blurbReference.groupBy.mockResolvedValue([
      { blurbId: 1, entityType: 'model', _count: { _all: 38 } },
      { blurbId: 1, entityType: 'article', _count: { _all: 2 } },
      { blurbId: 1, entityType: 'bounty', _count: { _all: 1 } },
    ]);

    const [blurb] = await getBlurbsForUser(10);

    expect(blurb.referenceCount).toBe(41);
    expect(blurb.referencesByEntityType).toEqual({ model: 38, article: 2, bounty: 1 });
    expect(dbWrite.blurbReference.groupBy).toHaveBeenCalledTimes(1);
  });
});
