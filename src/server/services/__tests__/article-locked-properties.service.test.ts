import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for upsertArticle's lockedProperties enforcement — locks are read from the
// stored row, never from the client payload. article.service.ts has a large import graph,
// so its transitive service/db/search dependencies are stubbed out below.

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  });
  const tx = {
    article: mk(),
    image: mk(),
    imageConnection: mk(),
    tagsOnArticle: mk(),
    collectionItem: mk(),
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  };
  return {
    mockDbRead: { article: mk(), image: mk(), $queryRaw: vi.fn() },
    mockDbWrite: {
      ...tx,
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));

import { upsertArticle } from '~/server/services/article.service';

const ARTICLE_ID = 21;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

function mockStored({
  lockedProperties = [] as string[],
  userId = OWNER_ID,
  userNsfwLevel = 1,
}: { lockedProperties?: string[]; userId?: number; userNsfwLevel?: number } = {}) {
  const row = {
    id: ARTICLE_ID,
    title: 'Stored title',
    cover: null,
    coverId: null,
    userId,
    publishedAt: null,
    status: 'Draft',
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

function updateData() {
  return mockDbWrite.article.update.mock.calls.at(-1)?.[0]?.data ?? {};
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
