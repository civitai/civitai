import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import type * as TextModerationService from '~/server/services/text-moderation.service';
import type * as TextScanRoute from '~/server/services/text-scan/route';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanRoute>()),
  submitTextModerationOrScan: vi.fn(async () => ({ id: 'wf' })),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userArticleCountCache: {
      ...actual.userArticleCountCache,
      refresh: vi.fn(async () => undefined),
    },
  };
});

import {
  applyArticleContentChange,
  unpublishArticleById,
  upsertArticle,
} from '~/server/services/article.service';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

const ARTICLE = 21;
const AUTHOR = 7;
const HOUR = 60 * 60 * 1000;

const activeLink = () => ({
  resourceId: ARTICLE,
  resourceType: 'Article',
  expiresAt: new Date(Date.now() + HOUR),
  revokedAt: null,
});

// A content rewrite with no caller snapshot, as a blurb fan-out makes it.
const rewrite = () =>
  applyArticleContentChange({ id: ARTICLE, userId: AUTHOR, content: '<p>New body</p>' });

const writtenSql = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values).sql)
    .find((sql) => sql.startsWith('UPDATE "Article" SET content'));

/** The check record as the submit left it: reset now, or untouched since an hour ago. */
const checkRecord = (resetBySubmit: boolean) =>
  dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => ({
    updatedAt: resetBySubmit ? new Date(Date.now() + 1000) : new Date(Date.now() - HOUR),
  })) as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.article.findUnique.mockResolvedValue({
    userId: AUTHOR,
    title: 'Title',
    content: '<p>Old body</p>',
    coverId: null,
    status: ArticleStatus.Draft,
    scheduledAt: null,
  } as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
});

describe('saving a draft that has an active share link', () => {
  beforeEach(() => {
    dbMock.dbWrite.accessToken.findMany.mockResolvedValue([activeLink()] as never);
  });

  it('takes it out of Scanned in the same statement that writes the new text', async () => {
    checkRecord(true);
    await rewrite();
    expect(writtenSql()).toContain(`ingestion = 'Rescan'`);
  });

  it('voids the earlier verdict in the same transaction as the new text', async () => {
    checkRecord(true);
    await rewrite();
    expect(dbMock.dbWrite.entityModeration.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'Article', entityId: ARTICLE },
      data: { status: 'Pending', workflowId: null },
    });
  });

  it('leaves the verdict alone when its guarded write lands on nothing', async () => {
    checkRecord(true);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0 as never);
    const applied = await applyArticleContentChange({
      id: ARTICLE,
      userId: AUTHOR,
      content: '<p>New body</p>',
      expectedContent: '<p>Something else</p>',
    });
    expect(applied).toBe(false);
    expect(dbMock.dbWrite.entityModeration.updateMany).not.toHaveBeenCalled();
  });

  it('holds the share lock from reading the text until the check is recorded', async () => {
    checkRecord(true);
    await rewrite();
    const locks = dbMock.dbWrite.$executeRaw.mock.calls
      .map(([strings, ...values], i) => ({
        sql: Prisma.sql(strings as TemplateStringsArray, ...values).sql,
        order: dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[i],
      }))
      .filter(({ sql }) => sql.includes('pg_advisory_xact_lock'));
    const submitAt = vi.mocked(submitTextModerationOrScan).mock.invocationCallOrder[0];
    const recordAt = dbMock.dbWrite.articleShareCheck.upsert.mock.invocationCallOrder[0];
    // The last lock before the submit is the check's own, and the record follows the submit.
    expect(locks.filter(({ order }) => order < submitAt).length).toBeGreaterThanOrEqual(2);
    expect(recordAt).toBeGreaterThan(submitAt);
  });

  it('keeps its verdict and links when a save leaves the text as it was', async () => {
    checkRecord(false);
    await applyArticleContentChange({ id: ARTICLE, userId: AUTHOR, content: '<p>Old body</p>' });
    expect(writtenSql()).not.toContain('ingestion');
    expect(dbMock.dbWrite.entityModeration.updateMany).not.toHaveBeenCalled();
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.accessToken.updateMany).not.toHaveBeenCalled();
  });

  it('sends the new text for a fresh check and keeps the links when the check started', async () => {
    checkRecord(true);
    await rewrite();
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: ARTICLE, force: true })
    );
    expect(dbMock.dbWrite.accessToken.updateMany).not.toHaveBeenCalled();
  });

  it('withdraws every link when the check record was not reset by the submit', async () => {
    checkRecord(false);
    await rewrite();
    expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resourceType: 'Article', resourceId: ARTICLE, revokedAt: null },
      })
    );
  });

  it('withdraws every link when the submit throws', async () => {
    checkRecord(true);
    vi.mocked(submitTextModerationOrScan).mockRejectedValueOnce(new Error('down'));
    await rewrite();
    expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ resourceId: ARTICLE }) })
    );
  });
});

describe('saving a draft with no active share link', () => {
  it('leaves ingestion alone and sends nothing for checks', async () => {
    dbMock.dbWrite.accessToken.findMany.mockResolvedValue([
      { ...activeLink(), expiresAt: new Date(Date.now() - HOUR) },
    ] as never);
    await rewrite();
    expect(writtenSql()).not.toContain('ingestion');
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
  });
});

describe('saving a shared draft from the editor', () => {
  const stored = {
    id: ARTICLE,
    title: 'Title',
    cover: null,
    coverId: null,
    userId: AUTHOR,
    publishedAt: null,
    status: ArticleStatus.Draft,
    nsfwLevel: 1,
    userNsfwLevel: 1,
    moderatorNsfwLevel: null,
    lockedProperties: [],
    metadata: {},
    content: '<p>Old body</p>',
  };
  const formWrite = () => dbMock.dbWrite.article.update.mock.calls[0][0].data;

  beforeEach(() => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.article.findFirst.mockResolvedValue(stored as never);
    dbMock.dbWrite.article.update.mockResolvedValue({
      id: ARTICLE,
      userId: AUTHOR,
      status: ArticleStatus.Draft,
      scheduledAt: null,
      tags: [],
    } as never);
    checkRecord(true);
  });

  const save = () =>
    upsertArticle({
      id: ARTICLE,
      userId: AUTHOR,
      title: 'Title',
      content: '<p>New body</p>',
    } as never);

  it('takes it out of Scanned and voids its verdict in the write that saves the text', async () => {
    dbMock.dbWrite.accessToken.findMany.mockResolvedValue([activeLink()] as never);
    await save();
    expect(formWrite().ingestion).toBe('Rescan');
    expect(dbMock.dbWrite.entityModeration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'Pending', workflowId: null } })
    );
  });

  it('judges the change against the text stored under the lock, not the earlier read', async () => {
    dbMock.dbWrite.accessToken.findMany.mockResolvedValue([activeLink()] as never);
    // The request read its own payload's text; another save changed it before this one locked.
    dbMock.dbWrite.article.findUnique
      .mockResolvedValueOnce({ ...stored, content: '<p>New body</p>' } as never)
      .mockResolvedValue({ ...stored, content: '<p>Other body</p>' } as never);
    await save();
    expect(formWrite().ingestion).toBe('Rescan');
    expect(submitTextModerationOrScan).toHaveBeenCalled();
  });

  it('leaves ingestion alone on an unshared draft', async () => {
    dbMock.dbWrite.accessToken.findMany.mockResolvedValue([]);
    await save();
    expect(formWrite().ingestion).toBeUndefined();
  });
});

describe('a moderator unpublishing an article', () => {
  beforeEach(() => {
    const published = {
      userId: AUTHOR,
      publishedAt: new Date(),
      status: ArticleStatus.Published,
    };
    dbMock.dbRead.article.findUnique.mockResolvedValue(published as never);
    dbMock.dbWrite.article.findUnique.mockResolvedValue(published as never);
  });

  it('revokes every share link on it', async () => {
    await unpublishArticleById({ id: ARTICLE, userId: 99, isModerator: true });
    expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resourceType: 'Article', resourceId: ARTICLE, revokedAt: null },
      })
    );
  });

  it('leaves them when the author unpublishes it', async () => {
    await unpublishArticleById({ id: ARTICLE, userId: AUTHOR });
    expect(dbMock.dbWrite.accessToken.updateMany).not.toHaveBeenCalled();
  });
});
