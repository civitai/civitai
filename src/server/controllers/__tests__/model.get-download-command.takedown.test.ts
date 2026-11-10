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
const OTHER_USER = { id: 42, isModerator: false };
const MODERATOR = { id: 1, isModerator: true };

function call(user: { id: number; isModerator: boolean }) {
  return getDownloadCommandHandler({
    input: { modelId: 1, modelVersionId: 123 },
    ctx: { user, track: { modelVersionEvent: vi.fn() } },
  } as unknown as Parameters<typeof getDownloadCommandHandler>[0]);
}

function givenModel(
  model: { status?: string; mode?: string | null },
  usageControl = 'Download',
  files: object[] = [{ id: 10, type: 'Model', visibility: 'Public', replacedAt: null }]
) {
  dbMock.dbRead.modelVersion.findFirst.mockResolvedValue({
    id: 123,
    status: 'Published',
    name: 'v1',
    trainedWords: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    usageControl,
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
    files: files.map((f) => ({
      url: 'https://example.invalid/model.safetensors',
      name: 'model.safetensors',
      metadata: {},
      hashes: [{ hash: 'abc' }],
      ...f,
    })),
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
    ['taken down', 'a signed-in non-owner', { mode: 'TakenDown' }, OTHER_USER],
    ['deleted', 'its owner', { status: 'Deleted' }, OWNER],
  ])('is not found when %s, for %s', async (_state, _who, model, user) => {
    givenModel(model);

    await expect(call(user)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('is not found, not forbidden, when downloads are also disabled', async () => {
    givenModel({ mode: 'TakenDown' }, 'Generation');

    await expect(call(OTHER_USER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
    ['a signed-in non-owner', OTHER_USER],
  ])('gives %s the command for a model that is neither', async (_who, user) => {
    givenModel({});

    expect((await call(user))?.commands).toHaveLength(1);
  });
});

describe('model.getDownloadCommand offers the files the download route offers', () => {
  const PRIVATE_MODEL = { id: 10, type: 'Model', visibility: 'Private', replacedAt: null };
  const REPLACED_VAE = {
    id: 12,
    type: 'VAE',
    visibility: 'Public',
    replacedAt: new Date('2026-10-01T00:00:00Z'),
  };

  it('is not found for a non-owner when the model file is not Public', async () => {
    givenModel({}, 'Download', [PRIVATE_MODEL]);

    await expect(call(OTHER_USER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['its owner', OWNER],
    ['a moderator', MODERATOR],
  ])('still gives %s a file that is not Public', async (_who, user) => {
    givenModel({}, 'Download', [PRIVATE_MODEL]);

    expect((await call(user))?.commands).toHaveLength(1);
  });

  it('leaves a component that is not Public out for a non-owner, and serves the model file', async () => {
    givenModel({}, 'Download', [
      { id: 10, type: 'Model', visibility: 'Public', replacedAt: null },
      { id: 13, type: 'VAE', visibility: 'Private', replacedAt: null },
    ]);

    expect((await call(OTHER_USER))?.commands).toHaveLength(1);
    expect(vi.mocked(resolveDownloadUrl).mock.calls.map(([id]) => id)).toEqual([10]);
  });

  it('never adds a replaced component, for anyone', async () => {
    givenModel({}, 'Download', [
      { id: 10, type: 'Model', visibility: 'Public', replacedAt: null },
      REPLACED_VAE,
    ]);

    for (const user of [OTHER_USER, OWNER, MODERATOR]) {
      vi.mocked(resolveDownloadUrl).mockClear();
      expect((await call(user))?.commands).toHaveLength(1);
      expect(vi.mocked(resolveDownloadUrl).mock.calls.map(([id]) => id)).toEqual([10]);
    }
  });
});
