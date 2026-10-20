import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as ImageService from '~/server/services/image.service';
import type * as SignalClient from '~/utils/signal-client';
import type * as S3Utils from '~/utils/s3-utils';
import type * as StorageResolver from '~/server/services/storage-resolver';

/**
 * The orchestrator can report a workflow succeeded before rating its outputs. Ready and saved
 * candidates are never re-checked, so these routes must wait for the rating.
 */

const mocks = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  updateWorkflow: vi.fn(async (..._a: unknown[]) => undefined),
  formatGenerationResponse2: vi.fn(),
  createImage: vi.fn(async (..._a: unknown[]) => ({ id: 900 })),
  createImageResources: vi.fn(async (..._a: unknown[]) => undefined),
  s3Send: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'token',
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: mocks.getWorkflow,
  updateWorkflow: mocks.updateWorkflow,
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNew>()),
  formatGenerationResponse2: mocks.formatGenerationResponse2,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  createImage: mocks.createImage,
  createImageResources: mocks.createImageResources,
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mocks.s3Send },
    bucket: 'bucket',
    backend: 'test',
  }),
}));
vi.mock('~/server/services/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  registerMediaLocation: vi.fn(),
}));
vi.mock('~/utils/signal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalClient>()),
  signalClient: { send: vi.fn(async () => undefined) },
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NSFW_CAPPED, NSFW_CAPPED_MESSAGE } from '~/shared/orchestrator/workflow-data';

const USER_ID = 7;
const PANEL_ID = 21;

function fakeCtx() {
  return {
    user: {
      id: USER_ID,
      isModerator: false,
      onboarding: OnboardingSteps.Buzz,
      muted: false,
      showNsfw: true,
    },
    domain: 'red',
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true } as never,
    req: undefined,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    track: {} as never,
    ip: '127.0.0.1',
    fingerprint: 'test' as never,
  };
}

const caller = () => comicsRouter.createCaller(fakeCtx() as never);

const output = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'image',
  id,
  url: `https://orchestrator.test/${id}.jpeg`,
  available: true,
  ...over,
});

function givenWorkflow(
  outputs: Array<Record<string, unknown>>,
  normalized: Record<string, unknown> = {}
) {
  // The raw read the unlock guard checks: still locked, with an output rated mature.
  mocks.getWorkflow.mockResolvedValue({
    id: 'wf-1',
    status: 'succeeded',
    allowMatureContent: false,
    steps: [{ $type: 'comfy', name: '$0', output: { blobs: [output('b0', { nsfwLevel: 'x' })] } }],
  });
  mocks.formatGenerationResponse2.mockResolvedValue([
    {
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: false,
      metadata: {},
      ...normalized,
      steps: [
        {
          $type: 'comfy',
          name: '$0',
          status: 'succeeded',
          metadata: {},
          output: outputs,
        },
      ],
    },
  ]);
}

function givenPanel(over: Record<string, unknown> = {}) {
  const panel = {
    id: PANEL_ID,
    projectId: 11,
    workflowId: 'wf-1',
    status: 'Generating',
    imageUrl: null,
    errorMessage: null,
    prompt: 'a panel',
    metadata: { quantity: 1 },
    chapter: { project: { userId: USER_ID } },
    ...over,
  };
  dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(panel);
  dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(panel);
}

const writes = () =>
  dbMock.dbWrite.comicPanel.update.mock.calls.map(
    (call: Array<{ data: Record<string, unknown> }>) => call[0].data
  );

beforeEach(() => {
  vi.clearAllMocks();
  // The poll catches and logs any throw, then returns the panel unchanged: the same result as the
  // hold. Every case asserts nothing was logged, so a broken fixture cannot pass as a held output.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
  );
  dbMock.dbWrite.comicPanel.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: PANEL_ID,
      projectId: 11,
      imageUrl: null,
      errorMessage: null,
      ...data,
    })
  );
});

describe('comics.pollPanelStatus - an output that has not been rated yet', () => {
  it('leaves a single-image panel as it was', async () => {
    givenPanel();
    givenWorkflow([output('b1')]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('Generating');
    expect(writes()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(mocks.formatGenerationResponse2).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('completes the same panel once the output is rated', async () => {
    givenPanel();
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('Ready');
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  it('saves no candidate of a multi-image panel while one output is unrated', async () => {
    givenPanel({ metadata: { quantity: 2 } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2')]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('Generating');
    expect(writes()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.formatGenerationResponse2).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('saves the candidates once every output is rated', async () => {
    givenPanel({ metadata: { quantity: 2 } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2', { nsfwLevel: 'pg' })]);

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result.status).toBe('AwaitingSelection');
    const [data] = writes();
    expect((data.metadata as { candidateImages: unknown[] }).candidateImages).toHaveLength(2);
  });
});

describe('comics.pollPanelStatus - an output above the workflow cap', () => {
  it('marks a single-image panel capped, so the card offers no unlock', async () => {
    givenPanel();
    givenWorkflow([output('b1', { nsfwLevel: 'r' })], { nsfwCap: 'pg13' });

    const result = await caller().pollPanelStatus({ panelId: PANEL_ID });

    expect(result).toMatchObject({
      status: 'RequireUnlock',
      blockedReason: NSFW_CAPPED,
      errorMessage: NSFW_CAPPED_MESSAGE,
    });
    const [data] = writes();
    expect(data.metadata).toMatchObject({ blockedReason: NSFW_CAPPED });
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('comics.unlockPanelGeneration - an output that has not been rated yet', () => {
  it('sends a single-image panel back to the poll instead of keeping the output', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow([output('b1')]);

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(result.status).toBe('Generating');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(mocks.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', allowMatureContent: true, throwOnError: true })
    );
    const [data] = writes();
    expect(data.status).toBe('Generating');
    expect(data.metadata).not.toHaveProperty('blockedReason');
  });

  it('completes a single-image panel when the unlocked output is rated', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' })]);

    const result = await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    expect(result.status).toBe('Ready');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
  });

  it('refuses, charging nothing, when the workflow cap blocks every mature output', async () => {
    givenPanel({ status: 'RequireUnlock', metadata: { quantity: 1, blockedReason: 'canUpgrade' } });
    mocks.getWorkflow.mockResolvedValue({
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: false,
      nsfwLevel: 'pg13',
      steps: [
        { $type: 'comfy', name: '$0', output: { blobs: [output('b1', { nsfwLevel: 'r' })] } },
      ],
    });

    await expect(caller().unlockPanelGeneration({ panelId: PANEL_ID })).rejects.toThrow(/PG-13/);
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('keeps an unrated candidate locked instead of saving it as clean', async () => {
    givenPanel({
      status: 'AwaitingSelection',
      metadata: {
        quantity: 2,
        candidateImages: [
          { requiresUnlock: true, blockedReason: 'canUpgrade' },
          { requiresUnlock: true, blockedReason: 'canUpgrade' },
        ],
      },
    });
    givenWorkflow([output('b1', { nsfwLevel: 'pg' }), output('b2')]);

    await caller().unlockPanelGeneration({ panelId: PANEL_ID });

    const [data] = writes();
    const candidates = (data.metadata as { candidateImages: Array<Record<string, unknown>> })
      .candidateImages;
    expect(candidates[0]).toHaveProperty('key');
    expect(candidates[1]).toMatchObject({ requiresUnlock: true });
    expect(candidates[1]).not.toHaveProperty('key');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
  });
});
