import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as Caches from '~/server/redis/caches';
import type * as SearchIndex from '~/server/search-index';

const { mockPublishPrivateModel, mockGetModel, mockBustMvCache, mockQueueUpdate, mockRefresh } =
  vi.hoisted(() => ({
    mockPublishPrivateModel: vi.fn(),
    mockGetModel: vi.fn(),
    mockBustMvCache: vi.fn(),
    mockQueueUpdate: vi.fn(),
    mockRefresh: vi.fn(),
  }));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishPrivateModel: mockPublishPrivateModel,
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

import { publishPrivateModelHandler } from '~/server/controllers/model.controller';

const MODEL_ID = 42;
const OWNER_ID = 7;

const run = () =>
  publishPrivateModelHandler({
    input: { modelId: MODEL_ID, publishVersions: true },
    ctx: { user: { id: OWNER_ID, isModerator: false } },
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
