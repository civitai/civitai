import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Award from '~/server/events/points/award';

// The ResourceReview write sites. A model thumbs up is a recommended review: every write that can
// add or take one away re-reads whether the author still recommends the model, and awards or
// removes from that. A failing points call never fails the review.

const { awardEventPoints, removeEventPoints, hatted } = vi.hoisted(() => ({
  awardEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  removeEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  hatted: new Set<string>(),
}));

vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints,
  removeEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/resourceReview.cache', () => ({
  bustRatingTotalsCache: vi.fn(async () => undefined),
  bustRatingTotalsForRows: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedByUsers: { getCached: vi.fn(async () => []) },
  BlockedUsers: { getCached: vi.fn(async () => []) },
  HiddenUsers: { getCached: vi.fn(async () => []) },
}));
vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser: vi.fn(async () => false),
  getBasicDataForUsers: vi.fn(async () => new Map()),
  getCosmeticsForUsers: vi.fn(async () => ({})),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
}));

import {
  createResourceReview,
  deleteResourceReview,
  deleteResourceReviews,
  updateResourceReview,
  upsertResourceReview,
} from '~/server/services/resourceReview.service';

const db = dbMock.dbWrite;
const AUTHOR = 42;
const MODEL = 10;
const row = { id: 7, modelId: MODEL, modelVersionId: 20, userId: AUTHOR, recommended: true };
const input = { modelId: MODEL, modelVersionId: 20, rating: 5, recommended: true, details: null };
const modelLike = {
  type: 'modelLike',
  actorId: AUTHOR,
  entityType: 'Model',
  entityId: MODEL,
  sourceId: `ResourceReview:${MODEL}:${AUTHOR}`,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  hatted.add(`Model:${MODEL}`);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dbMock.dbRead.user.findFirst.mockResolvedValue({ username: 'tester' });
  db.model.findUnique.mockResolvedValue({ userId: 1 });
  db.resourceReview.findUnique.mockResolvedValue({ modelId: MODEL });
  db.resourceReview.create.mockResolvedValue(row);
  db.resourceReview.update.mockResolvedValue(row);
  db.resourceReview.delete.mockResolvedValue(row);
});

describe('ResourceReview event points', () => {
  it('awards a recommended review on create', async () => {
    db.resourceReview.count.mockResolvedValue(1);
    await createResourceReview({ ...input, userId: AUTHOR });
    await settle();
    expect(awardEventPoints).toHaveBeenCalledWith([modelLike]);
  });

  it('awards a recommended review created through upsert', async () => {
    db.resourceReview.count.mockResolvedValue(1);
    await upsertResourceReview({ ...input, userId: AUTHOR });
    await settle();
    expect(awardEventPoints).toHaveBeenCalledWith([modelLike]);
  });

  it("removes when an edit leaves the author recommending nothing, keyed on the review's author", async () => {
    db.resourceReview.count.mockResolvedValue(0);
    // A moderator editing someone else's review: the points belong to the review's author.
    await updateResourceReview({ id: 7, recommended: false, userId: 1 });
    await settle();
    expect(removeEventPoints).toHaveBeenCalledWith([modelLike]);
  });

  it('removes on delete', async () => {
    db.resourceReview.count.mockResolvedValue(0);
    await deleteResourceReview({ id: 7 });
    await settle();
    expect(removeEventPoints).toHaveBeenCalledWith([modelLike]);
  });

  it('removes for each author in a moderator bulk delete', async () => {
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([row]);
    db.resourceReview.deleteMany.mockResolvedValue({ count: 1 });
    db.resourceReview.count.mockResolvedValue(0);
    await deleteResourceReviews({ ids: [7] });
    await settle();
    expect(removeEventPoints).toHaveBeenCalledWith([modelLike]);
  });

  it('is not failed by a failing points call', async () => {
    db.resourceReview.count.mockResolvedValue(1);
    awardEventPoints.mockRejectedValueOnce(new Error('redis down'));
    await expect(createResourceReview({ ...input, userId: AUTHOR })).resolves.toBe(row);
    await settle();
    expect(awardEventPoints).toHaveBeenCalledTimes(1);
  });
});
