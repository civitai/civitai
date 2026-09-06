import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { BlockedReason } from '~/server/common/enums';
import { PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

/**
 * 🔴 REACHABILITY GUARD, not a unit test of a filter.
 *
 * `remove-blocked-images` is the one job allowed to ask the image-cache service to destroy the
 * SHARED, content-addressed stored object behind an image — which removes the full-resolution
 * original for every byte-identical image of every other owner. It first asked for that on the
 * reasoning that "Blocked, still Blocked, not AiNotVerified, and past the retention window" made
 * every image it deletes a moderation takedown.
 *
 * That reasoning is a statement about the DIRECT callers of `deleteImages`. It is NOT a statement
 * about what reaches `remove-blocked-images`, because that job reads a QUEUE, and one of that
 * queue's writers is not a moderation flow at all: a user who deletes their OWN account and picks
 * "delete my images after 7 days" has every one of their images set to `ingestion = 'Blocked'`,
 * `blockedFor = 'moderated'` by `remove-deleted-user-images`, and then enqueued as
 * `BlockedImageDelete`. Nothing was moderated, and `blockedFor` cannot tell the two cases apart —
 * that is stated at `PRIOR_INGESTION_KEY`, which is the marker the job now splits the batch on.
 *
 * So this test drives the whole path — self-service account deletion → grace block → job queue →
 * retention purge — and asserts that the purge does NOT request retraction for those images. A
 * test that only checked the filter's return value would have passed against the defect, because
 * the defect was that nothing on this path was ever consulted.
 *
 * The contrast case in the same run is what stops the trivial "fix" of never retracting at all:
 * a genuinely moderator-blocked image, in the same batch, MUST still be retracted.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Deleted their own account 8 days ago and chose to keep their images for the grace period. */
const GRACE_USER = 501;
/** An ordinary, live account. One of their images was taken down by a moderator. */
const MOD_USER = 502;

const GRACE_IMAGE = 1;
const MODERATED_IMAGE = 2;

type ImageRow = {
  id: number;
  userId: number;
  postId: number | null;
  ingestion: 'Pending' | 'Scanned' | 'Blocked';
  blockedFor: string | null;
  metadata: Record<string, unknown>;
};

type UserRow = { id: number; deletedAt: Date | null; imageRemoval: string | null };

type QueueRow = { entityId: number; createdAt: Date };

const store = {
  images: [] as ImageRow[],
  users: [] as UserRow[],
  queue: [] as QueueRow[],
};

const { mockDeleteImages } = vi.hoisted(() => ({
  mockDeleteImages: vi.fn(async (ids: number[]) => ids.map((id) => ({ id }))),
}));

// `isProd` alone is overridden; the rest of the module is spread so nothing else in the graph
// loses an export it imports.
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

// Hand-listed rather than spread from the real module, for the reason the sibling retention
// test gives: image.service is ~8k lines and builds module-scope caches on import. These four
// are every export the two jobs under test import from it.
vi.mock('~/server/services/image.service', () => ({
  deleteImages: mockDeleteImages,
  ingestImage: vi.fn(async () => true),
  invalidateManyImageExistence: vi.fn(async () => undefined),
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/post.service', () => ({
  bustCachesForPosts: vi.fn(async () => undefined),
}));

const { removeDeletedUserImages } = await import('~/server/jobs/remove-deleted-user-images');
const { removeBlockedImages } = await import('~/server/jobs/image-ingestion');

// ─────────────────────────────────────────────────────────────────────────────
// A small in-memory stand-in for the two tables both jobs share. Statements are
// routed on a fragment of their own SQL and applied to `store`, so the SECOND job
// reads what the FIRST job wrote — which is the whole point: the defect lived in the
// hand-off between them, and a per-job fixture cannot express it.
// ─────────────────────────────────────────────────────────────────────────────

/** The ids carried by a `Prisma.join(...)` fragment, which arrives as one interpolated value. */
function joinedIds(values: unknown[]): number[] {
  const frag = values.find(
    (v) => !!v && typeof v === 'object' && Array.isArray((v as { values?: unknown }).values)
  ) as { values: number[] } | undefined;
  return frag?.values ?? [];
}

function user(id: number) {
  return store.users.find((u) => u.id === id);
}

/** The worklist's own predicate: a grace account still has work only while it owns a live image. */
function hasWork(u: UserRow) {
  const immediate = u.imageRemoval == null || u.imageRemoval === 'immediate';
  return store.images.some(
    (i) =>
      i.userId === u.id &&
      (immediate || i.ingestion !== 'Blocked' || i.blockedFor === BlockedReason.AiNotVerified)
  );
}

function candidates(within: (deletedAt: Date) => boolean, direction: 'asc' | 'desc') {
  return store.users
    .filter((u) => u.deletedAt != null && within(u.deletedAt) && hasWork(u))
    .sort((a, b) =>
      direction === 'asc'
        ? a.deletedAt!.getTime() - b.deletedAt!.getTime()
        : b.deletedAt!.getTime() - a.deletedAt!.getTime()
    )
    .map((u) => ({
      id: u.id,
      deletedAt: u.deletedAt!,
      mode:
        u.imageRemoval == null || u.imageRemoval === 'immediate'
          ? ('immediate' as const)
          : ('grace' as const),
    }));
}

async function runQuery(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.join('?');

  // remove-blocked-images: open CSAM reports. None in this fixture.
  if (sql.includes('FROM "CsamReport"') && sql.includes('GROUP BY')) return [];

  // remove-deleted-user-images: the two account-state re-reads. They differ by whether the
  // predicate also inspects the stored removal choice.
  if (sql.includes('AS "stillDeleted"')) {
    const u = user(values[0] as number);
    const deleted = !!u?.deletedAt;
    if (sql.includes("'imageRemoval'")) {
      const immediate = u?.imageRemoval == null || u?.imageRemoval === 'immediate';
      return [{ stillDeleted: deleted && immediate }];
    }
    return [{ stillDeleted: deleted }];
  }

  // remove-deleted-user-images: the grace pass's worklist of images to hide or repoint.
  // Bindings, in order: userId, the AiNotVerified reason, the per-run budget.
  if (sql.includes('AS "wasBlocked"')) {
    const [userId, , budget] = values as [number, string, number];
    return store.images
      .filter(
        (i) =>
          i.userId === userId &&
          (i.ingestion !== 'Blocked' || i.blockedFor === BlockedReason.AiNotVerified)
      )
      .slice(0, budget)
      .map((i) => ({ id: i.id, wasBlocked: i.ingestion === 'Blocked' }));
  }

  // remove-deleted-user-images: the hide branch. Bindings, in order: the blocked nsfwLevel, the
  // blockedFor reason, the metadata key, the id list, userId, userId.
  //
  // 🔴 The metadata key is taken from the BINDING, never from the constant imported at the top of
  // this file. That is what makes the marker a real seam between the two jobs: if the writer here
  // and the reader in remove-blocked-images stop spelling it the same way, the lookup misses and
  // this test goes red.
  if (sql.includes('UPDATE "Image"') && sql.includes("SET ingestion = 'Blocked'")) {
    const [, blockedFor, priorIngestionKey] = values as [number, string, string];
    const ids = joinedIds(values);
    const touched: { id: number; postId: number | null }[] = [];
    for (const img of store.images) {
      if (!ids.includes(img.id) || img.ingestion === 'Blocked') continue;
      img.metadata = { ...img.metadata, [priorIngestionKey]: img.ingestion };
      img.ingestion = 'Blocked';
      img.blockedFor = blockedFor;
      touched.push({ id: img.id, postId: img.postId });
    }
    return touched;
  }

  // remove-deleted-user-images: does the account still own anything the grace pass has not hidden?
  if (sql.includes('AS "hasPending"')) {
    const userId = values[0] as number;
    return [
      {
        hasPending: store.images.some(
          (i) =>
            i.userId === userId &&
            (i.ingestion !== 'Blocked' || i.blockedFor === BlockedReason.AiNotVerified)
        ),
      },
    ];
  }

  // remove-deleted-user-images: the two worklists. Fresh is ascending and bounded below by the
  // high-water mark; backlog is descending and bounded above by its cursor and by that mark.
  if (sql.includes('CROSS JOIN LATERAL')) {
    if (sql.includes('ORDER BY u."deletedAt" DESC')) {
      const [cursor, freshMark] = values as [Date, Date];
      return candidates((d) => d <= cursor && d < freshMark, 'desc');
    }
    const freshMark = values[0] as Date;
    return candidates((d) => d >= freshMark, 'asc');
  }

  // remove-blocked-images: the batch fetch, scoped to the ids that survived the queue exclusion.
  //
  // 🔴 `fromAccountDeletion` is computed from the key the JOB binds, for the same reason as the
  // writer above. Before the fix the job binds no key at all, so the column is `undefined` — which
  // is exactly the state the defect consisted of, and the assertions below then fail.
  if (sql.includes('FROM "Image"') && sql.includes('id = ANY')) {
    const boundKey = values.find((v) => typeof v === 'string') as string | undefined;
    const ids = (values.find(Array.isArray) as number[] | undefined) ?? [];
    return store.images
      .filter((i) => ids.includes(i.id) && i.ingestion === 'Blocked')
      .map((i) => ({
        id: i.id,
        userId: i.userId,
        blockedFor: i.blockedFor,
        fromAccountDeletion: boundKey ? i.metadata[boundKey] != null : undefined,
      }));
  }

  throw new Error(`unrouted query in fixture: ${sql.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
}

async function runExec(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.join('?');

  // remove-deleted-user-images: hand the now-blocked images to the retention queue.
  if (sql.includes('INSERT INTO "JobQueue"')) {
    const userId = values[0] as number;
    let inserted = 0;
    for (const img of store.images) {
      if (img.userId !== userId) continue;
      if (img.ingestion !== 'Blocked') continue;
      if (img.blockedFor === BlockedReason.AiNotVerified) continue;
      if (store.queue.some((q) => q.entityId === img.id)) continue;
      store.queue.push({ entityId: img.id, createdAt: new Date() });
      inserted++;
    }
    return inserted;
  }

  // remove-blocked-images: evict processed and stale rows from the queue.
  if (sql.includes('DELETE FROM "JobQueue"')) {
    const ids = (values.find(Array.isArray) as number[] | undefined) ?? [];
    const before = store.queue.length;
    store.queue = store.queue.filter((q) => !ids.includes(q.entityId));
    return before - store.queue.length;
  }

  throw new Error(
    `unrouted statement in fixture: ${sql.replace(/\s+/g, ' ').trim().slice(0, 160)}`
  );
}

const ctx = {} as Parameters<typeof removeBlockedImages.run>[0];

/**
 * The retraction intent for one image, read off whichever `deleteImages` call carried it.
 * `undefined` means the image was never deleted at all — deliberately distinct from `false`, so a
 * path that silently stops deleting cannot satisfy a "did not retract" assertion.
 */
function retractionFor(id: number) {
  const call = mockDeleteImages.mock.calls.find((c) => (c[0] as number[]).includes(id));
  if (!call) return undefined;
  return Boolean((call[2] as { retractPublicBlobs?: boolean } | undefined)?.retractPublicBlobs);
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ DATABASE_IS_PROD: true });

  store.images = [
    // The grace account's live image. Nothing has been moderated about it.
    {
      id: GRACE_IMAGE,
      userId: GRACE_USER,
      postId: null,
      ingestion: 'Scanned',
      blockedFor: null,
      metadata: {},
    },
    // A real takedown on a live account: already Blocked, and carrying no account-deletion marker.
    {
      id: MODERATED_IMAGE,
      userId: MOD_USER,
      postId: null,
      ingestion: 'Blocked',
      blockedFor: BlockedReason.Moderated,
      metadata: {},
    },
  ];
  store.users = [
    { id: GRACE_USER, deletedAt: new Date(Date.now() - 8 * DAY), imageRemoval: 'grace' },
    { id: MOD_USER, deletedAt: null, imageRemoval: null },
  ];
  // The moderator's block is already past the retention window.
  store.queue = [{ entityId: MODERATED_IMAGE, createdAt: new Date(Date.now() - 8 * DAY) }];

  // An operator-set purge budget; the drain is inert at the compiled-in default of 0.
  redisMock.sysRedis.get.mockResolvedValue('100');
  dbMock.dbRead.$queryRaw.mockImplementation(runQuery);
  dbMock.dbWrite.$queryRaw.mockImplementation(runQuery);
  dbMock.dbWrite.$executeRaw.mockImplementation(runExec);
  dbMock.dbRead.jobQueue.findMany.mockImplementation(
    async ({ where }: { where?: { entityId?: { notIn?: number[] } } }) => {
      // Stand in for the DB actually applying the held-media exclusion.
      const excluded = where?.entityId?.notIn ?? [];
      return store.queue.filter((q) => !excluded.includes(q.entityId));
    }
  );
});

describe('self-service account deletion never reaches blob retraction', () => {
  it('takes the grace path all the way into the retention queue', async () => {
    // POSITIVE CONTROL for everything below. If the grace pass does not run, the image is never
    // Blocked and never queued, and the retraction assertions in the next test are satisfied by an
    // image that simply is not there.
    await removeDeletedUserImages.run(ctx).result;

    const img = store.images.find((i) => i.id === GRACE_IMAGE)!;
    expect(img.ingestion).toBe('Blocked');
    // The collision the fix has to see through: an account deletion and a moderator takedown write
    // the SAME reason.
    expect(img.blockedFor).toBe(BlockedReason.Moderated);
    expect(img.metadata[PRIOR_INGESTION_KEY]).toBe('Scanned');
    expect(store.queue.map((q) => q.entityId)).toContain(GRACE_IMAGE);
  });

  it('deletes the grace images without asking for retraction, while still retracting a takedown', async () => {
    await removeDeletedUserImages.run(ctx).result;
    // Age the grace block past the retention window, which is what makes it purgeable. The queue
    // row's own createdAt is the clock.
    for (const q of store.queue) {
      if (q.entityId === GRACE_IMAGE) q.createdAt = new Date(Date.now() - 8 * DAY);
    }
    mockDeleteImages.mockClear();

    await removeBlockedImages.run(ctx).result;

    // The purge itself is unchanged: both images are still hard-deleted on schedule.
    expect(mockDeleteImages).toHaveBeenCalled();
    expect(retractionFor(GRACE_IMAGE)).not.toBeUndefined();
    expect(retractionFor(MODERATED_IMAGE)).not.toBeUndefined();

    // 🔴 THE REGRESSION. Nothing about this image was moderated, so destroying the shared stored
    // object — and with it the original of every byte-identical image of every other owner — is
    // not something this flow may ask for.
    expect(
      retractionFor(GRACE_IMAGE),
      'an account-deletion grace block reached the retracting call: a user deleting their own ' +
        'account must not destroy other owners’ stored bytes'
    ).toBe(false);

    // Both directions. Turning retraction off wholesale would satisfy the assertion above while
    // silently removing the capability altogether, so takedowns would go back to leaving the bytes
    // in place with nothing to say so.
    expect(
      retractionFor(MODERATED_IMAGE),
      'a moderator takedown stopped asking for retraction'
    ).toBe(true);
  });
});
