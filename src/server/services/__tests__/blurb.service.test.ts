import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createBlurb,
  getBlurbsForUser,
  MAX_BLURBS_PER_USER,
  softDeleteBlurb,
  updateBlurbContent,
} from '~/server/services/blurb.service';

const p2002 = (target: string[] | string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '1',
    meta: { target },
  });

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
    const promise = createBlurb({ userId: 10, name: 'x', content: 'y' });
    // The value, not just the shape — `/limit of 20/` also matches "limit of 200".
    await expect(promise).rejects.toThrow(
      new RegExp(`limit of ${MAX_BLURBS_PER_USER} snippets`, 'i')
    );
    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDbWrite.blurb.create).not.toHaveBeenCalled();
  });

  it('does not count soft-deleted blurbs toward the cap', async () => {
    await createBlurb({ userId: 10, name: 'x', content: 'y' });
    expect(mockDbWrite.blurb.count).toHaveBeenCalledWith({
      where: { userId: 10, deletedAt: null },
    });
  });

  it('turns a duplicate name into a friendly conflict, not the raw Prisma text', async () => {
    mockDbWrite.blurb.create.mockRejectedValue(p2002(['userId', 'name']));
    const promise = createBlurb({ userId: 10, name: 'footer', content: 'y' });
    await expect(promise).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(promise).rejects.toThrow(/already have a snippet named "footer"/i);
  });

  it('turns the raw partial-index name into the same conflict', async () => {
    // The index carries a WHERE clause, so it is not declared in schema.prisma and Prisma reports
    // the index NAME rather than the field list. Match only the array shape and every duplicate
    // name surfaces as a raw Prisma error instead.
    mockDbWrite.blurb.create.mockRejectedValue(p2002('Blurb_userId_name_key'));
    const promise = createBlurb({ userId: 10, name: 'footer', content: 'y' });
    await expect(promise).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(promise).rejects.toThrow(/already have a snippet named "footer"/i);
  });

  it('leaves an unrelated unique violation to surface as-is', async () => {
    const error = p2002(['id']);
    mockDbWrite.blurb.create.mockRejectedValue(error);
    await expect(createBlurb({ userId: 10, name: 'footer', content: 'y' })).rejects.toBe(error);
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
    const promise = updateBlurbContent({ userId: 99, id: 1, content: 'x' });
    await expect(promise).rejects.toThrow(/not found/i);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
    const promise = softDeleteBlurb({ userId: 99, id: 1 });
    await expect(promise).rejects.toThrow(/not found/i);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
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

  // The manager shows no usage counts, so nothing aggregates BlurbReference on this path. The
  // rows still exist and the fan-out still reads them — this pins only that opening the manager
  // does not pay for a groupBy nobody looks at.
  it('🔴 does not query references at all', async () => {
    mockDbRead.blurb.findMany.mockResolvedValue([{ id: 1, userId: 10, name: 'footer' }]);

    const [blurb] = await getBlurbsForUser(10);

    expect(blurb.name).toBe('footer');
    expect(mockDbRead.blurbReference.groupBy).not.toHaveBeenCalled();
    expect(mockDbRead.blurbReference.findMany).not.toHaveBeenCalled();
  });
});

describe('blocked link domains', () => {
  const blockedHtml = '<a href="https://blocked.example/x">x</a>';

  beforeEach(() => {
    // The real guard, reading a seeded blocklist row — a blurb body is spliced into
    // entities whose own domain check already ran, so it has to be caught on this write.
    dbMock.dbWrite.blocklist.findMany.mockResolvedValue([
      { id: 1, type: 'LinkDomain', data: ['blocked.example'] },
    ]);
  });

  it('refuses to create a blurb carrying a blocked domain', async () => {
    await expect(createBlurb({ userId: 1, name: 'footer', content: blockedHtml })).rejects.toThrow(
      /blocked\.example/
    );

    expect(dbMock.dbWrite.blurb.create).not.toHaveBeenCalled();
  });

  it('refuses to update a blurb to a blocked domain', async () => {
    await expect(updateBlurbContent({ userId: 1, id: 2, content: blockedHtml })).rejects.toThrow(
      /blocked\.example/
    );

    expect(dbMock.dbWrite.blurb.update).not.toHaveBeenCalled();
  });
});
