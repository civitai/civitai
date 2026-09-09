import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS } from '~/server/redis/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';

// The reaction milestone counted every `ImageReaction` row, while every displayed
// count filters the reaction-farm suppression list — 24 against a displayed 4 on
// image 141298569, two milestones apart at thresholds of 5/10/20/50/100.
//
// Nothing here mocks `getMetricExcludedUserIds`. The tests drive the real service
// through a faked `fetchThroughCache`, so the fail-open path they assert is the one
// that runs in production rather than a stand-in for it.

const h = vi.hoisted(() => ({
  fetchThroughCache: vi.fn(),
  chQuery: vi.fn(),
  notificationExists: vi.fn(),
  createNotification: vi.fn(),
}));

// Spread the real module rather than listing exports: the controller's import graph
// pulls other cache helpers in, and a hand-listed mock breaks the moment it grows.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: h.fetchThroughCache,
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: h.chQuery },
}));

vi.mock('~/server/notifications/client', () => ({
  notifications: { notificationExists: h.notificationExists },
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: h.createNotification,
}));

const count = dbMock.dbRead.imageReaction.count;
const findFirst = dbMock.dbRead.image.findFirst;

const { getMetricExcludedUserIds } = await import(
  '~/server/services/metric-excluded-users.service'
);
// Hoisted rather than imported inside a test: the controller's import graph took
// ~12s, and charging that to one test's budget turns a slow box into a timeout with
// no assertion to read.
const { createReactionNotification } = await import('~/server/controllers/reaction.controller');

/** Runs the real fetch function, so the row mapping and filtering are exercised. */
const cachePassthrough = () =>
  h.fetchThroughCache.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());

const cacheRejects = (message = 'clickhouse unreachable') =>
  h.fetchThroughCache.mockRejectedValue(new Error(message));

beforeEach(() => {
  vi.clearAllMocks();
  h.fetchThroughCache.mockReset();
  h.chQuery.mockReset();
  h.notificationExists.mockResolvedValue(false);
  count.mockReset();
  findFirst.mockReset();
  findFirst.mockResolvedValue({ userId: 42, id: 141298569, postId: 7, resourceHelper: [] });
  h.createNotification.mockResolvedValue(undefined);
});

describe('getMetricExcludedUserIds', () => {
  it('returns the suppressed ids', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([{ userId: 6680940 }, { userId: 7472843 }]);

    await expect(getMetricExcludedUserIds()).resolves.toEqual([6680940, 7472843]);
  });

  // `Number(null)` is 0, not NaN, so a null column would enter the list as user 0
  // and suppress whatever writes that id.
  it('drops ids that are not positive numbers', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([{ userId: 0 }, { userId: null }, { userId: 6680940 }]);

    await expect(getMetricExcludedUserIds()).resolves.toEqual([6680940]);
  });

  // Without these the statement was unasserted: deleting `WHERE active = 1` subtracts
  // every user ever flagged, including ones since un-flagged, so milestones silently
  // stop firing for people who should get them — and every test stayed green.
  it('reads only rows still active, through FINAL', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([]);

    await getMetricExcludedUserIds();

    const sql = (h.chQuery.mock.calls[0][0] as string[]).join('');
    expect(sql).toContain('FINAL');
    expect(sql).toContain('active = 1');
    expect(sql).toContain('metricExcludedUsers');
  });

  // The key is new in this diff, so nothing else protects it: pointing it at a
  // sibling constant would write a number[] over another cache's namespace and read
  // that cache's payload back as user ids, with every test still passing.
  it('reads and writes its own cache key, at its own TTL', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([]);

    await getMetricExcludedUserIds();

    expect(h.fetchThroughCache).toHaveBeenCalledWith(
      REDIS_KEYS.CACHES.METRIC_EXCLUDED_USERS,
      expect.any(Function),
      { ttl: CacheTTL.sm }
    );
  });

  // `fetchThroughCache` returns any present `data` unvalidated, so a cached `null`
  // would reach the caller's `.length` OUTSIDE this function's catch — a TypeError
  // that `.catch(handleLogError)` turns into the silent skip this design avoids.
  it('treats a cached value that is not an array as unavailable', async () => {
    h.fetchThroughCache.mockResolvedValue(null);

    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);
  });

  // `fetchThroughCache` REJECTS when the origin fails with nothing cached, and the
  // only caller runs as `.catch(handleLogError)` — so propagating would silently
  // skip the notification. Returning [] degrades to the unfiltered count instead.
  it('returns an empty list instead of rejecting when the lookup fails', async () => {
    cacheRejects();

    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);
  });
});

describe('createReactionNotification', () => {
  async function run() {
    await createReactionNotification({ entityType: 'image', entityId: 141298569 } as never);
  }

  // The `count` fake honours the where clause on purpose. With a flat stub the 4 comes
  // from the stub rather than from the filter, so the assertion would hold even with
  // the filter removed — it would prove the mock works, not the code.
  const countHonouringWhere = () =>
    count.mockImplementation(async (args: { where: { userId?: unknown } }) =>
      args.where.userId ? 4 : 24
    );

  it('excludes suppressed users, changing which milestone fires', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([{ userId: 6680940 }]);
    countHonouringWhere();

    await run();

    expect(count).toHaveBeenCalledWith({
      where: { imageId: 141298569, userId: { notIn: [6680940] } },
    });
    // Filtered this image is 4, below the lowest threshold (5). Unfiltered it is 24,
    // which fires the 20 — that difference is the whole change.
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  // The property that decided this approach over reading ClickHouse. If the list is
  // unavailable the milestone must still fire on the unfiltered count; the failure
  // mode is the old bug, never a skipped notification.
  it('still fires on the unfiltered count when the exclusion lookup fails', async () => {
    cacheRejects();
    count.mockResolvedValue(24);

    await run();

    expect(count).toHaveBeenCalledWith({ where: { imageId: 141298569 } });
    expect(h.createNotification).toHaveBeenCalledTimes(1);
    expect(h.createNotification.mock.calls[0][0]).toMatchObject({
      key: 'image-reaction-milestone:141298569:20',
      userId: 42,
    });
  });

  // The producer -> consumer seam. `prepareMessage` builds the notification URL from
  // `details.postId`, but nothing else ties the key it reads to the key this controller
  // writes: rename or drop `postId` here and the handler's `postId != null` goes false
  // for every notification, every link silently loses its post context, and a test that
  // hand-writes its own `details` fixture stays green. So feed the CAPTURED details
  // through the real handler rather than a fixture of it.
  it('emits details the milestone handler can actually build a URL from', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([]);
    count.mockResolvedValue(10);

    await run();

    const { details } = h.createNotification.mock.calls[0][0];
    const message = reactionNotifications['image-reaction-milestone'].prepareMessage({
      type: 'image-reaction-milestone',
      details,
    });

    // findFirst above resolves postId: 7, so the real post context must survive.
    expect(message?.url).toBe('/images/141298569?postId=7');
  });

  // An empty list must not become `notIn: []`, which is a different query.
  it('omits the filter clause entirely when nothing is suppressed', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([]);
    count.mockResolvedValue(10);

    await run();

    expect(count).toHaveBeenCalledWith({ where: { imageId: 141298569 } });
    expect(h.createNotification).toHaveBeenCalledTimes(1);
  });
});
