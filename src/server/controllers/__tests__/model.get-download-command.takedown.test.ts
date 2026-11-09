import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommonService from '~/server/services/common.service';
import type * as DeliveryWorker from '~/utils/delivery-worker';
import type * as UserService from '~/server/services/user.service';

/**
 * `model.getDownloadCommand` hands out signed file URLs under its own access check, so it must
 * refuse a deleted or taken-down model to everyone but moderators, as the download route does.
 */

vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: vi.fn(),
}));

vi.mock('~/utils/delivery-worker', async (importOriginal) => ({
  ...(await importOriginal<typeof DeliveryWorker>()),
  resolveDownloadUrl: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  bustUserDownloadsCache: vi.fn().mockResolvedValue(undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getDownloadCommandHandler } from '~/server/controllers/model.controller';
import { hasEntityAccess } from '~/server/services/common.service';
import { EntityAccessPermission } from '~/server/common/enums';
import { resolveDownloadUrl } from '~/utils/delivery-worker';

const OWNER = { id: 7, isModerator: false };
// tRPC resolves an API key (scope ModelsRead) to the key holder's session user.
const API_KEY_USER = { id: 42, isModerator: false };
const MODERATOR = { id: 1, isModerator: true };

function call(user: { id: number; isModerator: boolean }) {
  return getDownloadCommandHandler({
    input: { modelId: 1, modelVersionId: 123 },
    ctx: { user, track: { modelVersionEvent: vi.fn() } },
  } as unknown as Parameters<typeof getDownloadCommandHandler>[0]);
}

function givenModel(model: { status?: string; mode?: string | null }) {
  dbMock.dbRead.modelVersion.findFirst.mockResolvedValue({
    id: 123,
    status: 'Published',
    name: 'v1',
    trainedWords: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    usageControl: 'Download',
    model: {
      id: 1,
      name: 'Model',
      type: 'Checkpoint',
      status: 'Published',
      userId: OWNER.id,
      mode: null,
      nsfw: false,
      ...model,
    },
    files: [
      {
        id: 10,
        url: 'https://example.invalid/model.safetensors',
        name: 'model.safetensors',
        type: 'Model',
        metadata: {},
        hashes: [{ hash: 'abc' }],
      },
    ],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasEntityAccess).mockResolvedValue([
    {
      entityId: 123,
      entityType: 'ModelVersion',
      hasAccess: true,
      permissions: EntityAccessPermission.EarlyAccessDownload,
    },
  ] as never);
  vi.mocked(resolveDownloadUrl).mockResolvedValue({
    url: 'https://example.invalid/signed',
  } as never);
});

describe('model.getDownloadCommand on a taken-down or deleted model', () => {
  it.each([
    ['taken down', 'its owner', { mode: 'TakenDown' }, OWNER],
    ['taken down', 'an API-key user', { mode: 'TakenDown' }, API_KEY_USER],
    ['deleted', 'its owner', { status: 'Deleted' }, OWNER],
  ])('is not found when %s, for %s', async (_state, _who, model, user) => {
    givenModel(model);

    await expect(call(user)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['taken down', { mode: 'TakenDown' }],
    ['deleted', { status: 'Deleted' }],
  ])('still gives a moderator the command when %s', async (_state, model) => {
    givenModel(model);

    expect((await call(MODERATOR))?.commands).toHaveLength(1);
  });

  it.each([
    ['its owner', OWNER],
    ['an API-key user', API_KEY_USER],
  ])('gives %s the command for a model that is neither', async (_who, user) => {
    givenModel({});

    expect((await call(user))?.commands).toHaveLength(1);
  });
});
