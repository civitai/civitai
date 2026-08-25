import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createBlurb,
  getBlurbsForUser,
  MAX_BLURBS_PER_USER,
  softDeleteBlurb,
  updateBlurbContent,
} from '~/server/services/blurb.service';

const mockDbWrite = dbMock.dbWrite;
const mockDbRead = dbMock.dbRead;

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.blurb.count.mockResolvedValue(0);
  mockDbWrite.blurb.create.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
  mockDbWrite.blurb.findFirst.mockResolvedValue({ id: 1, userId: 10, content: 'old' });
  mockDbWrite.blurb.update.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
  mockDbRead.blurb.findMany.mockResolvedValue([]);
  mockDbRead.blurbReference.groupBy.mockResolvedValue([]);
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
    mockDbWrite.blurb.count.mockResolvedValue(MAX_BLURBS_PER_USER);
    await expect(createBlurb({ userId: 10, name: 'x', content: 'y' })).rejects.toThrow(
      /limit of 20/i
    );
    expect(mockDbWrite.blurb.create).not.toHaveBeenCalled();
  });

  it('does not count soft-deleted blurbs toward the cap', async () => {
    await createBlurb({ userId: 10, name: 'x', content: 'y' });
    expect(mockDbWrite.blurb.count).toHaveBeenCalledWith({
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
    const data = mockDbWrite.blurb.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('name');
  });

  it('scopes the lookup to the caller and the blurb id', async () => {
    await updateBlurbContent({ userId: 10, id: 1, content: 'x' });
    expect(mockDbWrite.blurb.findFirst).toHaveBeenCalledWith({
      where: { id: 1, userId: 10, deletedAt: null },
    });
  });

  it('refuses a blurb belonging to someone else', async () => {
    mockDbWrite.blurb.findFirst.mockResolvedValue(null);
    await expect(updateBlurbContent({ userId: 99, id: 1, content: 'x' })).rejects.toThrow(
      /not found/i
    );
  });
});

describe('softDeleteBlurb', () => {
  it('sets deletedAt instead of deleting the row', async () => {
    await softDeleteBlurb({ userId: 10, id: 1 });
    const call = mockDbWrite.blurb.update.mock.calls[0][0];
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it('scopes the lookup to the caller and the blurb id', async () => {
    await softDeleteBlurb({ userId: 10, id: 1 });
    expect(mockDbWrite.blurb.findFirst).toHaveBeenCalledWith({
      where: { id: 1, userId: 10, deletedAt: null },
    });
  });

  it('refuses a blurb belonging to someone else', async () => {
    mockDbWrite.blurb.findFirst.mockResolvedValue(null);
    await expect(softDeleteBlurb({ userId: 99, id: 1 })).rejects.toThrow(/not found/i);
    expect(mockDbWrite.blurb.update).not.toHaveBeenCalled();
  });
});

describe('getBlurbsForUser', () => {
  it('scopes the list to the caller and excludes soft-deleted blurbs', async () => {
    await getBlurbsForUser(10);
    expect(mockDbRead.blurb.findMany).toHaveBeenCalledWith({
      where: { userId: 10, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  });

  it('groups references by blurb and entity type in one query, folded into a per-entityType breakdown and a summed referenceCount', async () => {
    mockDbRead.blurb.findMany.mockResolvedValue([{ id: 1, userId: 10, name: 'footer' }]);
    mockDbRead.blurbReference.groupBy.mockResolvedValue([
      { blurbId: 1, entityType: 'model', _count: { _all: 38 } },
      { blurbId: 1, entityType: 'article', _count: { _all: 2 } },
      { blurbId: 1, entityType: 'bounty', _count: { _all: 1 } },
    ]);

    const [blurb] = await getBlurbsForUser(10);

    expect(blurb.referenceCount).toBe(41);
    expect(blurb.referencesByEntityType).toEqual({ model: 38, article: 2, bounty: 1 });
    expect(mockDbRead.blurbReference.groupBy).toHaveBeenCalledTimes(1);
    expect(mockDbRead.blurbReference.groupBy).toHaveBeenCalledWith({
      by: ['blurbId', 'entityType'],
      where: { blurbId: { in: [1] } },
      _count: { _all: true },
    });
  });
});
