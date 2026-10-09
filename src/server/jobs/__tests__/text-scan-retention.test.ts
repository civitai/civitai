import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as JobModule from '~/server/jobs/job';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as RetentionModule from '~/server/services/text-scan/retention';

vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof JobModule>()),
  createJob: (name: string, cron: string, fn: (ctx: never) => Promise<unknown>) => ({
    name,
    cron,
    run: () => ({ result: fn({} as never), cancel: async () => undefined }),
    options: {},
  }),
}));
vi.mock('~/server/services/text-scan/retention', async (importOriginal) => ({
  ...(await importOriginal<typeof RetentionModule>()),
  cleanupTextScanRows: vi.fn(),
}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));

const { textScanRetention } = await import('~/server/jobs/text-scan-retention');
const { cleanupTextScanRows } = await import('~/server/services/text-scan/retention');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');

const shadowRows: Record<string, number[]> = { 'Post:shadow': [9, 8], 'Comment:shadow': [5, 4] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbRead.entityModeration.findMany).mockImplementation((async (args: {
    where: { entityType: string };
  }) => (shadowRows[args.where.entityType] ?? []).map((entityId) => ({ entityId }))) as never);
  vi.mocked(cleanupTextScanRows).mockResolvedValue({
    shadowDeleted: 4,
    cleanDeleted: 7,
    exhausted: false,
  });
});

describe('text-scan-retention', () => {
  it('is a daily job with a real cron', () => {
    expect(textScanRetention.name).toBe('text-scan-retention');
    expect(textScanRetention.cron.split(' ')).toHaveLength(5);
  });

  it('graduates only entity types whose probed shadow ids are all active', async () => {
    vi.mocked(getTextScanMode).mockImplementation(async (entityType, id) =>
      entityType === 'Post' || id === 5 ? 'active' : 'shadow'
    );
    await expect(textScanRetention.run().result).resolves.toMatchObject({
      graduated: ['Post'],
      shadowDeleted: 4,
      cleanDeleted: 7,
    });
    expect(cleanupTextScanRows).toHaveBeenCalledWith({
      graduatedEntityTypes: ['Post'],
      olderThanDays: 30,
    });
  });

  it('still sweeps clean rows when nothing has graduated', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('shadow');
    await textScanRetention.run().result;
    expect(cleanupTextScanRows).toHaveBeenCalledWith({
      graduatedEntityTypes: [],
      olderThanDays: 30,
    });
  });

  it('lets a helper failure surface to the job runner', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(cleanupTextScanRows).mockRejectedValue(new Error('boom'));
    await expect(textScanRetention.run().result).rejects.toThrow('boom');
  });
});
