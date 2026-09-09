import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as Models from '~/server/services/orchestrator/models';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as AssertOwner from '~/server/services/orchestrator/assert-workflow-owner';

const queryResources = vi.fn();
const getModelClient = vi.fn();
const submitWorkflow = vi.fn();
const assertWorkflowOwner = vi.fn();

vi.mock('~/server/services/orchestrator/models', async (importOriginal) => ({
  ...(await importOriginal<typeof Models>()),
  getModelClient: (...args: unknown[]) => getModelClient(...args),
  queryResourcesClient: (...args: unknown[]) => queryResources(...args),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
}));
vi.mock('~/server/services/orchestrator/assert-workflow-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof AssertOwner>()),
  assertWorkflowOwner: (...args: unknown[]) => assertWorkflowOwner(...args),
}));

import { Air } from '@civitai/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  estimateResourceLoad,
  getResourceLoadQueue,
  getResourceLoadState,
  submitResourceLoad,
} from '~/server/services/resource-load.service';

const version = {
  id: 501,
  name: 'v1',
  baseModel: 'SDXL 1.0',
  flags: 0,
  model: { id: 42, name: 'Test Model', type: 'LORA' },
  files: [{ type: 'Model', scannedAt: new Date(), metadata: { format: 'SafeTensor' } }],
};

const versionAir = 'urn:air:sdxl:lora:civitai:42@501';

/**
 * The global `@civitai/client` stub returns `''` from `Air.stringify` and has no `parseSafe` at all,
 * so the queue's AIR -> version mapping needs a real round-trip here.
 */
function installAirCodec() {
  const air = Air as unknown as Record<string, unknown>;
  air.stringify = ({ ecosystem, type, source, id, version }: Record<string, string>) =>
    `urn:air:${ecosystem}:${type}:${source}:${id}@${version}`;
  air.parseSafe = (identifier: string) => {
    const match = /^urn:air:([^:]+):([^:]+):([^:]+):(\d+)@(\d+)$/.exec(identifier);
    if (!match) return null;
    const [, ecosystem, type, source, id, version] = match;
    return { ecosystem, type, source, id, version };
  };
}

function orchestratorReturns(availability: unknown, size = 1024) {
  getModelClient.mockResolvedValue({ data: { air: versionAir, size, availability } });
}

beforeEach(() => {
  vi.clearAllMocks();
  installAirCodec();
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([version]);
  // The GenerationCoverageNext lookup — covered by default.
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ modelVersionId: 501 }]);
});

describe('getResourceLoadState', () => {
  it('asks the orchestrator for the AIR built from the version and its primary file', async () => {
    orchestratorReturns({ status: 'available', workers: 2 });

    const [state] = await getResourceLoadState([501]);

    expect(getModelClient).toHaveBeenCalledWith(expect.objectContaining({ air: versionAir }));
    expect(state).toMatchObject({ modelVersionId: 501, modelId: 42, air: versionAir, size: 1024 });
    expect(state.availability).toEqual({ status: 'available', workers: 2 });
  });

  it('keeps queuePosition, which lives on `unavailable` and not on `loading`', async () => {
    orchestratorReturns({ status: 'unavailable', queuePosition: 7 });

    const [state] = await getResourceLoadState([501]);

    expect(state.availability).toEqual({ status: 'unavailable', queuePosition: 7 });
  });

  it('reports a status this build does not know as `unknown` rather than guessing', async () => {
    orchestratorReturns({ status: 'evicting', someNewField: 1 });

    const [state] = await getResourceLoadState([501]);

    expect(state.availability).toEqual({ status: 'unknown' });
  });

  it('reports `unknown` when the orchestrator returns no data at all', async () => {
    getModelClient.mockResolvedValue({ data: undefined, error: { status: 500 } });

    const [state] = await getResourceLoadState([501]);

    expect(state.availability).toEqual({ status: 'unknown' });
  });
});

describe('getResourceLoadQueue', () => {
  it('drops rows whose AIR does not resolve to a model version on this site', async () => {
    queryResources.mockResolvedValue({
      data: {
        next: 'cursor-2',
        items: [
          {
            air: versionAir,
            size: 1024,
            availability: { status: 'loading', progress: 0.5, workers: 1 },
          },
          {
            air: 'urn:air:sdxl:lora:civitai:99@999',
            size: 2048,
            availability: { status: 'unavailable', queuePosition: 2 },
          },
          { air: 'not-an-air', size: 1, availability: { status: 'unavailable' } },
        ],
      },
    });

    const result = await getResourceLoadQueue({ take: 50 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ modelVersionId: 501, modelName: 'Test Model' });
    expect(result.nextCursor).toBe('cursor-2');
  });
});

describe('the purchase path refuses before it submits', () => {
  it.each([
    ['unsupported', { status: 'unsupported' }],
    ['already resident', { status: 'available', workers: 3 }],
    ['unreadable', { status: 'who-knows' }],
  ])('refuses a %s resource without submitting', async (_label, availability) => {
    orchestratorReturns(availability);

    await expect(
      submitResourceLoad({ modelVersionId: 501, userId: 7, token: 'user-token', currencies: [] })
    ).rejects.toThrow();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a resource the site cannot generate with, whatever the cluster says', async () => {
    orchestratorReturns({ status: 'unavailable', queuePosition: null });
    dbMock.dbRead.$queryRaw.mockResolvedValue([]); // not in GenerationCoverageNext

    await expect(
      submitResourceLoad({ modelVersionId: 501, userId: 7, token: 'user-token', currencies: [] })
    ).rejects.toThrow(/cannot be generated with/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a resource with no weight file — an external API model', async () => {
    orchestratorReturns({ status: 'unavailable', queuePosition: null });
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      {
        ...version,
        // What the 36 mislabelled API versions carried: an archive, not weights.
        files: [{ type: 'Training Data', scannedAt: new Date(), metadata: { format: 'Other' } }],
      },
    ]);

    await expect(
      submitResourceLoad({ modelVersionId: 501, userId: 7, token: 'user-token', currencies: [] })
    ).rejects.toThrow(/no model file to load/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an unscanned file — scanning is what makes a weight servable', async () => {
    orchestratorReturns({ status: 'unavailable', queuePosition: null });
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      {
        ...version,
        files: [{ type: 'Model', scannedAt: null, metadata: { format: 'SafeTensor' } }],
      },
    ]);

    await expect(
      submitResourceLoad({ modelVersionId: 501, userId: 7, token: 'user-token', currencies: [] })
    ).rejects.toThrow(/no model file to load/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a version that does not exist', async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);

    await expect(
      submitResourceLoad({ modelVersionId: 404, userId: 7, token: 'user-token', currencies: [] })
    ).rejects.toThrow();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});

describe('submitResourceLoad', () => {
  beforeEach(() => {
    orchestratorReturns({ status: 'unavailable', queuePosition: null });
    submitWorkflow.mockResolvedValue({ id: '7-123', status: 'scheduled', cost: { total: 0 } });
  });

  it('submits a prepareResource step for the version AIR under the user token', async () => {
    await submitResourceLoad({
      modelVersionId: 501,
      userId: 7,
      token: 'user-token',
      currencies: [],
    });

    const [args] = submitWorkflow.mock.calls[0];
    expect(args.token).toBe('user-token');
    expect(args.query?.whatif).toBeUndefined();
    expect(args.body.steps).toEqual([
      { $type: 'prepareResource', name: 'prepare-resource', input: { resource: versionAir } },
    ]);
  });

  it('sends progress to the buyer, not to a model-version topic', async () => {
    // The payload carries workflowId, which the orchestrator names `<userId>-<timestamp>`. A group
    // broadcast would tell everyone watching the model version who paid for the load.
    await submitResourceLoad({
      modelVersionId: 501,
      userId: 7,
      token: 'user-token',
      currencies: [],
    });

    const [args] = submitWorkflow.mock.calls[0];
    const urls = (args.body.callbacks ?? []).map((c: { url: string }) => c.url);
    expect(urls.join(' ')).toContain('/users/7/signals/');
    expect(urls.join(' ')).not.toContain('/groups/');
  });

  it('checks who the orchestrator attributed the workflow to', async () => {
    await submitResourceLoad({
      modelVersionId: 501,
      userId: 7,
      token: 'user-token',
      currencies: [],
    });

    expect(assertWorkflowOwner).toHaveBeenCalledWith(
      expect.objectContaining({ id: '7-123' }),
      7,
      'user-token'
    );
  });

  it('propagates a mis-attribution instead of reporting a queued load', async () => {
    assertWorkflowOwner.mockRejectedValue(new Error('consumer mismatch'));

    await expect(
      submitResourceLoad({ modelVersionId: 501, userId: 7, token: 'user-token', currencies: [] })
    ).rejects.toThrow('consumer mismatch');
  });
});

describe('estimateResourceLoad', () => {
  beforeEach(() => {
    orchestratorReturns({ status: 'unavailable', queuePosition: null });
  });

  it('estimates side-effect-free, and reports an unpriced zero as unpriced', async () => {
    submitWorkflow.mockResolvedValue({ id: '7-123', cost: { total: 0 } });

    const result = await estimateResourceLoad({
      modelVersionId: 501,
      token: 'user-token',
      currencies: [],
    });

    expect(submitWorkflow.mock.calls[0][0].query).toEqual({ whatif: true });
    expect(result).toMatchObject({ cost: 0, priced: false });
  });

  it('reports a real quote as priced', async () => {
    submitWorkflow.mockResolvedValue({ id: '7-123', cost: { total: 250 } });

    const result = await estimateResourceLoad({
      modelVersionId: 501,
      token: 'user-token',
      currencies: [],
    });

    expect(result).toMatchObject({ cost: 250, priced: true });
  });
});
