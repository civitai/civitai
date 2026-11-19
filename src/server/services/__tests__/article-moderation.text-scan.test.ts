import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as RouteModule from '~/server/services/text-scan/route';

vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof RouteModule>()),
  submitTextModerationOrScan: vi.fn(),
}));
// Hand-listed: the real module pulls nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/rated-entities', () => ({
  applyRatingFloor: vi.fn(async () => ({ deferredRatingNotice: null })),
}));
// Hand-listed, as the existing adapter suites do: each real module drags in search-index or notifications.
vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/services/article.service', () => ({ recomputeArticleIngestion: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateArticleNsfwLevels: vi.fn() }));

const { articleModerationAdapter } = await import('~/server/services/article-moderation.adapter');
const { submitTextModerationOrScan } = await import('~/server/services/text-scan/route');
const { applyRatingFloor } = await import('~/server/services/text-scan/rated-entities');
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { recomputeArticleIngestion } = await import('~/server/services/article.service');
const { TEXT_SCAN_ENTITY_NOT_PUBLIC } = await import('~/server/services/text-scan/route');
const { createNotification } = await import('~/server/services/notification.service');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.article.findUnique.mockResolvedValue({ status: 'Published', scheduledAt: null });
});

describe('articleModerationAdapter — text scan', () => {
  it('routes submit, keeping the XGuard call as the off/shadow path', async () => {
    vi.mocked(submitTextModerationOrScan).mockImplementation(async ({ xguard }) => xguard());
    vi.mocked(submitTextModeration).mockResolvedValue({ id: 'xg' } as never);
    expect(await articleModerationAdapter.submit({ entityId: 4, content: 'T body' })).toEqual({
      id: 'xg',
    });
    expect(submitTextModerationOrScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Article', entityId: 4, fromRetry: true })
    );
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Article',
        entityId: 4,
        content: 'T body',
        labels: ['nsfw'],
      })
    );
    // A retry must count against the cap, not reset it.
    expect(vi.mocked(submitTextModeration).mock.calls[0][0]).not.toHaveProperty('rearmRetries');
  });

  it('parks a draft on retry without scanning it on either path', async () => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue({ status: 'Draft', scheduledAt: null });

    expect(await articleModerationAdapter.submit({ entityId: 4, content: 'T body' })).toBe(
      TEXT_SCAN_ENTITY_NOT_PUBLIC
    );
    expect(submitTextModerationOrScan).not.toHaveBeenCalled();
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it.each([
    ['submits', 'an active', { id: 'wf' }],
    ['parks', 'an expired', null],
  ])('%s a draft with %s share link on retry', async (_verb, state, expected) => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue({ status: 'Draft', scheduledAt: null });
    dbMock.dbWrite.accessToken.findMany.mockResolvedValueOnce([
      {
        resourceId: 4,
        resourceType: 'Article',
        revokedAt: null,
        expiresAt: new Date(Date.now() + (state === 'an active' ? 60_000 : -60_000)),
      },
    ] as never);
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf' });

    const result = await articleModerationAdapter.submit({ entityId: 4, content: 'T body' });
    if (expected) expect(result).toEqual(expected);
    else expect(result).toBe(TEXT_SCAN_ENTITY_NOT_PUBLIC);
  });

  it.each([
    ['processing', { status: 'Processing', scheduledAt: null }],
    ['scheduled', { status: 'Draft', scheduledAt: new Date('2099-01-01') }],
    // A deleted article is left to the route, which reports it gone so the cron drops the row.
    ['missing', null],
  ])('submits a %s article on retry', async (_name, row) => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue(row);
    vi.mocked(submitTextModerationOrScan).mockResolvedValue({ id: 'wf' });

    expect(await articleModerationAdapter.submit({ entityId: 4, content: 'T body' })).toEqual({
      id: 'wf',
    });
    expect(submitTextModerationOrScan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entityType: 'Article', entityId: 4, fromRetry: true })
    );
  });

  it('applies the floor, then advances ingestion', async () => {
    const args = {
      entityId: 4,
      workflowId: 'wf',
      outcome: { triggeredLabels: [], nsfwLevel: 4 },
      subject: { fields: [], declared: {} },
    };
    await articleModerationAdapter.applyTextScan!(args as never);
    expect(applyRatingFloor).toHaveBeenCalledWith('Article', args);
    expect(recomputeArticleIngestion).toHaveBeenCalledWith(4);
    expect(vi.mocked(applyRatingFloor).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recomputeArticleIngestion).mock.invocationCallOrder[0]
    );
  });
});

describe('articleModerationAdapter — a block', () => {
  type Row = { status: string; userId: number; scheduledAt?: Date | null; metadata: object | null };
  // A transaction client distinct from dbWrite, so a call made outside the transaction cannot
  // pass for one made inside it.
  const block = async (row: Row) => {
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => [{ scheduledAt: null, ...row }]),
      article: { update: vi.fn(async () => ({})) },
      accessToken: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    dbMock.dbWrite.$transaction.mockImplementationOnce((async (fn: (c: unknown) => unknown) =>
      fn(tx)) as never);
    await articleModerationAdapter.applyResult!({
      entityId: 4,
      blocked: true,
      triggeredLabels: [],
    } as never);
    return tx;
  };
  const revoked = {
    where: { resourceType: 'Article', resourceId: 4, revokedAt: null },
    data: { revokedAt: expect.any(Date) },
  };
  const written = (tx: Awaited<ReturnType<typeof block>>) =>
    (tx.article.update.mock.calls[0] as unknown as [{ data: unknown }])[0].data;

  // A shared draft is scanned, so it can be blocked. The status it had lets a moderator's restore
  // return it to its author instead of publishing it, and its links end with the block.
  it('takes a shared draft down with its links in one transaction, recording its status', async () => {
    const tx = await block({ status: 'Draft', userId: 9, metadata: { theme: 'x' } });
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual([0x41544b, 4]);
    // The row is read under the share-link lock, and locked for the write.
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]
    );
    expect((tx.$queryRaw.mock.calls[0] as unknown as [string[]])[0].join('?')).toMatch(
      /FOR UPDATE$/
    );
    expect(tx.article.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: {
        status: 'UnpublishedViolation',
        metadata: { theme: 'x', statusBeforeViolation: 'Draft' },
      },
    });
    expect(tx.accessToken.updateMany).toHaveBeenCalledWith(revoked);
    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.accessToken.updateMany).not.toHaveBeenCalled();
  });

  it('tells no author of an article they had not sent live that it was unpublished', async () => {
    await block({ status: 'Draft', userId: 9, metadata: null });
    await block({ status: 'Unpublished', userId: 9, metadata: null });
    expect(createNotification).not.toHaveBeenCalled();
  });

  // Scheduling is the author asking for it to go live, so it is a publish taken down, as before
  // share links: the author is told, and a restore publishes it.
  // A published one restores by its publishedAt. A scheduled one returns to Draft, keeping its
  // schedule, so the go-live job publishes it.
  it.each([
    ['published', { status: 'Published' }, {}],
    [
      'scheduled',
      { status: 'Draft', scheduledAt: new Date('2027-01-01') },
      { statusBeforeViolation: 'Draft' },
    ],
  ])(
    'tells the author of a %s article, and records where a restore returns it',
    async (_, row, metadata) => {
      const tx = await block({ userId: 9, metadata: { statusBeforeViolation: 'Draft' }, ...row });
      // A status an earlier block left goes too, or the next restore would unpublish it.
      expect(written(tx)).toEqual({ status: 'UnpublishedViolation', metadata });
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }));
    }
  );
});
