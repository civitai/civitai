import { describe, expect, it, vi } from 'vitest';

/**
 * A step type missing from `normalizeStepOutput` returns no items, so its output
 * never reaches the queue — the workflow succeeds and the user sees nothing.
 * There is no type error and no runtime error; the only symptom is an empty
 * result, which is how vid2vid:preprocess first shipped.
 *
 * Mock preamble mirrors `orchestration-new.shadow-tap.test.ts`: it only keeps
 * the heavy DB/redis module graph inert so the module imports.
 */
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

const VIDEO_BLOB = { id: 'blob-1', url: 'https://x/control.mp4', available: true };

async function normalize(step: Record<string, unknown>) {
  const { normalizeStepOutput } = await import('../orchestration-new.service');
  return normalizeStepOutput(step as never);
}

describe('normalizeStepOutput — preprocessVideo', () => {
  it('surfaces the control map as a video output', async () => {
    const result = await normalize({
      $type: 'preprocessVideo',
      output: { blob: VIDEO_BLOB },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ...VIDEO_BLOB, type: 'video' });
  });

  it('returns nothing when the step has no output yet', async () => {
    expect(await normalize({ $type: 'preprocessVideo', output: undefined })).toEqual([]);
    expect(await normalize({ $type: 'preprocessVideo', output: {} })).toEqual([]);
  });

  // Guards the case that produced the bug: the image sibling was handled and the
  // video one silently fell through the switch to [].
  it('classifies preprocessImage as image, not video', async () => {
    const result = await normalize({
      $type: 'preprocessImage',
      output: { blob: { id: 'b', url: 'https://x/a.png', available: true } },
    });

    expect(result[0]).toMatchObject({ type: 'image' });
  });
});
