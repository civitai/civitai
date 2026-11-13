import { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Unit tests for upsertArticle's lockedProperties enforcement — locks are read from the
// stored row, never from the client payload. article.service.ts has a large import graph,
// so its transitive service/db/search dependencies are stubbed out below.

// The old fixture spread its `tx` into `dbWrite`, so a model reached through the transaction and
// the same model reached directly were one object. The canonical `$transaction` default runs the
// callback against `dbMock.dbWrite`, which keeps that identity.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));

// upsertArticle's UPDATE path does post-commit work that reaches Redis: the
// count-cache refresh and the replication-lag markers. With no live Redis these
// awaits never settle and the tests hang. Stub the Redis-backed helpers so the
// tests exercise the lockedProperties enforcement (which happens before commit)
// instead of blocking on infra. `importOriginal` keeps every other export real
// so the rest of the large import graph is untouched.
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/db/db-lag-helpers')>()),
  preventReplicationLag: vi.fn(async () => {}),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/redis/caches')>();
  return {
    ...actual,
    userArticleCountCache: { ...actual.userArticleCountCache, refresh: vi.fn(async () => {}) },
  };
});

import { upsertArticle } from '~/server/services/article.service';

const ARTICLE_ID = 21;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

function mockStored({
  lockedProperties = [] as string[],
  userId = OWNER_ID,
  userNsfwLevel = 1,
  status = 'Draft',
}: {
  lockedProperties?: string[];
  userId?: number;
  userNsfwLevel?: number;
  status?: string;
} = {}) {
  const row = {
    id: ARTICLE_ID,
    title: 'Stored title',
    cover: null,
    coverId: null,
    userId,
    publishedAt: null,
    status,
    nsfwLevel: 1,
    userNsfwLevel,
    moderatorNsfwLevel: null,
    lockedProperties,
    metadata: {},
    content: 'stored content',
  };
  // Post-commit passes re-read the article through both clients.
  mockDbWrite.article.findUnique.mockResolvedValue(row);
  mockDbRead.article.findUnique.mockResolvedValue(row);
  mockDbWrite.article.findFirst.mockResolvedValue(row);
}

// The FIRST article.update is the form write from the transaction — the one these
// assertions are about, and not necessarily the last one recorded.
function updateData() {
  // Without this, `?? {}` makes every `not.toHaveProperty` below pass on zero writes.
  expect(mockDbWrite.article.update).toHaveBeenCalled();
  return mockDbWrite.article.update.mock.calls[0]?.[0]?.data ?? {};
}

const upsert = (input: Record<string, unknown>) =>
  upsertArticle({
    id: ARTICLE_ID,
    userId: OWNER_ID,
    title: 'A title',
    content: 'Some content',
    status: 'Draft',
    ...input,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockStored();
  mockDbWrite.article.update.mockResolvedValue({ id: ARTICLE_ID, userId: OWNER_ID, tags: [] });
  mockDbWrite.imageConnection.findMany.mockResolvedValue([]);
  mockDbWrite.image.findMany.mockResolvedValue([]);
  mockDbRead.image.findMany.mockResolvedValue([]);
});

describe('upsertArticle — non-moderator lock enforcement', () => {
  it('strips a DB-locked field even when the client claims no locks', async () => {
    mockStored({ lockedProperties: ['userNsfwLevel'] });

    await upsert({ userNsfwLevel: 8, lockedProperties: [] });

    expect(updateData()).not.toHaveProperty('userNsfwLevel');
  });

  it('never lets a non-moderator write lockedProperties — the stored locks must survive', async () => {
    mockStored({ lockedProperties: ['userNsfwLevel'] });

    await upsert({ userNsfwLevel: 8, lockedProperties: [] });

    expect(updateData()).not.toHaveProperty('lockedProperties');
  });

  it('ignores locks the client claims — only the stored row decides what is locked', async () => {
    await upsert({ userNsfwLevel: 8, lockedProperties: ['userNsfwLevel'] });

    const data = updateData();
    expect(data.userNsfwLevel).toBe(8);
    expect(data).not.toHaveProperty('lockedProperties');
  });

  it('reads the stored locks from the DB row', async () => {
    await upsert({});

    expect(mockDbWrite.article.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ lockedProperties: true }) })
    );
  });
});

describe('upsertArticle — moderator', () => {
  it('can write lockedProperties and the locked values themselves', async () => {
    mockStored({ lockedProperties: ['userNsfwLevel'] });

    await upsert({
      userId: MODERATOR_ID,
      isModerator: true,
      userNsfwLevel: 8,
      lockedProperties: ['userNsfwLevel', 'nsfw'],
    });

    const data = updateData();
    expect(data.userNsfwLevel).toBe(8);
    expect(data.lockedProperties).toEqual(['userNsfwLevel', 'nsfw']);
  });
});

describe('upsertArticle — status while unpublished for a violation', () => {
  const MESSAGE = /unpublished for violating Terms of Service/;

  beforeEach(() => mockStored({ status: 'UnpublishedViolation' }));

  it.each(['Draft', 'Unpublished', 'Processing', 'Published'])(
    'refuses an owner moving the article to %s without writing',
    async (status) => {
      await expect(upsert({ status })).rejects.toThrow(MESSAGE);

      expect(mockDbWrite.article.update).not.toHaveBeenCalled();
    }
  );

  it('still saves content edits when the owner replays the stored status', async () => {
    await upsert({ status: 'UnpublishedViolation', content: 'edited' });

    expect(updateData().content).toBe('edited');
  });

  it('still saves content edits when the owner omits the status', async () => {
    await upsert({ status: undefined, content: 'edited' });

    expect(updateData().content).toBe('edited');
  });

  it.each(['Published', 'Draft'])('lets a moderator move the article to %s', async (status) => {
    await upsert({ userId: MODERATOR_ID, isModerator: true, status });

    expect(mockDbWrite.article.update).toHaveBeenCalled();
  });
});

describe('upsertArticle — write guard against a status changed during the save', () => {
  const MESSAGE = /unpublished for violating Terms of Service and its status cannot be changed/;
  const updateWhere = () => mockDbWrite.article.update.mock.calls[0]?.[0]?.where;
  const p2025 = () =>
    new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 'test' });

  it.each(['Published', 'Processing'])(
    'refuses to overwrite a row that is now UnpublishedViolation when %s was read',
    async (status) => {
      mockStored({ status });

      await upsert({ status });

      expect(updateWhere()).toEqual({ id: ARTICLE_ID, status: { not: 'UnpublishedViolation' } });
    }
  );

  it('reports the status lock when that guard matches no row', async () => {
    mockStored({ status: 'Published' });
    mockDbWrite.article.update.mockRejectedValue(p2025());

    await expect(upsert({ status: 'Published' })).rejects.toThrow(MESSAGE);
  });

  it('does not guard a moderator write', async () => {
    mockStored({ status: 'Published' });

    await upsert({ userId: MODERATOR_ID, isModerator: true, status: 'Published' });

    expect(updateWhere()).toEqual({ id: ARTICLE_ID });
  });

  it('does not guard a content edit on an article already stored as UnpublishedViolation', async () => {
    mockStored({ status: 'UnpublishedViolation' });

    await upsert({ status: undefined, content: 'edited' });

    expect(updateWhere()).toEqual({ id: ARTICLE_ID });
    expect(updateData().content).toBe('edited');
  });

  it('keeps the never-published-draft guard and its own message', async () => {
    mockStored({ status: 'Draft' });
    mockDbWrite.article.update.mockRejectedValue(p2025());

    await expect(upsert({ status: 'Draft' })).rejects.toThrow(/published while you were editing/);

    expect(updateWhere()).toEqual({ id: ARTICLE_ID, status: 'Draft', publishedAt: null });
  });
});
