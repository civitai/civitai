import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as ImageUrlOwnership from '~/server/services/image-url-ownership';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    userArticleCountCache: {
      ...actual.userArticleCountCache,
      refresh: vi.fn(async () => undefined),
    },
  };
});
const checks = vi.hoisted(() => ({
  refusedKey: null as string | null,
  foreignKey: null as string | null,
}));
vi.mock('~/server/services/image-url-ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageUrlOwnership>();
  return {
    ...actual,
    assertClientImageUrlsUsable: vi.fn(async () => undefined),
    assertClientKeysIssuedToCaller: vi.fn(async ({ urls }: { urls: string[] }) => {
      if (checks.refusedKey && urls.includes(checks.refusedKey))
        throw actual.imageUrlUnavailableError();
    }),
    keyIssuers: vi.fn(async ({ urls }: { urls: string[] }) => ({
      tooMany: false,
      issuedToOthers: urls.filter((url) => url === checks.foreignKey),
      unrecorded: [],
      recordReadFailed: false,
      requestLogReadFailed: false,
    })),
  };
});

import { rescanArticle, upsertArticle } from '~/server/services/article.service';
import {
  assertClientImageUrlsUsable,
  assertClientKeysIssuedToCaller,
  ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE,
} from '~/server/services/image-url-ownership';

const ARTICLE_ID = 21;
const OWNER_ID = 7;
const MODERATOR_ID = 9;
const NEW_KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const EXISTING_KEY = 'cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5e';
const media = (key: string) => `<edge-media url="${key}" type="image"></edge-media>`;
const CONTENT = `<p>text</p>${media(EXISTING_KEY)}${media(NEW_KEY)}`;

beforeEach(() => {
  vi.clearAllMocks();
  checks.refusedKey = null;
  checks.foreignKey = null;
  const row = {
    id: ARTICLE_ID,
    title: 'Stored title',
    cover: null,
    coverId: null,
    userId: OWNER_ID,
    publishedAt: null,
    status: 'Draft',
    nsfwLevel: 1,
    userNsfwLevel: 1,
    moderatorNsfwLevel: null,
    lockedProperties: [],
    metadata: {},
    content: 'stored content',
  };
  mockDbWrite.article.findUnique.mockResolvedValue(row);
  mockDbRead.article.findUnique.mockResolvedValue(row);
  mockDbWrite.article.findFirst.mockResolvedValue(row);
  mockDbWrite.article.update.mockResolvedValue({ id: ARTICLE_ID, userId: OWNER_ID, tags: [] });
  mockDbWrite.imageConnection.findMany.mockResolvedValue([]);
  mockDbWrite.image.findMany.mockImplementation((async (args: {
    where?: { url?: { in?: string[] } };
  }) =>
    (args?.where?.url?.in ?? [])
      .filter((url) => url === EXISTING_KEY)
      .map((url) => ({ id: 1, url, ingestion: 'Scanned' }))) as never);
  mockDbRead.image.findMany.mockResolvedValue([]);
});

const upsert = (input: Record<string, unknown>) =>
  upsertArticle({
    userId: OWNER_ID,
    title: 'A title',
    content: CONTENT,
    status: 'Draft',
    scanContent: true,
    ...input,
  } as never);

describe('upsertArticle content image urls', () => {
  it('refuses an update with a refused content url and writes nothing', async () => {
    checks.refusedKey = NEW_KEY;

    await expect(upsert({ id: ARTICLE_ID })).rejects.toThrow(
      ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE
    );

    expect(mockDbWrite.article.update).not.toHaveBeenCalled();
    expect(mockDbWrite.image.createManyAndReturn).not.toHaveBeenCalled();
    expect(mockDbWrite.imageConnection.upsert).not.toHaveBeenCalled();
  });

  it('refuses a new article with a refused content url and writes nothing', async () => {
    checks.refusedKey = NEW_KEY;

    await expect(upsert({})).rejects.toThrow(ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE);

    expect(mockDbWrite.article.create).not.toHaveBeenCalled();
    expect(mockDbWrite.image.createManyAndReturn).not.toHaveBeenCalled();
    expect(mockDbWrite.imageConnection.upsert).not.toHaveBeenCalled();
  });

  const storeContent = async (content: string) => {
    const stored = await mockDbWrite.article.findUnique({ where: { id: ARTICLE_ID } } as never);
    mockDbWrite.article.findUnique.mockResolvedValue({ ...stored, content } as never);
    mockDbRead.article.findUnique.mockResolvedValue({ ...stored, content } as never);
  };
  const withRowsFor = (keys: string[]) =>
    mockDbWrite.image.findMany.mockImplementation((async (args: {
      where?: { url?: { in?: string[] } };
    }) =>
      (args?.where?.url?.in ?? [])
        .filter((url) => keys.includes(url))
        .map((url) => ({ id: 1, url, ingestion: 'Scanned' }))) as never);

  it('saves an edit that keeps a stored url with no row, even one the check would refuse', async () => {
    checks.refusedKey = NEW_KEY;
    await storeContent(CONTENT);

    await upsert({ id: ARTICLE_ID, content: `${CONTENT}<p>edit</p>` });

    expect(mockDbWrite.article.update).toHaveBeenCalled();
    expect(vi.mocked(assertClientKeysIssuedToCaller)).not.toHaveBeenCalled();
  });

  it('refuses an edit that keeps a stored url with no row whose key was issued to another user', async () => {
    checks.foreignKey = NEW_KEY;
    await storeContent(CONTENT);

    await expect(upsert({ id: ARTICLE_ID, content: `${CONTENT}<p>edit</p>` })).rejects.toThrow(
      ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(mockDbWrite.article.update).not.toHaveBeenCalled();
  });

  it('refuses an edit that adds a url with no row the check refuses', async () => {
    checks.refusedKey = NEW_KEY;
    await storeContent(`<p>text</p>${media(EXISTING_KEY)}`);

    await expect(upsert({ id: ARTICLE_ID, content: `${CONTENT}<p>edit</p>` })).rejects.toThrow(
      ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(mockDbWrite.article.update).not.toHaveBeenCalled();
  });

  it('saves an edit to a draft whose saved content urls all have rows', async () => {
    checks.refusedKey = NEW_KEY;
    await storeContent(CONTENT);
    withRowsFor([EXISTING_KEY, NEW_KEY]);

    await upsert({ id: ARTICLE_ID, content: `${CONTENT}<p>edit</p>` });

    expect(mockDbWrite.article.update).toHaveBeenCalled();
    expect(vi.mocked(assertClientKeysIssuedToCaller)).not.toHaveBeenCalled();
  });

  it('refuses a rescan whose stored url with no row has a key issued to another user', async () => {
    checks.foreignKey = NEW_KEY;
    await storeContent(CONTENT);

    await expect(rescanArticle({ id: ARTICLE_ID, isModerator: true })).rejects.toThrow(
      ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('rescans an article whose stored urls have no rows, with no new-url check', async () => {
    checks.refusedKey = NEW_KEY;
    await storeContent(CONTENT);

    // Only how far it gets matters here; later steps read rows this fake does not hold.
    await rescanArticle({ id: ARTICLE_ID, isModerator: true }).catch(() => null);

    expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
    expect(vi.mocked(assertClientKeysIssuedToCaller)).not.toHaveBeenCalled();
  });

  it('rescans an article whose saved content urls all have rows', async () => {
    checks.refusedKey = NEW_KEY;
    await storeContent(CONTENT);
    withRowsFor([EXISTING_KEY, NEW_KEY]);

    // Only how far it gets matters here; later steps read rows this fake does not hold.
    await rescanArticle({ id: ARTICLE_ID, isModerator: true }).catch(() => null);

    expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
    expect(vi.mocked(assertClientKeysIssuedToCaller)).not.toHaveBeenCalled();
  });

  it('checks every new content url of a large article, a bounded number at a time', async () => {
    const keys = Array.from(
      { length: 40 },
      (_, i) => `ab12cd34-ef56-4a7b-8c9d-${i.toString(16).padStart(12, 'b')}`
    );
    await upsert({ id: ARTICLE_ID, content: keys.map(media).join('') });

    const checked = vi
      .mocked(assertClientKeysIssuedToCaller)
      .mock.calls.map(([args]) => (args as { urls: string[] }).urls);
    expect(checked.flat().sort()).toEqual([...keys].sort());
    expect(Math.max(...checked.map((urls) => urls.length))).toBeLessThanOrEqual(16);
  });

  it("checks only urls with no row, against the owner, accepting the editor's keys", async () => {
    await upsert({ id: ARTICLE_ID, userId: MODERATOR_ID, isModerator: true }).catch(() => null);

    expect(vi.mocked(assertClientKeysIssuedToCaller)).toHaveBeenCalledWith({
      urls: [NEW_KEY],
      userId: OWNER_ID,
      alsoIssuedTo: MODERATOR_ID,
    });
    expect(vi.mocked(assertClientImageUrlsUsable)).toHaveBeenCalledWith({
      urls: [NEW_KEY],
      userId: OWNER_ID,
    });
  });
});
