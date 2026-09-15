import { describe, it, expect, vi } from 'vitest';
// STATIC import, same reasoning as get-models-raw.paid-access-filter.test.ts: model.service
// is a ~4800-line module whose cold transform would otherwise be charged to the first
// test's timeout budget rather than to collection.
import { getDraftModelsByUserId } from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { ModelStatus, ModelUploadType } from '~/shared/utils/prisma/enums';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

// Same load-time seams as get-models-raw.paid-access-filter.test.ts: break the
// event-engine-common import chain via image.service and no-op the pgDb client.
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

type OrBranch = { uploadType: ModelUploadType; status: { in?: ModelStatus[]; notIn?: ModelStatus[] } };

async function draftWhereOr() {
  const findMany = dbMock.dbRead.model.findMany as ReturnType<typeof vi.fn>;
  findMany.mockClear();
  findMany.mockResolvedValue([]);
  await getDraftModelsByUserId({ userId: 1, select: { id: true }, page: 1, limit: 10 } as never);
  return (findMany.mock.calls[0][0] as { where: { OR: OrBranch[] } }).where.OR;
}

/**
 * A trained model scheduled to publish gets status = Scheduled. The Training tab
 * (getTrainingModelsByUserId) whitelists only Draft/Training, so if the Draft tab's
 * Trained branch drops Scheduled the model appears on no tab and the creator loses it
 * (Freshdesk #70454). Reverting the fix drops Scheduled and turns this red.
 */
describe('getDraftModelsByUserId — Trained branch status whitelist', () => {
  it('includes Scheduled so trainer-imported scheduled models surface on the Draft tab', async () => {
    const or = await draftWhereOr();
    const trained = or.find((b) => b.uploadType === ModelUploadType.Trained);
    expect(trained?.status.in).toContain(ModelStatus.Scheduled);
  });

  it('keeps the existing unpublished states on the Trained branch', async () => {
    const or = await draftWhereOr();
    const trained = or.find((b) => b.uploadType === ModelUploadType.Trained);
    expect(trained?.status.in).toEqual(
      expect.arrayContaining([ModelStatus.Unpublished, ModelStatus.UnpublishedViolation])
    );
  });

  it('does not add Draft/Training to the Trained branch (they belong on the Training tab)', async () => {
    const or = await draftWhereOr();
    const trained = or.find((b) => b.uploadType === ModelUploadType.Trained);
    expect(trained?.status.in).not.toContain(ModelStatus.Draft);
    expect(trained?.status.in).not.toContain(ModelStatus.Training);
  });
});
