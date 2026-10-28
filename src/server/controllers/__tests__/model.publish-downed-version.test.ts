import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DuplicateHash from '~/server/services/duplicate-model-hash.service';
import type * as ModelService from '~/server/services/model.service';
import type * as PublishFromWorkflow from '~/server/services/orchestrator/training/publish-from-workflow';

/**
 * publishModelHandler checked the MODEL's status and took the version ids from the client. An owner
 * could unpublish a model one of whose versions a moderator had taken down, then republish it with
 * that version in the list, and the version came back Published.
 */

const { publishModelById, unpublishModelById } = vi.hoisted(() => ({
  publishModelById: vi.fn(),
  unpublishModelById: vi.fn(),
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishModelById,
  unpublishModelById,
}));
vi.mock(
  '~/server/services/orchestrator/training/publish-from-workflow',
  async (importOriginal) => ({
    ...(await importOriginal<typeof PublishFromWorkflow>()),
    assertTrainingSourcePublishable: async () => undefined,
  })
);
vi.mock('~/server/services/duplicate-model-hash.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DuplicateHash>()),
  assertNotCrossOwnerDuplicate: async () => undefined,
}));

const { publishModelHandler, unpublishModelHandler } = await import('../model.controller');
const { KEPT_MODEL_STATUS } = await import('~/server/utils/legal-hold');

const MODEL = 1;
// Version 10 is live; 11 a moderator took down; 12 is deleted.
const versions = [
  { id: 10, modelId: MODEL, status: 'Unpublished' },
  { id: 11, modelId: MODEL, status: 'UnpublishedViolation' },
  { id: 12, modelId: MODEL, status: 'Deleted' },
];

beforeEach(() => {
  publishModelById.mockReset();
  // Held for review, so the handler returns before its publish side effects.
  publishModelById.mockResolvedValue({ id: MODEL, status: 'UnpublishedViolation' });
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    status: 'Unpublished',
    meta: {},
    nsfw: false,
    userId: 5,
  } as never);
  // Applies the filter the handler asks for, so a check that drops the status condition shows up.
  dbMock.dbWrite.modelVersion.count.mockImplementation(
    (async ({
      where,
    }: {
      where: { id: { in: number[] }; modelId?: number; status?: { in: string[] } };
    }) =>
      versions.filter(
        (v) =>
          where.id.in.includes(v.id) &&
          (where.modelId === undefined || v.modelId === where.modelId) &&
          (!where.status || where.status.in.includes(v.status))
      ).length) as never
  );
});

const publish = (versionIds: number[], isModerator = false) =>
  publishModelHandler({
    input: { id: MODEL, versionIds },
    ctx: { user: { id: isModerator ? 9 : 5, isModerator }, track: {} } as never,
  });

describe('publishModelHandler with a taken-down version in the list', () => {
  it.each([
    ['taken down for a violation', 11],
    ['deleted', 12],
  ])('refuses the owner when a version is %s, and publishes nothing', async (_label, id) => {
    await expect(publish([10, id])).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(publishModelById).not.toHaveBeenCalled();
  });

  it('lets a moderator republish it', async () => {
    await publish([10, 11], true);
    expect(publishModelById).toHaveBeenCalledTimes(1);
  });

  it('still publishes the owner live versions', async () => {
    await publish([10]);
    expect(publishModelById).toHaveBeenCalledTimes(1);
  });
});

describe('publishModelHandler on a model a content wipe kept', () => {
  it('refuses the owner', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: KEPT_MODEL_STATUS,
      meta: { removedWithOwner: true },
      nsfw: false,
      userId: 5,
    } as never);
    await expect(publish([10])).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(publishModelById).not.toHaveBeenCalled();
  });

  it('still lets the owner republish a model unpublished the ordinary way (control)', async () => {
    await publish([10]);
    expect(publishModelById).toHaveBeenCalledTimes(1);
  });
});

describe('a moderator publishing a model a content wipe kept', () => {
  it('drops the removal marker from its meta', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: KEPT_MODEL_STATUS,
      meta: {
        note: 1,
        removedWithOwner: true,
        statusBeforeRemoval: 'Published',
        versionsUnpublishedByRemoval: [{ id: 10, status: 'Published' }],
      },
      nsfw: false,
      userId: 5,
    } as never);
    await publish([10], true);
    expect(publishModelById).toHaveBeenCalledWith(expect.objectContaining({ meta: { note: 1 } }));
  });
});

describe('a moderator unpublishing a model a content wipe kept, for a violation', () => {
  const record = {
    removedWithOwner: true,
    statusBeforeRemoval: 'Published',
    versionsUnpublishedByRemoval: [{ id: 10, status: 'Published' }],
  };
  const unpublish = (reason?: string) =>
    unpublishModelHandler({
      input: { id: MODEL, ...(reason ? { reason } : {}) } as never,
      ctx: { user: { id: 9, isModerator: true }, track: { modelEvent: vi.fn() } } as never,
    }).catch(() => undefined);

  beforeEach(() => {
    unpublishModelById.mockReset();
    unpublishModelById.mockResolvedValue({ id: MODEL, userId: 5 });
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      meta: { note: 1, ...record },
      nsfw: false,
    } as never);
  });

  it('makes it an ordinary take-down: the removal record goes', async () => {
    await unpublish('other');
    expect(unpublishModelById).toHaveBeenCalledWith(expect.objectContaining({ meta: { note: 1 } }));
  });

  it('keeps the record on an unpublish with no reason (control)', async () => {
    await unpublish();
    expect(unpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { note: 1, ...record } })
    );
  });
});
