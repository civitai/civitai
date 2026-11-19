import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommonService from '~/server/services/common.service';
import type * as DeliveryWorker from '~/utils/delivery-worker';
import type * as UserService from '~/server/services/user.service';

// The download-command path emits the same Download event the download route does, so an internal
// service (the system account) must not count here either while real users still do.

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
import { constants } from '~/server/common/constants';
import { getDownloadCommandHandler } from '~/server/controllers/model.controller';
import { hasEntityAccess } from '~/server/services/common.service';
import { EntityAccessPermission } from '~/server/common/enums';
import { resolveDownloadUrl } from '~/utils/delivery-worker';

const modelVersionEvent = vi.fn();

function call(userId: number) {
  return getDownloadCommandHandler({
    input: { modelId: 1, modelVersionId: 123 },
    ctx: {
      user: { id: userId, isModerator: false },
      track: { modelVersionEvent },
    },
  } as unknown as Parameters<typeof getDownloadCommandHandler>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.modelVersion.findFirst.mockResolvedValue({
    id: 123,
    name: 'v1',
    trainedWords: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    usageControl: 'Download',
    model: {
      id: 1,
      name: 'Model',
      type: 'Checkpoint',
      status: 'Published',
      userId: 7,
      mode: null,
      nsfw: false,
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

describe('getDownloadCommandHandler Download events', () => {
  it('the system account gets the command and emits no Download event', async () => {
    const result = await call(constants.system.user.id);

    expect(result?.commands).toHaveLength(1);
    expect(modelVersionEvent).not.toHaveBeenCalled();
  });

  it('a real user emits one Download event', async () => {
    const result = await call(42);

    expect(result?.commands).toHaveLength(1);
    expect(modelVersionEvent).toHaveBeenCalledTimes(1);
    expect(modelVersionEvent.mock.calls[0][0]).toMatchObject({
      type: 'Download',
      modelVersionId: 123,
    });
  });
});
