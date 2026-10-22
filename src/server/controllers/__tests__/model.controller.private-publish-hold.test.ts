import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as Caches from '~/server/redis/caches';
import type * as SearchIndex from '~/server/search-index';

const {
  mockPublishPrivateModel,
  mockPublishModelById,
  mockReindex,
  mockScan,
  mockGetModel,
  mockBustMvCache,
  mockQueueUpdate,
  mockRefresh,
} = vi.hoisted(() => ({
  mockPublishPrivateModel: vi.fn(),
  mockPublishModelById: vi.fn(),
  mockReindex: vi.fn(),
  mockScan: vi.fn(),
  mockGetModel: vi.fn(),
  mockBustMvCache: vi.fn(),
  mockQueueUpdate: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishPrivateModel: mockPublishPrivateModel,
  publishModelById: mockPublishModelById,
  queueModelEarlyAccessReindex: mockReindex,
  getModel: mockGetModel,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustMvCache: mockBustMvCache,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  modelsSearchIndex: { queueUpdate: mockQueueUpdate },
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: mockRefresh },
}));

vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: vi.fn() } }));
vi.mock('~/server/services/text-scan/submit', () => ({ checkModelRulesInBackground: mockScan }));

import {
  publishModelHandler,
  publishPrivateModelHandler,
} from '~/server/controllers/model.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_ID = 42;
const OWNER_ID = 7;

const run = (isModerator = false) =>
  publishPrivateModelHandler({
    input: { modelId: MODEL_ID, publishVersions: true },
    ctx: { user: { id: OWNER_ID, isModerator } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetModel.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    status: 'Published',
    availability: 'Private',
    meta: {},
  });
});

describe('publishPrivateModelHandler — Model rules hold', () => {
  it('reports the model as held and runs none of the publish side effects', async () => {
    mockPublishPrivateModel.mockResolvedValue({ versionIds: [100], held: true });

    await expect(run()).resolves.toEqual({ held: true });

    expect(mockBustMvCache).not.toHaveBeenCalled();
    expect(mockQueueUpdate).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshes caches and the search index when the model went public', async () => {
    mockPublishPrivateModel.mockResolvedValue({ versionIds: [100], held: false });

    await expect(run()).resolves.toEqual({ held: false });

    expect(mockRefresh).toHaveBeenCalledWith(MODEL_ID);
    expect(mockBustMvCache).toHaveBeenCalledWith([100], MODEL_ID);
    expect(mockQueueUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('publishPrivateModelHandler — rule enforcement', () => {
  it.each([
    [false, true],
    [true, false],
  ])('for isModerator=%s passes enforceModelRules=%s', async (isModerator, enforce) => {
    mockPublishPrivateModel.mockResolvedValue({ versionIds: [100], held: false });

    await run(isModerator);

    expect(mockPublishPrivateModel).toHaveBeenCalledWith(expect.anything(), {
      enforceModelRules: enforce,
    });
  });
});

describe('publishModelHandler — Model rules', () => {
  const track = vi.fn().mockResolvedValue(undefined);
  const publish = (isModerator = false) =>
    publishModelHandler({
      input: { id: MODEL_ID, versionIds: [100] },
      ctx: { user: { id: OWNER_ID, isModerator }, track: { modelEvent: track } },
    } as never);

  beforeEach(() => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: 'Draft',
      meta: {},
      nsfw: false,
      userId: OWNER_ID,
    } as never);
    mockReindex.mockResolvedValue(undefined);
  });

  it('returns a held model without any publish side effect', async () => {
    const held = { id: MODEL_ID, userId: OWNER_ID, status: 'UnpublishedViolation' };
    mockPublishModelById.mockResolvedValue(held);

    await expect(publish()).resolves.toBe(held);

    expect(mockScan).not.toHaveBeenCalled();
    expect(mockReindex).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('runs the publish side effects for a model that went public', async () => {
    mockPublishModelById.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      status: 'Published',
      modelVersions: [{ id: 100 }],
    });

    await publish();

    // The literal check ran inside the publish, before the model went public.
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockReindex).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith(MODEL_ID);
  });

  it.each([
    [false, true],
    [true, false],
  ])('for isModerator=%s passes enforceModelRules=%s', async (isModerator, enforce) => {
    mockPublishModelById.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      status: 'Published',
      modelVersions: [],
    });

    await publish(isModerator);

    expect(mockPublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ enforceModelRules: enforce })
    );
  });
});
