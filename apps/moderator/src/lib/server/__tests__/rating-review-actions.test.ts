import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RatingReviewsService from '../rating-reviews.service';

const { resolve, notify, sync, activity, chInsert, bust } = vi.hoisted(() => ({
  resolve: vi.fn(),
  notify: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  activity: vi.fn().mockResolvedValue(undefined),
  chInsert: vi.fn().mockResolvedValue(undefined),
  bust: vi.fn().mockResolvedValue({ ok: true, body: {} }),
}));

vi.mock('../rating-reviews.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RatingReviewsService>()),
  resolveRatingReview: resolve,
}));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification: notify }) }));
vi.mock('../search-index', () => ({ syncSearchIndex: sync }));
vi.mock('../mod-activity', () => ({ recordModActivity: activity }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert: chInsert }) }));
vi.mock('../user-actions.service', () => ({ bustModelVersionCache: bust }));

const { resolveRatingReviewAction } = await import('../rating-review-actions');
const { RatingReviewResolveError } = await import('../rating-reviews.service');

const result = (over: object = {}) => ({
  reviewId: 11,
  entityType: 'Post',
  entityId: 5,
  parentId: null,
  title: 'hello',
  ownerUserId: 3,
  previousLevel: 8,
  status: 'Actioned',
  entityMissing: false,
  modelVersionIds: [],
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveRatingReviewAction', () => {
  it('notifies the owner with the generic type and records the activity', async () => {
    resolve.mockResolvedValue(result());
    await expect(
      resolveRatingReviewAction({ reviewId: 11, appliedLevel: 2, userId: 7 })
    ).resolves.toEqual({
      ok: true,
      status: 'Actioned',
    });
    await flush();
    expect(notify).toHaveBeenCalledWith({
      userId: 3,
      category: expect.any(String),
      type: 'rating-review-approved',
      key: 'rating-review-approved:11',
      details: expect.objectContaining({
        url: '/posts/5',
        previousLevel: 'X',
        appliedLevel: 'PG-13',
      }),
    });
    expect(activity).toHaveBeenCalledWith({
      userId: 7,
      entityType: 'post',
      entityId: 5,
      activity: 'ratingReview',
    });
    expect(sync).not.toHaveBeenCalled();
    expect(chInsert).not.toHaveBeenCalled();
    expect(bust).not.toHaveBeenCalled();
  });

  it('writes BountyEntry activity in the lower-camel form the activity readers use', async () => {
    resolve.mockResolvedValue(result({ entityType: 'BountyEntry' }));
    await resolveRatingReviewAction({ reviewId: 11, appliedLevel: 2, userId: 7 });
    await flush();
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'bountyEntry' }));
  });

  it("busts the main app's model caches after a Model resolve", async () => {
    resolve.mockResolvedValue(result({ entityType: 'Model', modelVersionIds: [41, 42] }));
    await resolveRatingReviewAction({ reviewId: 11, appliedLevel: 1, userId: 7 });
    await flush();
    expect(bust).toHaveBeenCalledWith([41, 42]);
    expect(sync).toHaveBeenCalledWith({ entityType: 'model', entityId: 5, action: 'update' });
  });

  it('re-indexes only indexed types and records ClickHouse only for Article', async () => {
    resolve.mockResolvedValue(result({ entityType: 'Article' }));
    await resolveRatingReviewAction({ reviewId: 11, appliedLevel: 2, userId: 7 });
    await flush();
    expect(sync).toHaveBeenCalledWith({ entityType: 'article', entityId: 5, action: 'update' });
    expect(chInsert).toHaveBeenCalledTimes(1);
  });

  it('notifies nobody and indexes nothing when the entity was gone', async () => {
    resolve.mockResolvedValue(
      result({ entityType: 'Model', entityMissing: true, status: 'Unactioned' })
    );
    await resolveRatingReviewAction({ reviewId: 11, appliedLevel: 2, userId: 7 });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(bust).not.toHaveBeenCalled();
  });

  it('turns a lost race into an error the page shows', async () => {
    resolve.mockRejectedValue(new RatingReviewResolveError('Review already resolved'));
    await expect(
      resolveRatingReviewAction({ reviewId: 11, appliedLevel: 2, userId: 7 })
    ).resolves.toEqual({
      ok: false,
      error: 'Review already resolved',
    });
  });
});
