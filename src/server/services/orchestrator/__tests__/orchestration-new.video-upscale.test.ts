import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationCtx } from '~/shared/generation/context';
import type * as GenerationInputUrls from '~/server/services/generation-input-urls';

vi.mock('@civitai/orchestration-client', async () =>
  (await import('./civitai-client.stub')).civitaiClientStub()
);

const { submitWorkflow } = vi.hoisted(() => ({
  submitWorkflow: vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
    id: '1-20260101000000000',
    status: 'succeeded',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    steps: [],
    cost: { total: 32 },
    transactions: { list: [] },
    metadata: body.metadata,
  })),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow,
  deleteWorkflow: vi.fn(),
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationInputUrls>()),
  assertGenerationInputsUsable: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
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
  getSelfHostedDisabledEcosystems: vi.fn(() => []),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import {
  generateFromGraph,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';

const externalCtx: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};
const common = { externalCtx, userId: 1, isModerator: false, token: 'test', experimental: false };
const video = {
  url: 'https://example.com/video.mp4',
  metadata: { width: 640, height: 360, fps: 24, duration: 5 },
};

beforeEach(() => vi.clearAllMocks());

describe.each([
  ['quote', whatIfFromGraph],
  ['submit', generateFromGraph],
] as const)('video upscale %s', (_name, run) => {
  it.each([
    [undefined, undefined, 'relayvsr', 2],
    ['relayvsr', 4, 'relayvsr', 4],
    ['flashvsr', 2, 'flashvsr', 2],
    ['flashvsr', 3, 'flashvsr', 3],
    ['unknown', 2, 'relayvsr', 2],
  ] as const)(
    'sends model %s and scale %s to the orchestrator',
    async (model, scale, expectedModel, expectedScale) => {
      await run({
        ...common,
        input: { workflow: 'vid2vid:upscale', video, videoUpscaler: model, scaleFactor: scale },
      });
      expect(submitWorkflow).toHaveBeenCalledOnce();
      expect(submitWorkflow.mock.calls[0][0].body.steps).toEqual([
        expect.objectContaining({
          $type: 'videoUpscaler',
          input: { video: video.url, model: expectedModel, scaleFactor: expectedScale },
        }),
      ]);
    }
  );

  it.each([
    { videoUpscaler: 'relayvsr', scaleFactor: 3 },
    {
      videoUpscaler: 'relayvsr',
      scaleFactor: 4,
      video: { ...video, metadata: { ...video.metadata, width: 1280 } },
    },
  ])('refuses an unsupported request before contacting the orchestrator: %j', async (invalid) => {
    await expect(
      run({ ...common, input: { workflow: 'vid2vid:upscale', video, ...invalid } })
    ).rejects.toThrow('Validation failed');
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});
