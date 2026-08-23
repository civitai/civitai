import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #4272, reader side — the deferred reap for images that were REPLACED rather than deleted.
 *
 * `updateUserHandler` no longer destroys the previous profile picture inline; it writes a
 * `JobQueue(ReplacedImageDelete, Image)` row and this job collects it later. The properties
 * that matter, and that a green suite would otherwise not distinguish:
 *
 *   1. the window actually CLOSES — a queued image past retention is really destroyed, so
 *      deferring is not a storage leak dressed up as a fix;
 *   2. the window is 30 days, measured from the queue row's `createdAt` — an image queued
 *      29 days ago is still fetchable, which is the whole point (the image CDN's redirect is
 *      `max-age=86400`, and the account-switcher roster in localStorage outlives that by a
 *      lot);
 *   3. a RE-ADOPTED image is never reaped. A user can re-select a picture they previously
 *      replaced away from; the stale queue row from that earlier replacement then points at
 *      a live avatar, and deleting it would be a strictly worse version of the original bug;
 *   4. both cohorts leave the queue, so a re-adopted image cannot be re-examined every run;
 *   5. a non-prod database is never mass-deleted.
 *
 * The fixture drives the retention filter for real — the stubbed `jobQueue.findMany` applies
 * the `createdAt` bound the job passes — so a mutant that widens, narrows, inverts or drops
 * the cutoff changes WHICH ids get destroyed, rather than merely changing an argument nobody
 * reads. The day offsets straddle the boundary on both sides and are not multiples of it.
 */

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const EXPIRED_ID = 1; // queued 40d ago, unreferenced -> destroyed
const JUST_EXPIRED_ID = 2; // queued 31d ago, unreferenced -> destroyed
const READOPTED_ID = 3; // queued 40d ago, but live again -> kept, dequeued
const JUST_INSIDE_ID = 4; // queued 29d ago -> still fetchable
const RECENT_ID = 5; // queued 25d ago -> still fetchable

const QUEUE = [
  { entityId: EXPIRED_ID, createdAt: daysAgo(40) },
  { entityId: JUST_EXPIRED_ID, createdAt: daysAgo(31) },
  { entityId: READOPTED_ID, createdAt: daysAgo(40) },
  { entityId: JUST_INSIDE_ID, createdAt: daysAgo(29) },
  { entityId: RECENT_ID, createdAt: daysAgo(25) },
];

/** Images that are somebody's CURRENT profile picture, i.e. what the User table would return. */
const LIVE_PROFILE_PICTURE_IDS = [READOPTED_ID];

const { mockDeleteImages, mockEnv } = vi.hoisted(() => ({
  mockDeleteImages: vi.fn(async () => undefined),
  mockEnv: { DATABASE_IS_PROD: true },
}));

// Hand-listed rather than spread from the real module: image.service is ~8k lines and builds
// module-scope caches on import.
vi.mock('~/server/services/image.service', () => ({ deleteImages: mockDeleteImages }));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  REPLACED_IMAGE_RETENTION_DAYS,
  removeReplacedImages,
} from '~/server/jobs/remove-replaced-images';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

const ctx = {} as Parameters<typeof removeReplacedImages.run>[0];
const runJob = () =>
  removeReplacedImages.run(ctx).result as Promise<Partial<{ deleted: number; readopted: number }>>;

/** Ids handed to the destructive call — i.e. the images that stopped being fetchable. */
const destroyedIds = () => (mockDeleteImages.mock.calls[0]?.[0] as number[] | undefined) ?? [];

/** Every `$executeRaw` the job issued, as `{ sql, values }`. */
const writes = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map((call: unknown[]) => ({
    sql: (call[0] as TemplateStringsArray).join('?'),
    values: call.slice(1),
  }));

const dequeue = () => writes().find((w) => w.sql.includes('DELETE FROM "JobQueue"'));
const dequeuedIds = () => (dequeue()?.values.find(Array.isArray) as number[] | undefined) ?? [];

/** The `where` the job asked the queue with — the retention bound lives here. */
const queueWhere = () => dbMock.dbRead.jobQueue.findMany.mock.calls[0]?.[0]?.where;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.DATABASE_IS_PROD = true;

  type QueueQuery = { where?: { createdAt?: { lt?: Date } } };
  dbMock.dbRead.jobQueue.findMany.mockImplementation(async ({ where }: QueueQuery) => {
    // Stands in for the DB applying the retention bound the job asked for. If the job stops
    // passing one, every row comes back and the "still fetchable" cases below are destroyed.
    const before: Date | undefined = where?.createdAt?.lt;
    return QUEUE.filter((q) => !before || q.createdAt < before).map(({ entityId }) => ({
      entityId,
    }));
  });
  // Declared on dbWrite only. The re-adoption probe has to read the primary — a re-adoption
  // that landed inside replica lag is invisible on the replica, and the job would then delete
  // the avatar the user just chose. Reading dbRead here returns the canonical mock's empty
  // default, so that mistake fails the re-adoption test rather than passing quietly.
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join('').includes('FROM "User"')) return [];
      const ids = (values.find(Array.isArray) as number[]) ?? [];
      return LIVE_PROFILE_PICTURE_IDS.filter((id) => ids.includes(id)).map((id) => ({ id }));
    }
  );
});

describe('remove-replaced-images', () => {
  it('destroys a replaced image once its window has elapsed', async () => {
    await runJob();

    // The window closes. Without this the "fix" would just be an unbounded storage leak.
    expect(destroyedIds()).toContain(EXPIRED_ID);
    expect(destroyedIds()).toContain(JUST_EXPIRED_ID);
  });

  it('leaves a replaced image fetchable for the whole 30-day window', async () => {
    await runJob();

    // 29 and 25 days: both past the CDN's 24h redirect TTL, both still inside retention. This
    // is the property the issue is about — the old url must resolve, not 404, while any cache
    // can still be holding it.
    expect(destroyedIds()).not.toContain(JUST_INSIDE_ID);
    expect(destroyedIds()).not.toContain(RECENT_ID);
    expect(dequeuedIds()).not.toContain(JUST_INSIDE_ID);
    expect(dequeuedIds()).not.toContain(RECENT_ID);
  });

  it('measures the window from the queue row, at the declared retention', async () => {
    await runJob();

    const cutoff: Date = queueWhere().createdAt.lt;
    const expected = Date.now() - REPLACED_IMAGE_RETENTION_DAYS * DAY;
    expect(REPLACED_IMAGE_RETENTION_DAYS).toBe(30);
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(60_000);
    expect(queueWhere()).toMatchObject({
      type: JobQueueType.ReplacedImageDelete,
      entityType: EntityType.Image,
    });
  });

  it("never reaps an image that is somebody's profile picture again", async () => {
    const result = await runJob();

    // Re-adoption: the queue row is 40 days old, but the image is live. Destroying it would
    // break the avatar of a user who never replaced anything.
    expect(destroyedIds()).not.toContain(READOPTED_ID);
    expect(result.readopted).toBe(1);
  });

  it('dequeues the re-adopted image so it is not re-examined every run', async () => {
    await runJob();

    expect(dequeuedIds()).toContain(READOPTED_ID);
    expect(dequeuedIds()).toContain(EXPIRED_ID);
    expect(dequeuedIds()).toContain(JUST_EXPIRED_ID);
  });

  it('addresses the queue with the same key the writer uses', async () => {
    await runJob();

    expect(dequeue()!.values).toContain(JobQueueType.ReplacedImageDelete);
    expect(dequeue()!.values).toContain(EntityType.Image);
  });

  it('deletes nothing against a non-prod database', async () => {
    mockEnv.DATABASE_IS_PROD = false;

    await runJob();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(dequeue()).toBeUndefined();
  });
});
