import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

import { applyArticleContentChange } from '~/server/services/article.service';
import '~/server/services/text-scan/profiles/article.profile';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  EntityModerationStatus,
} from '~/shared/utils/prisma/enums';

const ARTICLE = 31;
const AUTHOR = 7;

type ModerationRow = {
  status: EntityModerationStatus;
  blocked: boolean | null;
  workflowId: string | null;
} | null;
/** The article's text-moderation row, as the recompute reads it. */
let moderation: ModerationRow;
/** The stored body, as the content write leaves it. */
let storedContent: string;

const editTo = (content: string) =>
  applyArticleContentChange({ id: ARTICLE, userId: AUTHOR, content });

/** The ingestion the recompute wrote, or undefined if it never ran. */
const writtenIngestion = () => {
  const written = dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values))
    .filter((sql) => sql.sql.includes('SET ingestion ='));
  return written.at(-1)?.values[0];
};

/** The statement that wrote the new text. */
const contentWrite = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]) => Prisma.sql(strings as TemplateStringsArray, ...values).sql)
    .find((sql) => sql.startsWith('UPDATE "Article" SET content'));

/** What the orchestrator submit does on success: the row is Pending for the new text. */
const submitRecordsPending = async () => {
  moderation = { status: EntityModerationStatus.Pending, blocked: null, workflowId: 'wf-new' };
  return { id: 'wf-new' };
};

beforeEach(() => {
  vi.clearAllMocks();
  useTxClients();
  // Live, clean, already Scanned, with a passing verdict for the text before this edit.
  moderation = { status: EntityModerationStatus.Succeeded, blocked: false, workflowId: 'wf-old' };
  const stored = {
    userId: AUTHOR,
    title: 'Title',
    content: '<p>Old body</p>',
    coverId: null,
    bannerId: null,
    status: ArticleStatus.Published,
    scheduledAt: null,
  };
  storedContent = stored.content;
  dbMock.dbWrite.article.findUnique.mockImplementation((async () => ({
    ...stored,
    content: storedContent,
  })) as never);
  dbMock.dbWrite.article.findUniqueOrThrow.mockImplementation((async () => ({
    ...stored,
    content: '<p>New body</p>',
    ingestion: ArticleIngestionStatus.Scanned,
    publishedAt: new Date('2026-11-01'),
    moderatorNsfwLevel: null,
  })) as never);
  dbMock.dbWrite.accessToken.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => moderation) as never);
  dbMock.dbWrite.entityModeration.updateMany.mockImplementation((async ({ data }: never) => {
    const { status, workflowId } = data as Partial<NonNullable<ModerationRow>>;
    if (moderation && status) moderation = { ...moderation, status };
    if (moderation && workflowId !== undefined) moderation = { ...moderation, workflowId };
    return { count: moderation ? 1 : 0 };
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...values);
    if (sql.sql.startsWith('UPDATE "Article" SET content')) storedContent = sql.values[0] as string;
    return 1;
  }) as never);
});

describe('editing the text of a published article', () => {
  it('positive control: the recompute runs and an unchanged verdict keeps it Scanned', async () => {
    // A metadata-only save: the dedup cache returns without touching the row.
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf-old' });
    await editTo('<p>New body</p>');
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
  });

  it('stays out of Scanned until the verdict for the new text lands', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(submitRecordsPending()), 10))
    );
    await editTo('<p>New body</p>');
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it('stays out of Scanned when the submit throws before recording anything', async () => {
    vi.mocked(submitTextModerationOrScan).mockRejectedValue(new Error('scan mode read failed'));
    await editTo('<p>New body</p>');
    // Cleared hash and retries, or the retry cron could skip the held row.
    expect(dbMock.dbWrite.entityModeration.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'Article', entityId: ARTICLE },
      data: {
        status: EntityModerationStatus.Pending,
        workflowId: null,
        contentHash: null,
        retryCount: 0,
      },
    });
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it('stays out of Scanned when the submit returns but its row write was lost', async () => {
    // createXGuardModerationRequest logs a failed row write instead of throwing.
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf-new' });
    await editTo('<p>New body</p>');
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it.each(['missing-prompt', 'no-profile'] as const)(
    'stays out of Scanned when the active scan skips with %s',
    async (reason) => {
      vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ onActiveSkip }) => {
        await onActiveSkip?.(reason);
        return null;
      });
      await editTo('<p>New body</p>');
      expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
    }
  );

  it('stays Scanned when the active scan skips because the text is unchanged', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ onActiveSkip }) => {
      await onActiveSkip?.('unchanged');
      return null;
    });
    await editTo('<p>New body</p>');
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
  });

  it('keeps its verdict off the row when a later save of other text recorded first', async () => {
    // This save's upsert lands last, so the row carries its workflow, while the stored text is
    // the other save's, which this verdict never saw.
    vi.mocked(submitTextModerationOrScan).mockImplementation(async () => {
      storedContent = '<p>Other text</p>';
      return submitRecordsPending();
    });
    await editTo('<p>New body</p>');
    // Callbacks record only on a matching workflowId, so 'wf-new' can no longer land.
    expect(moderation).toMatchObject({ status: EntityModerationStatus.Pending, workflowId: null });
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
  });

  it('is already out of Scanned when the hold write fails after the text is written', async () => {
    vi.mocked(submitTextModerationOrScan).mockResolvedValue(null);
    dbMock.dbWrite.entityModeration.updateMany.mockRejectedValue(new Error('db unavailable'));
    await expect(editTo('<p>New body</p>')).rejects.toThrow('db unavailable');
    // The recompute never ran; the write that changed the text took it out of Scanned.
    expect(writtenIngestion()).toBeUndefined();
    expect(contentWrite()).toContain(`ingestion = 'Rescan'`);
  });

  it('leaves Scanned in the same write only when the text changes', async () => {
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf-old' });
    await editTo('<p>Old body</p>');
    expect(contentWrite()).not.toContain('ingestion');
  });

  it('stays out of Scanned when the submit hangs, and the save still returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(submitTextModerationOrScan).mockReturnValue(new Promise(() => undefined));
      const saving = editTo('<p>New body</p>');
      await vi.advanceTimersByTimeAsync(10_000);
      await saving;
      expect(writtenIngestion()).toBe(ArticleIngestionStatus.Pending);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('text too short to scan', () => {
  it('is only ever empty text for an article, which the save handles without a scan', () => {
    // An edit that empties the text drops the moderation row (`articleHasText` false), so it
    // derives what a new empty article derives. A minimum above one character would open a third
    // case: text with no scan and no row cleared, keeping the verdict for the older text.
    const profile = getTextScanProfile('Article');
    expect(profile).toBeDefined();
    expect(profile?.minChars ?? 1).toBeLessThanOrEqual(1);
  });

  it.each([
    [
      'an edit from text that was blocked',
      { status: EntityModerationStatus.Succeeded, blocked: true, workflowId: 'wf-old' },
    ],
    ['a new article', null],
  ])('%s, saved with no text, derives Scanned without a scan', async (_name, row) => {
    moderation = row;
    dbMock.dbWrite.entityModeration.deleteMany.mockImplementation((async () => {
      moderation = null;
      return { count: 1 };
    }) as never);
    dbMock.dbWrite.article.findUnique.mockResolvedValue({
      userId: AUTHOR,
      title: '',
      content: '<p>Old body</p>',
      coverId: null,
      bannerId: null,
      status: ArticleStatus.Published,
      scheduledAt: null,
    } as never);
    dbMock.dbWrite.article.findUniqueOrThrow.mockImplementation((async () => ({
      userId: AUTHOR,
      title: '',
      content: '<p> </p>',
      coverId: null,
      bannerId: null,
      status: ArticleStatus.Published,
      ingestion: row ? ArticleIngestionStatus.Blocked : ArticleIngestionStatus.Pending,
      publishedAt: new Date('2026-11-01'),
      moderatorNsfwLevel: null,
    })) as never);
    await editTo('<p> </p>');
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
    expect(writtenIngestion()).toBe(ArticleIngestionStatus.Scanned);
  });
});
