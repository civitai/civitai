import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLag from '~/server/db/db-lag-helpers';

const { createNotification } = vi.hoisted(() => ({
  createNotification: vi.fn<(row: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNotification,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  BlockedByUsers: { getCached: vi.fn(async () => []) },
  BlockedUsers: { getCached: vi.fn(async () => []) },
  HiddenUsers: { getCached: vi.fn(async () => []) },
}));
vi.mock('~/server/services/text-scan/scam-scan-queue', () => ({ queueScamScan: vi.fn() }));
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onModelReviewsChanged: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/resourceReview.cache', () => ({
  bustRatingTotalsCache: vi.fn(async () => undefined),
  bustRatingTotalsForRows: vi.fn(async () => undefined),
}));

import {
  updateResourceReview,
  upsertResourceReview,
} from '~/server/services/resourceReview.service';
import { toggleReview } from '~/server/services/user.service';

const REVIEWER = 42;
const OWNER = 7;
const MODEL = 10;
const VERSION = 20;
const REVIEW = 99;

function ownedBy(ownerId: number) {
  dbMock.dbRead.modelVersion.findFirst.mockResolvedValue({
    name: 'v1',
    model: { name: 'Model', userId: ownerId },
  } as never);
}
function stored(details: string | null) {
  dbMock.dbWrite.resourceReview.findUnique.mockResolvedValue({ modelId: MODEL, details } as never);
}
function updatedTo(details: string | null, postId: number | null = null) {
  dbMock.dbWrite.resourceReview.update.mockResolvedValue({
    id: REVIEW,
    modelId: MODEL,
    modelVersionId: VERSION,
    userId: REVIEWER,
    rating: 5,
    recommended: true,
    nsfw: false,
    postId,
    details,
  } as never);
}
const edit = (details: string) => updateResourceReview({ id: REVIEW, details, userId: REVIEWER });
const upsertEdit = (details: string) =>
  upsertResourceReview({
    id: REVIEW,
    modelId: MODEL,
    modelVersionId: VERSION,
    rating: 5,
    recommended: true,
    details,
    userId: REVIEWER,
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ userId: OWNER } as never);
  dbMock.dbRead.imageResourceNew.count.mockResolvedValue(0);
  dbMock.dbRead.user.findFirst.mockResolvedValue({ username: 'reviewer' } as never);
  ownedBy(OWNER);
  stored(null);
  updatedTo('<p>Great model</p>');
});

describe('new-review notification on the first text', () => {
  it.each([
    ['update', edit],
    ['upsert', upsertEdit],
  ])("notifies the model's owner when a Like gets text (%s)", async (_path, write) => {
    await write('<p>Great model</p>');

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      type: 'new-review',
      key: `new-review:${VERSION}:${REVIEWER}`,
      userId: OWNER,
      details: { reviewId: REVIEW, modelId: MODEL, recommended: true },
    });
  });

  it('stays silent for a bare Like', async () => {
    dbMock.dbRead.resourceReview.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.resourceReview.create.mockResolvedValue({ id: REVIEW } as never);

    await toggleReview({ modelId: MODEL, userId: REVIEWER, modelVersionId: VERSION, setTo: true });

    expect(dbMock.dbWrite.resourceReview.create).toHaveBeenCalledTimes(1);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('stays silent when the owner reviews their own model', async () => {
    ownedBy(REVIEWER);
    await edit('<p>Great model</p>');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['update', edit],
    ['upsert', upsertEdit],
  ])('stays silent when the review already had text (%s)', async (_path, write) => {
    stored('<p>Good</p>');
    await write('<p>Great model</p>');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('treats an empty editor as no text', async () => {
    stored('<p></p>');
    await edit('<p>Great model</p>');
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('leaves a review written from a post to the post release', async () => {
    updatedTo('<p>Great model</p>', 5);
    await edit('<p>Great model</p>');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('still saves the edit when the notification fails', async () => {
    dbMock.dbRead.modelVersion.findFirst.mockRejectedValue(new Error('replica down'));
    await expect(edit('<p>Great model</p>')).resolves.toMatchObject({ id: REVIEW });
  });
});
