import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  isFlipt: vi.fn(),
  markExpiredDealFiles: vi.fn(),
  purgeRemovedFiles: vi.fn(),
  dropRemovedPreviewCopies: vi.fn(),
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: m.isFlipt,
  FLIPT_FEATURE_FLAGS: { SERVICE_DEAL_FILE_RETENTION: 'service-deal-file-retention' },
}));
vi.mock('~/server/services/creator-service-deal-file-retention', () => ({
  markExpiredDealFiles: m.markExpiredDealFiles,
}));
vi.mock('~/server/services/creator-service-deal-file.service', () => ({
  deleteScanCopies: vi.fn(),
  publishPreviews: vi.fn(),
  dropRemovedPreviewCopies: m.dropRemovedPreviewCopies,
  purgeRemovedFiles: m.purgeRemovedFiles,
  settlePreviewScans: vi.fn(),
  startPreviewScans: vi.fn(),
}));
vi.mock('~/server/services/creator-service-deal-repack.service', () => ({ repackFinals: vi.fn() }));
vi.mock('~/server/services/creator-service-deal-unpack.service', () => ({
  deleteEntryScanCopies: vi.fn(),
  settleEntryScans: vi.fn(),
  settleFinals: vi.fn(),
  settleMalwareScans: vi.fn(),
  unpackFinals: vi.fn(),
}));
// createJob wraps the handler in cron/lock machinery; the flag gate is what this file is about.
vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    run: fn,
  }),
}));

import { creatorServiceUnpackJob } from '../creator-service-deal-file-jobs';

const run = () =>
  (creatorServiceUnpackJob as unknown as { run: (ctx: unknown) => Promise<unknown> }).run({
    status: 'running',
    checkIfCanceled: () => undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.markExpiredDealFiles.mockResolvedValue(4);
  m.purgeRemovedFiles.mockResolvedValue(0);
  m.dropRemovedPreviewCopies.mockResolvedValue(3);
});

describe('deal-file retention kill switch', () => {
  it('starts no retention while the flag is off', async () => {
    m.isFlipt.mockResolvedValue(false);
    // A removed preview's public copy goes whatever the flag says.
    expect(await run()).toMatchObject({ retentionExpired: 0, previewCopiesDropped: 3 });
    expect(m.markExpiredDealFiles).not.toHaveBeenCalled();
    expect(m.isFlipt).toHaveBeenCalledWith('service-deal-file-retention');
  });

  it('marks expired deal files once the flag is on', async () => {
    m.isFlipt.mockResolvedValue(true);
    expect(await run()).toMatchObject({ retentionExpired: 4, previewCopiesDropped: 3 });
    expect(m.markExpiredDealFiles).toHaveBeenCalledOnce();
    // Marked this run, purged this run.
    expect(m.markExpiredDealFiles.mock.invocationCallOrder[0]).toBeLessThan(
      m.purgeRemovedFiles.mock.invocationCallOrder[0]
    );
  });
});
