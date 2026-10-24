import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as Caches from '~/server/redis/caches';

// The moderation limits on the private flow live in the service; the handler's job is to tell it
// whether the caller is a moderator, and to let its refusal through unchanged.

const { mockPublishPrivateModel, mockGetModel } = vi.hoisted(() => ({
  mockPublishPrivateModel: vi.fn(),
  mockGetModel: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishPrivateModel: mockPublishPrivateModel,
  getModel: mockGetModel,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: vi.fn() },
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn() },
}));

import { TRPCError } from '@trpc/server';
import { publishPrivateModelHandler } from '~/server/controllers/model.controller';

const MODEL_ID = 42;
const OWNER_ID = 7;

const publish = (isModerator: boolean) =>
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
    meta: null,
  });
  mockPublishPrivateModel.mockResolvedValue({ versionIds: [43] });
});

describe('publishPrivateModelHandler', () => {
  it.each([false, true])(
    'tells the service whether the caller is a moderator (%s)',
    async (isMod) => {
      await publish(isMod);

      expect(mockPublishPrivateModel).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: MODEL_ID, isModerator: isMod }),
        { enforceModelRules: !isMod }
      );
    }
  );

  it('lets the service refusal through as a TRPCError', async () => {
    mockPublishPrivateModel.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));

    await expect(publish(false)).rejects.toBeInstanceOf(TRPCError);
  });
});
