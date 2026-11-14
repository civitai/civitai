import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const { load, submit } = vi.hoisted(() => ({
  load: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('~/server/services/text-scan/category', () => ({ submitTextCategoryScan: submit }));
vi.mock('~/server/services/text-scan/prompt', () => ({
  getTextScanConfig: async () => ({ model: 'm', maxInputChars: 4000 }),
}));
vi.mock('~/server/services/text-scan/submit', () => ({ textScanCallbackUrl: () => 'https://cb' }));
const hook = { tagType: 'article', write: vi.fn() };
vi.mock('~/server/services/text-scan/profiles', () => ({
  getTextScanProfile: () => ({ load, category: hook }),
}));

const { runArticleCategoryBackfill } = await import(
  '~/server/services/text-scan/article-category-backfill'
);

const queryRaw = dbMock.dbWrite.$queryRawUnsafe;
const subject = (notPublic = false) => ({ title: 't', content: 'c', notPublic });

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }]);
  load.mockResolvedValue(
    new Map([
      [5, subject()],
      [6, subject(true)],
      [8, subject()],
    ])
  );
});

describe('runArticleCategoryBackfill', () => {
  it('counts a submit that throws as failed and carries on', async () => {
    submit.mockRejectedValueOnce(new Error('orchestrator down')).mockResolvedValue('submitted');
    const result = await runArticleCategoryBackfill({
      afterId: 4,
      limit: 4,
      concurrency: 1,
      dryRun: false,
    });
    expect(result.byStatus).toEqual({ failed: 1, 'not-public': 1, gone: 1, submitted: 1 });
  });

  it('a dry run lists the selection and sends no category call', async () => {
    const result = await runArticleCategoryBackfill({
      afterId: 0,
      limit: 4,
      concurrency: 2,
      dryRun: true,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ selected: 4, nextAfterId: 8, byStatus: { 'dry-run': 4 } });
    expect(queryRaw).toHaveBeenCalledWith(expect.any(String), 0, 4);
  });

  it('sends one call per public article and counts each outcome, a failed submit included', async () => {
    submit.mockImplementation(async ({ entityId }: { entityId: number }) =>
      entityId === 8 ? 'failed' : 'submitted'
    );
    const result = await runArticleCategoryBackfill({
      afterId: 4,
      limit: 4,
      concurrency: 2,
      dryRun: false,
    });
    expect(submit.mock.calls.map(([arg]) => arg)).toEqual([
      expect.objectContaining({
        entityType: 'Article',
        entityId: 5,
        hook,
        model: 'm',
        maxInputChars: 4000,
        scanCallbackUrl: 'https://cb',
      }),
      expect.objectContaining({ entityId: 8 }),
    ]);
    expect(result.byStatus).toEqual({ submitted: 1, 'not-public': 1, gone: 1, failed: 1 });
    expect(result.nextAfterId).toBe(8);
  });
});
