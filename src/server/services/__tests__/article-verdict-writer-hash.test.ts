import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { useTxClients } from '~/__tests__/tx-client';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as TextScanRoute from '~/server/services/text-scan/route';

// The hash the XGuard writer stores is the one the recompute compares, with nothing between them
// mocked: the article edit, submitTextModeration and createXGuardModerationRequest all run.

const { submitWorkflow } = vi.hoisted(() => ({ submitWorkflow: vi.fn() }));

vi.mock('@civitai/orchestration-client', async () => ({
  ...(
    await import('~/server/services/orchestrator/__tests__/civitai-client.stub')
  ).civitaiClientStub(),
  submitWorkflow,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
// Route to XGuard, the writer under test; the route's mode choice is not.
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanRoute>()),
  submitTextModerationOrScan: vi.fn(async ({ xguard }: { xguard: () => Promise<unknown> }) =>
    xguard()
  ),
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { createNotification: vi.fn(async () => undefined) },
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

import {
  applyArticleContentChange,
  ARTICLE_TEXT_VERDICT_HASHED_SINCE,
  articleTextVerdictMatch,
} from '~/server/services/article.service';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';

const ARTICLE = 61;
const AUTHOR = 7;
const TITLE = 'Title';

/** The contentHash createXGuardModerationRequest wrote, or undefined if it wrote none. */
const storedHash = () =>
  (
    dbMock.dbWrite.entityModeration.upsert.mock.calls.at(-1)?.[0] as
      | { update: { contentHash?: string } }
      | undefined
  )?.update.contentHash;

/** Edit the article to `content` and return the verdict row its real writer leaves. */
async function writeVerdictFor(content: string) {
  await applyArticleContentChange({ id: ARTICLE, userId: AUTHOR, content });
  const contentHash = storedHash();
  expect(contentHash, 'the XGuard writer stored a hash').toEqual(expect.any(String));
  return {
    contentHash: contentHash!,
    result: { blocked: false, triggeredLabels: [], results: [] },
    updatedAt: new Date(ARTICLE_TEXT_VERDICT_HASHED_SINCE.getTime() + 24 * 60 * 60 * 1000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTxClients();
  let storedContent = '<p>Old body</p>';
  const articleRow = async () => ({
    userId: AUTHOR,
    title: TITLE,
    content: storedContent,
    coverId: null,
    bannerId: null,
    status: ArticleStatus.Published,
    scheduledAt: null,
    ingestion: ArticleIngestionStatus.Rescan,
    publishedAt: new Date('2026-11-01'),
    moderatorNsfwLevel: null,
  });
  dbMock.dbWrite.article.findUnique.mockImplementation(articleRow as never);
  dbMock.dbWrite.article.findUniqueOrThrow.mockImplementation(articleRow as never);
  dbMock.dbRead.article.findUnique.mockImplementation(articleRow as never);
  dbMock.dbWrite.accessToken.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.entityModeration.findUnique.mockResolvedValue(null as never);
  dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(null as never);
  dbMock.dbWrite.entityModeration.upsert.mockResolvedValue({} as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (strings[0].startsWith('UPDATE "Article" SET content')) storedContent = values[0] as string;
    return 1;
  }) as never);
  submitWorkflow.mockResolvedValue({
    data: { id: 'wf-new' },
    response: new Response(null),
    error: null,
  });
});

describe('the hash the XGuard writer stores for an article edit', () => {
  it('matches the text the article now has', async () => {
    const verdict = await writeVerdictFor('<p>New body</p>');
    expect(articleTextVerdictMatch(verdict, { title: TITLE, content: '<p>New body</p>' })).toBe(
      'current'
    );
  });

  it('positive control: a verdict the writer stored for other text does not match', async () => {
    const verdict = await writeVerdictFor('<p>Other body</p>');
    expect(articleTextVerdictMatch(verdict, { title: TITLE, content: '<p>New body</p>' })).toBe(
      'other'
    );
  });
});
