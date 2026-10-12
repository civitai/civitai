import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as Cutover from '~/server/services/text-scan/clavata-cutover';

vi.mock('~/server/services/text-scan/clavata-cutover', async (importOriginal) => ({
  ...(await importOriginal<typeof Cutover>()),
  getTextScanOwnedClavataKeys: vi.fn(),
}));

const { getDisabledEntities } = await import('~/server/jobs/entity-moderation');
const { getTextScanOwnedClavataKeys } = await import('~/server/services/text-scan/clavata-cutover');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(redisMock.sysRedis.hGet).mockResolvedValue(
    JSON.stringify({ Post: false, Article: true }) as never
  );
});

describe('getDisabledEntities', () => {
  it('skips keys text scan owns, on top of the operator toggles', async () => {
    vi.mocked(getTextScanOwnedClavataKeys).mockResolvedValue(new Set(['Comment', 'Chat']));
    expect(await getDisabledEntities()).toEqual({
      Post: false,
      Article: true,
      Comment: false,
      Chat: false,
    });
  });

  it('runs every non-toggled key when text scan owns none (kill switch off, or not fully active)', async () => {
    vi.mocked(getTextScanOwnedClavataKeys).mockResolvedValue(new Set());
    expect(await getDisabledEntities()).toEqual({ Post: false, Article: true });
  });

  it('adds an owned key when no operator toggles are stored', async () => {
    vi.mocked(redisMock.sysRedis.hGet).mockResolvedValue(null as never);
    vi.mocked(getTextScanOwnedClavataKeys).mockResolvedValue(new Set(['Model']));
    expect(await getDisabledEntities()).toEqual({ Model: false });
  });
});
