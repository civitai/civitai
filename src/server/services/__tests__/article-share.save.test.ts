import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { recordTx, useTxClients } from '~/__tests__/tx-client';
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
vi.mock('~/server/notifications/client', () => ({
  notifications: { createNotification: vi.fn(async () => undefined) },
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
  recomputeArticleIngestion,
  unpublishArticleById,
  upsertArticle,
} from '~/server/services/article.service';
import { sharedArticleTextHash } from '~/server/services/article-share.helpers';
import { getArticleByShareToken } from '~/server/services/article-share.service';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  EntityModerationStatus,
} from '~/shared/utils/prisma/enums';

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

const writtenStatus = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values).sql)
    .find((sql) => sql.trim().startsWith('UPDATE "Article"')) ?? '';

/** The transaction the content write ran in, given `recordTx` of `$executeRaw`. */
const contentWriteTx = (ranIn: number[]) =>
  ranIn[
    dbMock.dbWrite.$executeRaw.mock.calls.findIndex(([strings, ...values]) =>
      Prisma.sql(strings as TemplateStringsArray, ...values).sql.startsWith(
        'UPDATE "Article" SET content'
      )
    )
  ];

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
  useTxClients();
  // Implementations outlive clearAllMocks; a case that drives the generation must not leak it.
  dbMock.dbWrite.articleShareCheck.findUnique.mockReset();
  dbMock.dbWrite.articleShareCheck.findUnique.mockResolvedValue(null);
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
    const writes = recordTx(dbMock.dbWrite.$executeRaw, 1);
    const voids = recordTx(dbMock.dbWrite.entityModeration.updateMany, { count: 1 });
    await rewrite();
    expect(dbMock.dbWrite.entityModeration.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'Article', entityId: ARTICLE },
      data: { status: 'Pending', workflowId: null },
    });
    expect(voids[0]).toBeGreaterThan(0);
    expect(voids[0]).toBe(contentWriteTx(writes));
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

  it('checks again when a save changed the text while the check was out', async () => {
    checkRecord(true);
    // Generation as each snapshot sees it: the first check's confirm finds it bumped.
    dbMock.dbWrite.articleShareCheck.findUnique
      .mockResolvedValueOnce({ generation: 1 } as never)
      .mockResolvedValueOnce({ generation: 2 } as never)
      .mockResolvedValue({ generation: 2 } as never);
    await rewrite();
    expect(submitTextModerationOrScan).toHaveBeenCalledTimes(2);
    expect(dbMock.dbWrite.articleShareCheck.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ workflowId: 'wf' }) })
    );
    expect(dbMock.dbWrite.accessToken.updateMany).not.toHaveBeenCalled();
  });

  it('withdraws every link when the text never holds still for a check', async () => {
    checkRecord(true);
    // Moves on every read until the 50th, then holds: without the attempt bound the loop still
    // ends, and the count below fails with a number instead of the run hanging.
    let generation = 0;
    dbMock.dbWrite.articleShareCheck.findUnique.mockImplementation((async () => ({
      generation: generation < 50 ? generation++ : generation,
    })) as never);
    await rewrite();
    expect(vi.mocked(submitTextModerationOrScan).mock.calls.length).toBeLessThanOrEqual(3);
    expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ resourceId: ARTICLE }) })
    );
  });

  it('bumps the check generation in the same transaction as the new text', async () => {
    checkRecord(true);
    const writes = recordTx(dbMock.dbWrite.$executeRaw, 1);
    const upserts = recordTx(dbMock.dbWrite.articleShareCheck.upsert, {});
    await rewrite();
    const bump = { generation: { increment: 1 }, workflowId: null, textHash: null };
    const i = dbMock.dbWrite.articleShareCheck.upsert.mock.calls.findIndex(
      ([arg]) => JSON.stringify((arg as { update: unknown }).update) === JSON.stringify(bump)
    );
    expect(i).toBeGreaterThanOrEqual(0);
    expect(upserts[i]).toBeGreaterThan(0);
    expect(upserts[i]).toBe(contentWriteTx(writes));
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

  // A block landing between a moderator's first read and the save records where a restore
  // returns the draft. Saving the stale copy over it would make that restore publish it.
  it("keeps what a block recorded after the save's first read", async () => {
    dbMock.dbWrite.article.findUnique
      .mockResolvedValueOnce({ ...stored, metadata: { theme: 'x' } } as never)
      .mockResolvedValue({
        ...stored,
        status: ArticleStatus.UnpublishedViolation,
        metadata: { theme: 'x', statusBeforeViolation: 'Draft' },
      } as never);
    await upsertArticle({
      id: ARTICLE,
      userId: 99,
      isModerator: true,
      title: 'Title',
      content: '<p>Old body</p>',
    } as never);
    expect(formWrite().metadata).toEqual({ theme: 'x', statusBeforeViolation: 'Draft' });
  });

  it('leaves ingestion alone on an unshared draft', async () => {
    dbMock.dbWrite.accessToken.findMany.mockResolvedValue([]);
    await save();
    expect(formWrite().ingestion).toBeUndefined();
  });
});

describe('publishing a draft that has a share link', () => {
  const draft = {
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
    content: '<p>Body</p>',
  };
  // One link, made on the draft, that only a revoke can end.
  let link: Omit<ReturnType<typeof activeLink>, 'revokedAt'> & {
    id: number;
    createdById: number;
    revokedAt: Date | null;
  };

  beforeEach(() => {
    link = { ...activeLink(), id: 3, createdById: AUTHOR };
    dbMock.dbWrite.accessToken.findMany.mockImplementation((async () =>
      link.revokedAt ? [] : [link]) as never);
    dbMock.dbWrite.accessToken.findUnique.mockImplementation((async () => link) as never);
    dbMock.dbWrite.accessToken.updateMany.mockImplementation((async ({
      where,
    }: {
      where: { resourceId?: number };
    }) => {
      if (where.resourceId === ARTICLE && !link.revokedAt) link.revokedAt = new Date();
      return { count: 1 };
    }) as never);
    dbMock.dbWrite.article.findUnique.mockResolvedValue(draft as never);
    dbMock.dbWrite.article.findFirst.mockResolvedValue(draft as never);
    dbMock.dbRead.article.findUnique.mockResolvedValue(draft as never);
  });

  const saveAs = (status: ArticleStatus) => {
    dbMock.dbWrite.article.update.mockResolvedValue({
      ...draft,
      status,
      tags: [],
    } as never);
    return upsertArticle({ id: ARTICLE, userId: AUTHOR, title: 'Title', status } as never);
  };

  it.each([ArticleStatus.Published, ArticleStatus.Processing])(
    'revokes the link in the save that sends it %s',
    async (status) => {
      await saveAs(status);
      expect(link.revokedAt).not.toBeNull();
    }
  );

  it('keeps the link on a save that leaves it a draft', async () => {
    await saveAs(ArticleStatus.Draft);
    expect(link.revokedAt).toBeNull();
  });

  // Deliberate: the link was made for the draft, not for the article. Delete this and a link a
  // reviewer kept reopens every later unpublished version, for up to 30 days.
  it('a link made on the draft does not read the article once it is published and then unpublished', async () => {
    await saveAs(ArticleStatus.Published);
    const published = { ...draft, status: ArticleStatus.Published, publishedAt: new Date() };
    dbMock.dbRead.article.findUnique.mockResolvedValue(published as never);
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([published] as never);
    await unpublishArticleById({ id: ARTICLE, userId: AUTHOR });

    // Everything else the read requires is in place, so only the link can refuse it.
    dbMock.dbWrite.article.findUnique.mockResolvedValue({
      ...draft,
      status: ArticleStatus.Unpublished,
      ingestion: ArticleIngestionStatus.Scanned,
      updatedAt: new Date(),
      coverImage: null,
      user: { id: AUTHOR, username: 'author', bannedAt: null, muted: false, deletedAt: null },
    } as never);
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: EntityModerationStatus.Succeeded,
      blocked: false,
      workflowId: 'wf',
      updatedAt: new Date(),
    } as never);
    dbMock.dbWrite.articleShareCheck.findUnique.mockResolvedValue({
      workflowId: 'wf',
      textHash: sharedArticleTextHash({ title: 'Title', content: '<p>Body</p>' }),
    } as never);

    expect(
      await getArticleByShareToken({ articleId: ARTICLE, shareToken: 'a'.repeat(43) })
    ).toEqual({ status: 'unavailable' });
  });
});

describe('the scan settling on an article sent for processing', () => {
  const settle = (status: ArticleStatus) => {
    dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([]);
    dbMock.dbWrite.article.findUniqueOrThrow.mockResolvedValue({
      ingestion: ArticleIngestionStatus.Pending,
      status,
      publishedAt: null,
      userId: AUTHOR,
      title: '',
      content: '',
      coverId: null,
      moderatorNsfwLevel: null,
    } as never);
    return recomputeArticleIngestion(ARTICLE);
  };
  const revoked = () =>
    dbMock.dbWrite.accessToken.updateMany.mock.calls.some(
      ([args]) => (args as { where: { resourceId?: number } }).where.resourceId === ARTICLE
    );

  it('revokes its share links in the recompute that takes it live', async () => {
    await settle(ArticleStatus.Processing);
    expect(writtenStatus()).toContain('status =');
    expect(revoked()).toBe(true);
  });

  // Held to commit, so a link cannot be made between the revoke and the flip.
  it('takes the share-link lock before it writes the article', async () => {
    await settle(ArticleStatus.Processing);
    const sqls = dbMock.dbWrite.$executeRaw.mock.calls.map(([strings]) =>
      (strings as string[]).join('?').trim()
    );
    const lock = sqls.findIndex((sql) => sql.includes('pg_advisory_xact_lock(?::int, ?::int)'));
    const write = sqls.findIndex((sql) => sql.startsWith('UPDATE "Article"'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(write);
  });

  it('leaves the links of a draft whose scan settles', async () => {
    await settle(ArticleStatus.Draft);
    expect(writtenStatus()).not.toContain('status =');
    expect(revoked()).toBe(false);
  });
});

describe('a moderator unpublishing an article', () => {
  beforeEach(() => {
    const published = {
      userId: AUTHOR,
      publishedAt: new Date(),
      status: ArticleStatus.Published,
    };
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([published] as never);
  });

  it('revokes every share link on it', async () => {
    await unpublishArticleById({ id: ARTICLE, userId: 99, isModerator: true });
    expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resourceType: 'Article', resourceId: ARTICLE, revokedAt: null },
      })
    );
  });

  // A moderator may have published a blocked draft from the editor, keeping what the block
  // recorded; the next restore must publish it, not return it to its author.
  it('drops the status an earlier block recorded', async () => {
    await unpublishArticleById({
      id: ARTICLE,
      userId: 99,
      isModerator: true,
      reason: 'other',
      metadata: { theme: 'x', statusBeforeViolation: 'Draft' },
    });
    expect(dbMock.dbWrite.article.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.not.objectContaining({ statusBeforeViolation: expect.anything() }),
        }),
      })
    );
    expect(
      (
        dbMock.dbWrite.article.update.mock.calls[0] as unknown as [{ data: { metadata: object } }]
      )[0].data.metadata
    ).toMatchObject({ theme: 'x', unpublishedReason: 'other' });
  });

  it('leaves them when the author unpublishes it', async () => {
    await unpublishArticleById({ id: ARTICLE, userId: AUTHOR });
    expect(dbMock.dbWrite.accessToken.updateMany).not.toHaveBeenCalled();
  });
});
