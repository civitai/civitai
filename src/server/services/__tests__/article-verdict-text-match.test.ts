import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { useTxClients } from '~/__tests__/tx-client';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
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
  submitTextModerationOrScan: vi.fn(),
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { createNotification: vi.fn(async () => undefined) },
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

import { articleIngestionReconcile } from '~/server/jobs/article-ingestion-reconcile';
import {
  applyArticleContentChange,
  ARTICLE_TEXT_VERDICT_HASHED_SINCE,
  recomputeArticleIngestion,
} from '~/server/services/article.service';
import {
  articleModerationText,
  articleTextScanFields,
} from '~/server/services/article-ingestion.helpers';
import { articleModerationAdapter } from '~/server/services/article-moderation.adapter';
import { hashContent } from '~/server/services/entity-moderation.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import '~/server/services/text-scan/profiles/article.profile';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  EntityModerationStatus,
} from '~/shared/utils/prisma/enums';

const ARTICLE = 51;
const AUTHOR = 7;
const OLD = { title: 'Title', content: '<p>Old body</p>' };
const NEW = { title: 'Title', content: '<p>New body</p>' };
const DAY = 24 * 60 * 60 * 1000;
const AFTER_CUTOFF = new Date(ARTICLE_TEXT_VERDICT_HASHED_SINCE.getTime() + DAY);

const xguardHash = (text: typeof OLD) =>
  hashContent(articleModerationText(text.title, text.content));
const scanHash = (text: typeof OLD) =>
  textScanTextHash({ fields: articleTextScanFields(text.title, text.content), declared: {} });

type Row = {
  status: EntityModerationStatus;
  blocked: boolean | null;
  contentHash: string | null;
  result: unknown;
  updatedAt: Date;
  retryCount: number;
};
let row: Row | null;
let article: {
  title: string;
  content: string;
  status: ArticleStatus;
  ingestion: ArticleIngestionStatus;
};

/** A clean verdict, as each pipeline stores it. */
const xguardVerdict = (text: typeof OLD, extra: Partial<Row> = {}): Row => ({
  status: EntityModerationStatus.Succeeded,
  blocked: false,
  contentHash: xguardHash(text),
  result: { blocked: false, triggeredLabels: [], results: [] },
  updatedAt: AFTER_CUTOFF,
  retryCount: 0,
  ...extra,
});
const scanVerdict = (text: typeof OLD): Row => ({
  ...xguardVerdict(text),
  contentHash: 'composite-of-prompt-model-and-text',
  result: { version: 1, labels: {}, textHash: scanHash(text) },
});

/** The statement the recompute wrote the article's scan state with. */
const writtenSql = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values).sql)
    .filter((sql) => sql.includes('SET ingestion ='))
    .at(-1);

/** The ingestion the recompute wrote, or undefined if it never ran. */
const writtenIngestion = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values))
    .filter((sql) => sql.sql.includes('SET ingestion ='))
    .at(-1)?.values[0];

beforeEach(() => {
  vi.clearAllMocks();
  useTxClients();
  row = null;
  // A live article whose edit took it out of Scanned.
  article = { ...NEW, status: ArticleStatus.Published, ingestion: ArticleIngestionStatus.Rescan };
  const articleRow = async () => ({
    ...article,
    userId: AUTHOR,
    coverId: null,
    bannerId: null,
    scheduledAt: null,
    publishedAt: new Date('2026-11-01'),
    moderatorNsfwLevel: null,
  });
  dbMock.dbWrite.article.findUniqueOrThrow.mockImplementation(articleRow as never);
  dbMock.dbWrite.article.findUnique.mockImplementation(articleRow as never);
  dbMock.dbRead.article.findUnique.mockImplementation(articleRow as never);
  dbMock.dbWrite.article.findMany.mockImplementation((async () => [
    { ...(await articleRow()), id: ARTICLE, userNsfwLevel: 1 },
  ]) as never);
  dbMock.dbWrite.accessToken.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => row) as never);
  dbMock.dbRead.entityModeration.findUnique.mockImplementation((async () => row) as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
});

describe('the recompute counts a text verdict only for the text it judged', () => {
  it('positive control: a verdict for the current text takes it to Scanned', async () => {
    row = xguardVerdict(NEW);
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
  });

  it('an XGuard verdict for older text leaves it Pending', async () => {
    row = xguardVerdict(OLD);
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it('a text-scan verdict for older text leaves it Pending', async () => {
    row = scanVerdict(OLD);
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it('a text-scan verdict that did not cover all of the current text leaves it Pending', async () => {
    row = scanVerdict(NEW);
    row.result = { ...(row.result as object), meta: { inputCut: true } };
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', name: 'article-verdict-input-cut' })
    );
  });

  it('a text-scan verdict that found a violation in part of the current text blocks it', async () => {
    row = { ...scanVerdict(NEW), blocked: true };
    row.result = { ...(row.result as object), meta: { inputCut: true } };
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Blocked);
  });

  it('a cut text-scan verdict with a hit, for older text, does not block this text', async () => {
    row = { ...scanVerdict(OLD), blocked: true };
    row.result = { ...(row.result as object), meta: { inputCut: true } };
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it('a blocked verdict for older text does not block this text', async () => {
    row = xguardVerdict(OLD, { blocked: true });
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it('a Processing article with a verdict for its text still goes live', async () => {
    article = {
      ...article,
      status: ArticleStatus.Processing,
      ingestion: ArticleIngestionStatus.Pending,
    };
    row = scanVerdict(NEW);
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
    expect(writtenSql()).toContain('status =');
  });

  it('an article already Scanned keeps what it has', async () => {
    article = { ...article, ingestion: ArticleIngestionStatus.Scanned };
    // Would not count on the way in: no hash, and newer than the cutoff.
    row = xguardVerdict(OLD, { contentHash: null });
    await recomputeArticleIngestion(ARTICLE);
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
  });

  describe('a verdict with no comparable hash', () => {
    it('counts, and is logged, when written before verdicts carried one', async () => {
      row = xguardVerdict(OLD, {
        contentHash: null,
        updatedAt: new Date(ARTICLE_TEXT_VERDICT_HASHED_SINCE.getTime() - DAY),
      });
      await recomputeArticleIngestion(ARTICLE);
      expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'article-verdict-unverifiable' })
      );
    });

    it('does not count when written after', async () => {
      row = xguardVerdict(OLD, { contentHash: null });
      await recomputeArticleIngestion(ARTICLE);
      expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
    });
  });
});

describe('submitted text hashes to what the recompute compares', () => {
  it('XGuard: the text an edit submits', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ xguard }) => xguard());
    article = {
      ...OLD,
      status: ArticleStatus.Published,
      ingestion: ArticleIngestionStatus.Scanned,
    };
    await applyArticleContentChange({ id: ARTICLE, userId: AUTHOR, content: NEW.content });
    const submitted = vi.mocked(submitTextModeration).mock.calls[0][0].content;
    // createXGuardModerationRequest stores hashContent of the submitted text (no label overrides).
    expect(hashContent(submitted)).toBe(xguardHash(NEW));
  });

  it('text scan: the subject the article profile builds', async () => {
    const subject = (await getTextScanProfile('Article')?.load([ARTICLE]))?.get(ARTICLE);
    expect(subject).toBeDefined();
    expect(textScanTextHash(subject!)).toBe(scanHash(NEW));
  });
});

describe('the reconcile', () => {
  const reconcile = async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: ARTICLE }] as never);
    return (await articleIngestionReconcile.run({}).result) as Record<string, number>;
  };
  beforeEach(() => {
    const counts = new Map<string, number>();
    redisMock.sysRedis.incrBy.mockImplementation((async (key: string, by: number) => {
      counts.set(key, (counts.get(key) ?? 0) + by);
      return counts.get(key);
    }) as never);
  });

  it('stops forcing resubmits for one text after three, and says so', async () => {
    row = xguardVerdict(OLD);
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf' });
    for (let run = 0; run < 4; run++) await reconcile();
    expect(submitTextModerationOrScan).toHaveBeenCalledTimes(3);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'article-verdict-resubmit-capped' })
    );
  });

  it('does not resubmit a verdict that did not cover all of the text', async () => {
    row = scanVerdict(NEW);
    row.result = { ...(row.result as object), meta: { inputCut: true } };
    await reconcile();
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
  });

  it('counts a resubmit the scan skipped as skipped, not resubmitted', async () => {
    row = xguardVerdict(OLD);
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ onActiveSkip }) => {
      await onActiveSkip?.('missing-prompt');
      return null;
    });
    expect(await reconcile()).toMatchObject({ resubmitted: 0, skippedResubmits: 1 });
  });

  it('resubmits the stored text of an article whose verdict is for older text', async () => {
    row = xguardVerdict(OLD);
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ xguard }) => xguard());
    await reconcile();
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
    // Forced past each pipeline's dedup, which would otherwise skip it and leave it waiting.
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ force: true })
    );
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ forceRescan: true })
    );
    // Its verdict will then match.
    expect(hashContent(vi.mocked(submitTextModeration).mock.calls[0][0].content)).toBe(
      xguardHash(NEW)
    );
  });

  it('positive control: leaves one whose verdict is for its text alone', async () => {
    row = xguardVerdict(NEW);
    await reconcile();
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
  });
});

describe('a blocked verdict', () => {
  const block = async (judged: typeof OLD) => {
    row = xguardVerdict(judged, { blocked: true });
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      query: TemplateStringsArray | { sql: string }
    ) =>
      (Array.isArray(query) ? query.join('?') : (query as { sql: string }).sql).includes(
        'FOR UPDATE'
      )
        ? [{ status: ArticleStatus.Published, userId: AUTHOR, scheduledAt: null, metadata: {} }]
        : []) as never);
    await articleModerationAdapter.applyResult?.({
      entityId: ARTICLE,
      workflowId: 'wf-old',
      blocked: true,
      triggeredLabels: [],
      output: { blocked: true, triggeredLabels: [], results: [] } as never,
    });
  };
  const mismatchLogged = () =>
    loggingMock.logToAxiom.mock.calls.some(
      ([entry]) => (entry as { name?: string }).name === 'article-blocked-verdict-text-mismatch'
    );

  it('for text the article no longer has still unpublishes, and is logged', async () => {
    await block(OLD);
    expect(dbMock.dbWrite.article.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ArticleStatus.UnpublishedViolation }),
      })
    );
    expect(mismatchLogged()).toBe(true);
  });

  it('for its current text is not logged as a mismatch', async () => {
    await block(NEW);
    expect(mismatchLogged()).toBe(false);
  });
});
