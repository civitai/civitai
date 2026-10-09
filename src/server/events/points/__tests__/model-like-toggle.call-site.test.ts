import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Award from '~/server/events/points/award';
import type * as DbLag from '~/server/db/db-lag-helpers';

// `toggleReview` is the model page's thumbs up button: it creates, flips or deletes the author's
// review, and each of those re-reads whether they still recommend the model.

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
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/resourceReview.cache', () => ({
  bustRatingTotalsCache: vi.fn(async () => undefined),
  bustRatingTotalsForRows: vi.fn(async () => undefined),
}));

import { toggleReview } from '~/server/services/user.service';

const AUTHOR = 42;
const MODEL = 10;
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
});

describe('toggleReview event points', () => {
  it('awards a new thumbs up', async () => {
    dbMock.dbRead.resourceReview.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.resourceReview.count.mockResolvedValue(1);

    await toggleReview({ modelId: MODEL, userId: AUTHOR, modelVersionId: 20, setTo: true });
    await settle();

    expect(awardEventPoints).toHaveBeenCalledWith([modelLike]);
  });

  it('removes when the thumbs up is taken back', async () => {
    dbMock.dbRead.resourceReview.findFirst.mockResolvedValue({
      id: 7,
      recommended: true,
      modelVersionId: 20,
    });
    dbMock.dbWrite.resourceReview.count.mockResolvedValue(0);

    await toggleReview({ modelId: MODEL, userId: AUTHOR, modelVersionId: 20, setTo: false });
    await settle();

    expect(removeEventPoints).toHaveBeenCalledWith([modelLike]);
  });
});
