import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { BlockedReason } from '~/server/common/enums';
import { PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

/**
 * 🔴 REACHABILITY GUARD for a cross-account destructive capability.
 *
 * `remove-blocked-images` is the one flow allowed to pass `retractPublicBlobs`, which asks the
 * image-cache service to destroy the SHARED, content-addressed stored object behind an image —
 * removing the full-resolution original for every byte-identical image of every OTHER owner,
 * irreversibly, with no way to enumerate or notify them.
 *
 * The job reads a QUEUE that a database trigger fills on any write landing
 * `ingestion = 'Blocked'` with a `blockedFor` other than 'AiNotVerified'. So the population that
 * reaches the retraction decision is chosen by that queue's WRITERS, and testing the job's filter
 * against hand-built rows proves nothing about them: the question is what each real writer
 * actually produces.
 *
 * This file therefore drives the REAL writers into a store that implements the REAL trigger, then
 * runs the REAL job over the queue that results. Only `deleteImages` is replaced, so the
 * retraction argument is observable; every function that decides whether an image is blocked, and
 * every function that records who blocked it, is the shipping one.
 *
 * ── WHAT EACH TEST PINS ──────────────────────────────────────────────────────────────────────
 *   F1  an uploader cannot move the decision. `Image.metadata` is `z.record(z.string(), z.any())`
 *       and `createImage` spreads it verbatim into the row, so the uploader controls its contents
 *       completely — including a key spelled exactly like an internal marker, and including the
 *       value JSON `null`, for which Postgres' `->` returns a non-NULL jsonb null. The images here
 *       are created through the real `createImage` with that forgery in place, in both shapes.
 *   F2  an automated block does not retract: the content-rating branch of the real
 *       `processImageScanWorkflow`.
 *   F3  a whole-library ban block does not retract: the real `toggleBan`'s remove-all-media branch.
 *   +   a real moderator takedown DOES retract, so the guard cannot be satisfied by a change that
 *       simply stops retracting.
 */

const DAY = 24 * 60 * 60 * 1000;

const MOD_ID = 900;
const TAKEDOWN_USER = 901;
const SCANNED_USER = 902;
const BANNED_USER = 903;

type ImageRow = {
  id: number;
  userId: number;
  postId: number | null;
  url: string;
  ingestion: string;
  blockedFor: string | null;
  nsfwLevel: number;
  needsReview: string | null;
  pHash: bigint | null;
  metadata: Record<string, unknown> | null;
};
type QueueRow = { entityId: number; createdAt: Date };
type ModActivityRow = {
  userId: number | null;
  entityType: string | null;
  entityId: number | null;
  activity: string;
  createdAt: Date;
};

const store = {
  images: [] as ImageRow[],
  queue: [] as QueueRow[],
  modActivity: [] as ModActivityRow[],
  /**
   * Advances on every trigger fire and every ModActivity insert, so a row written after a block is
   * strictly later than that block's queue row even when the whole test runs inside one
   * millisecond. Real Postgres gets that ordering from the clock; here it has to be explicit, and
   * without it the job's `activity >= blockedAt` comparison would be decided by timer resolution.
   */
  clock: Date.now() - 30 * DAY,
};

function tick() {
  store.clock += 1000;
  return new Date(store.clock);
}

/**
 * `trg_blocked_image_delete_queue`, transcribed from
 * `packages/civitai-db-schema/prisma/migrations/20260806130000_blocked_image_delete_queue_completeness/migration.sql`.
 * It fires on INSERT and on any UPDATE OF ingestion/"blockedFor", and `create_job_queue_record` is
 * ON CONFLICT DO NOTHING — so an image already queued keeps its FIRST row's createdAt, which is
 * the retention clock and the timestamp the retraction decision compares against.
 */
function fireQueueTrigger(row: ImageRow) {
  if (row.ingestion !== 'Blocked') return;
  if (row.blockedFor === BlockedReason.AiNotVerified) return;
  if (store.queue.some((q) => q.entityId === row.id)) return;
  store.queue.push({ entityId: row.id, createdAt: tick() });
}

const { mockDeleteImages } = vi.hoisted(() => ({
  mockDeleteImages: vi.fn(async (ids: number[]) => ids.map((id) => ({ id }))),
}));

// `isProd` alone is overridden; the rest of the module is spread so nothing else in the graph
// loses an export it imports. The job short-circuits before deleting anything when it is false.
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

// 🔴 Consequence of that override, and the only one: `env/client-schema` reads the SAME `isProd`
// and makes `NEXT_PUBLIC_CIVITAI_LINK` required rather than optional when it is true, so
// `env/client` throws at import time and the whole file collects zero tests. Set here, at top
// level, because it has to land before the dynamic imports below evaluate that module. It is the
// only field that schema gates on `isProd`.
process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://link.test';

// event-engine-common is a git submodule and is not checked out by default; image.service's graph
// reaches it. Same three stubs the sibling retraction test uses.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

/**
 * 🔴 `importOriginal` and a spread, NOT a hand-listed stub. `handleBlockImages` and `createImage`
 * are two of the writers under test and must be the real implementations; only `deleteImages` is
 * replaced, and only because it is the boundary the retraction argument crosses.
 */
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteImages: mockDeleteImages,
}));

const { createImage, handleBlockImages } = await import('~/server/services/image.service');
const { trackModActivity } = await import('~/server/services/moderator.service');
const { setTosViolationHandler } = await import('~/server/controllers/image.controller');
const { toggleBan } = await import('~/server/services/user.service');
const { processImageScanWorkflow } = await import('~/server/services/image-scan-result.service');
const { removeBlockedImages, MODERATOR_TAKEDOWN_ACTIVITIES } = await import(
  '~/server/jobs/image-ingestion'
);

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

function image(id: number, userId: number, over: Partial<ImageRow> = {}): ImageRow {
  return {
    id,
    userId,
    postId: null,
    url: `key-${id}/original.jpeg`,
    ingestion: 'Scanned',
    blockedFor: null,
    nsfwLevel: 1,
    needsReview: null,
    pHash: null,
    metadata: null,
    ...over,
  };
}

/** Applies a prisma-shaped `where` for the two shapes the block writers use. */
function matches(row: ImageRow, where: any): boolean {
  if (!where) return true;
  if (where.id !== undefined) {
    if (typeof where.id === 'number' && row.id !== where.id) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
  }
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.ingestion?.not !== undefined && row.ingestion === where.ingestion.not) return false;
  return true;
}

function readQuery(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.join('?');

  if (sql.includes('FROM "CsamReport"')) return [];

  // remove-blocked-images: the batch fetch of everything still blocked.
  if (sql.includes('FROM "Image"') && sql.includes('id = ANY') && sql.includes('"blockedFor"')) {
    const ids = (values.find(Array.isArray) as number[] | undefined) ?? [];
    return store.images
      .filter((i) => ids.includes(i.id) && i.ingestion === 'Blocked')
      .map((i) => ({ id: i.id, userId: i.userId, blockedFor: i.blockedFor }));
  }

  // remove-blocked-images: the moderator-activity lookup that decides retraction.
  //
  // 🔴 The activity list is taken from the BINDING, never from the constant imported at the top of
  // this file. That makes it a real seam: if the job stops binding one, or binds a value no writer
  // produces, the lookup misses here exactly as it would in Postgres.
  if (sql.includes('FROM "ModActivity"')) {
    const ids = (values[0] as number[]) ?? [];
    const activities = (values[1] as string[]) ?? [];
    const out = new Map<number, Date>();
    for (const row of store.modActivity) {
      if (row.entityType !== 'image') continue;
      if (row.entityId == null || !ids.includes(row.entityId)) continue;
      if (!activities.includes(row.activity)) continue;
      const current = out.get(row.entityId);
      if (!current || row.createdAt > current) out.set(row.entityId, row.createdAt);
    }
    return [...out].map(([entityId, lastActedAt]) => ({ entityId, lastActedAt }));
  }

  return [];
}

function writeExec(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.join('?');

  if (sql.includes('INSERT INTO "ModActivity"')) {
    const [userId, entityType, activity] = values as [number, string, string];
    const ids = (values.find(Array.isArray) as number[] | undefined) ?? [];
    for (const entityId of ids)
      store.modActivity.push({ userId, entityType, activity, entityId, createdAt: tick() });
    return ids.length;
  }

  // The account-deletion marker strip the moderation block sites now issue.
  //
  // `("metadata" -> key) IS NOT NULL` is modelled as "the key is PRESENT", not as
  // `value != null`: for a JSON null, `->` returns the jsonb null, which is not SQL NULL, so
  // Postgres says TRUE where a JS `!= null` says false. Modelling it the JS way is how a fixture
  // stops being able to see the cheapest forgery shape.
  if (sql.includes('UPDATE "Image"') && sql.includes('- ?::text')) {
    // Bindings, in order: the two key names, then the scope (an id array or a userId), then the
    // first key again for the presence test.
    const [keyA, keyB, scope] = values as [string, string, number[] | number];
    let n = 0;
    for (const row of store.images) {
      const scoped = Array.isArray(scope) ? scope.includes(row.id) : row.userId === scope;
      if (!scoped) continue;
      if (!row.metadata || !(keyA in row.metadata)) continue;
      const keys = [keyA, keyB];
      const next = { ...row.metadata };
      for (const k of keys) delete next[k];
      row.metadata = next;
      n++;
    }
    return n;
  }

  if (sql.includes('DELETE FROM "JobQueue"')) {
    const ids = (values.find(Array.isArray) as number[] | undefined) ?? [];
    const before = store.queue.length;
    store.queue = store.queue.filter((q) => !ids.includes(q.entityId));
    return before - store.queue.length;
  }

  return 0;
}

beforeEach(async () => {
  vi.clearAllMocks();
  setEnv({ DATABASE_IS_PROD: true });
  store.images = [];
  store.queue = [];
  store.modActivity = [];
  store.clock = Date.now() - 30 * DAY;

  dbMock.dbRead.$queryRaw.mockImplementation(readQuery as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(readQuery as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(writeExec as never);
  dbMock.dbRead.$executeRaw.mockImplementation(writeExec as never);

  dbMock.dbRead.image.findMany.mockImplementation(async ({ where }: any) =>
    store.images.filter((i) => matches(i, where))
  );
  dbMock.dbWrite.image.findMany.mockImplementation(async ({ where }: any) =>
    store.images.filter((i) => matches(i, where))
  );
  dbMock.dbWrite.image.create.mockImplementation(async ({ data }: any) => {
    const row = image(data.id, data.userId, {
      metadata: data.metadata ?? null,
      url: data.url ?? `key-${data.id}/original.jpeg`,
      ingestion: data.ingestion ?? 'Pending',
    });
    store.images.push(row);
    fireQueueTrigger(row);
    return row;
  });
  const applyUpdate = async ({ where, data }: any) => {
    let count = 0;
    for (const row of store.images) {
      if (!matches(row, where)) continue;
      Object.assign(row, {
        ...(data.ingestion !== undefined ? { ingestion: data.ingestion } : {}),
        ...(data.blockedFor !== undefined ? { blockedFor: data.blockedFor } : {}),
        ...(data.needsReview !== undefined ? { needsReview: data.needsReview } : {}),
        ...(data.nsfwLevel !== undefined ? { nsfwLevel: data.nsfwLevel } : {}),
      });
      fireQueueTrigger(row);
      count++;
    }
    return { count };
  };
  dbMock.dbWrite.image.updateMany.mockImplementation(applyUpdate as never);
  dbMock.dbWrite.image.update.mockImplementation((async (args: any) =>
    applyUpdate({ where: args.where, data: args.data })) as never);

  dbMock.dbRead.jobQueue.findMany.mockImplementation(async ({ where }: any) => {
    const excluded = where?.entityId?.notIn ?? [];
    return store.queue.filter((q) => !excluded.includes(q.entityId));
  });

  // The shared db mock only defaults the READ verbs; `toggleBan` fires several fire-and-forget
  // writes whose result it immediately `.catch()`es, and an undefined return throws before the
  // remove-media branch is reached. These are not what is under test — they only have to resolve.
  for (const model of ['userLink', 'model', 'comment', 'commentV2', 'post', 'article'] as const) {
    dbMock.dbWrite[model].deleteMany?.mockResolvedValue({ count: 0 } as never);
    dbMock.dbWrite[model].updateMany?.mockResolvedValue({ count: 0 } as never);
  }

  // `toggleBan` reads the account before it does anything; the permissive default (null) would
  // make it throw NotFound and the ban branch would never run.
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    id: BANNED_USER,
    bannedAt: null,
    meta: {},
    username: 'banned',
    email: 'banned@example.test',
  } as never);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({
    id: BANNED_USER,
    bannedAt: null,
    meta: {},
    username: 'banned',
    email: 'banned@example.test',
  } as never);
});

/**
 * Ages the whole fixture timeline past the 7-day retention window so the job will act on it.
 *
 * 🔴 A uniform SHIFT, not an assignment. Stamping every queue row and every activity row with two
 * fixed timestamps would make `activity.createdAt >= queue.createdAt` true by construction, and
 * the job's ordering comparison would be unreachable — the tests below that exist to reach it
 * would pass with it deleted. Shifting preserves every relative order the writers produced.
 */
function ageQueuePastRetention() {
  const shift = Date.now() - 8 * DAY - store.clock;
  for (const q of store.queue) q.createdAt = new Date(q.createdAt.getTime() + shift);
  for (const a of store.modActivity) a.createdAt = new Date(a.createdAt.getTime() + shift);
  store.clock += shift;
}

describe('who can reach blob retraction, driven through the real block writers', () => {
  it('the activity vocabulary the job binds is the one the moderator block writes', async () => {
    // Seam control. Everything below rests on the job and the writers agreeing on a value; this
    // pins that agreement directly rather than leaving it to be inferred from an outcome.
    store.images.push(image(1, TAKEDOWN_USER));

    await handleBlockImages({ ids: [1], moderatorId: MOD_ID });

    const written = store.modActivity.filter((a) => a.entityType === 'image' && a.entityId === 1);
    expect(written.length, 'the moderator block recorded no per-image activity').toBeGreaterThan(0);
    expect(
      written.some((a) => (MODERATOR_TAKEDOWN_ACTIVITIES as readonly string[]).includes(a.activity)),
      `the block writes ${written.map((a) => a.activity).join(',')}, which the job does not look for`
    ).toBe(true);
  });

  it('retracts for a real moderator takedown', async () => {
    store.images.push(image(1, TAKEDOWN_USER));

    await handleBlockImages({ ids: [1], moderatorId: MOD_ID });
    expect(store.queue.map((q) => q.entityId), 'the trigger did not queue the block').toEqual([1]);
    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    expect(retractionFor(1), 'a moderator takedown stopped asking for retraction').toBe(true);
  });

  // The main app's own single-image TOS takedown. It is `moderatorProcedure`-gated and per-image,
  // so it belongs on the retracting side — but until this change it recorded no `ModActivity` at
  // all, which under a positive discriminator means it would have been silently demoted to
  // delete-without-retraction. Driven through the handler, not through the write it makes.
  it('retracts for the main-app TOS takedown handler', async () => {
    store.images.push(image(11, TAKEDOWN_USER, { postId: 55 }));
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      nsfwLevel: 1,
      userId: TAKEDOWN_USER,
      postId: 55,
      pHash: null,
      post: { title: 'a post' },
    } as never);

    await setTosViolationHandler({
      input: { id: 11 },
      ctx: {
        user: { id: MOD_ID, isModerator: true },
        ip: '127.0.0.1',
        track: { images: vi.fn(async () => undefined) },
      },
    } as never);

    expect(store.images.find((i) => i.id === 11)!.ingestion, 'the handler did not block').toBe(
      'Blocked'
    );
    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    expect(
      retractionFor(11),
      'the main-app TOS takedown stopped asking for retraction — check it still records ModActivity'
    ).toBe(true);
  });

  // 🔴 F1. The uploader owns `Image.metadata`, so anything the retraction decision reads out of it
  // is a field the image's own owner writes. Both shapes are exercised: a plausible value, and
  // JSON `null` — which is the cheaper forgery, because `("metadata" -> key) IS NOT NULL` is TRUE
  // for it while the sibling reader's `->>` form returns SQL NULL and skips it.
  for (const [label, forged] of [
    ['a plausible value', 'Scanned'],
    ['JSON null', null],
  ] as const) {
    it(`ignores a forged marker (${label}) carried through the real upload path`, async () => {
      await createImage({
        id: 2,
        userId: TAKEDOWN_USER,
        url: 'key-2/original.jpeg',
        type: 'image',
        metadata: { [PRIOR_INGESTION_KEY]: forged },
        // The scan enqueue is a live HTTP call and is not what is under test here; the write
        // this test reads happens before it either way.
        skipIngestion: true,
      } as never);

      const created = store.images.find((i) => i.id === 2);
      // Positive control on the forgery itself. If `createImage` ever starts stripping the key,
      // this test would go on passing while proving nothing about the job.
      expect(
        created?.metadata && PRIOR_INGESTION_KEY in created.metadata,
        'the upload path no longer stores the forged key — this test can no longer see the attack'
      ).toBe(true);

      await handleBlockImages({ ids: [2], moderatorId: MOD_ID });
      ageQueuePastRetention();
      await removeBlockedImages.run(ctx).result;

      expect(
        retractionFor(2),
        'an uploader exempted their own image from a moderator takedown by writing a metadata key'
      ).toBe(true);
    });
  }

  // The other direction of the same forgery, and the more dangerous one under a POSITIVE
  // discriminator: a marker that turns retraction ON would let an uploader destroy the shared
  // object behind any byte-identical image simply by getting their own copy blocked.
  it('a forged marker cannot make an automated block retract', async () => {
    await createImage({
      id: 3,
      userId: SCANNED_USER,
      url: 'key-3/original.jpeg',
      type: 'image',
      metadata: { [PRIOR_INGESTION_KEY]: 'Scanned', moderatorReviewed: true, review: true },
      skipIngestion: true,
    } as never);

    await blockByScanner(3);
    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    expect(retractionFor(3), 'the image was not deleted at all').not.toBeUndefined();
    expect(
      retractionFor(3),
      'an uploader turned retraction ON for their own image by writing a metadata key'
    ).toBe(false);
  });

  // 🔴 F2. The orchestrator content rating hard-blocks an image with no moderator involved. It is
  // driven here through `processImageScanWorkflow`, the exported entry point the webhook calls.
  it('does not retract for an automated content-rating block', async () => {
    store.images.push(image(4, SCANNED_USER));

    await blockByScanner(4);
    const row = store.images.find((i) => i.id === 4)!;
    // Positive control: the branch under test actually ran, and produced exactly the shape the
    // trigger enqueues. Without this the assertion below is satisfied by a scan that did nothing.
    expect(row.ingestion, 'the rating branch did not block the image').toBe('Blocked');
    expect(store.queue.map((q) => q.entityId)).toContain(4);
    expect(
      store.modActivity.filter((a) => a.entityId === 4),
      'the automated path recorded moderator activity'
    ).toEqual([]);

    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    expect(retractionFor(4), 'the image was not deleted at all').not.toBeUndefined();
    expect(
      retractionFor(4),
      'an automated scanner block reached the retracting call: no human decided this takedown'
    ).toBe(false);
  });

  // 🔴 F3. `toggleBan`'s remove-all-media branch blocks the banned account's ENTIRE library in one
  // statement. The moderator decided about an account, not about each image's bytes, and the ids
  // never reach a per-image record.
  it('does not retract for the ban whole-library block', async () => {
    store.images.push(image(5, BANNED_USER), image(6, BANNED_USER));

    await toggleBan({
      id: BANNED_USER,
      reasonCode: 'SexualMinor',
      userId: MOD_ID,
      isModerator: true,
      force: true,
      removeMedia: true,
    } as never);

    // Positive control: the branch ran and both images are queued.
    for (const id of [5, 6]) {
      expect(store.images.find((i) => i.id === id)!.ingestion, `image ${id} was not blocked`).toBe(
        'Blocked'
      );
      expect(store.queue.map((q) => q.entityId)).toContain(id);
    }

    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    for (const id of [5, 6]) {
      expect(retractionFor(id), `image ${id} was not deleted at all`).not.toBeUndefined();
      expect(
        retractionFor(id),
        'a whole-library ban block reached the retracting call: banning an account must not ' +
          'destroy other owners’ stored bytes'
      ).toBe(false);
    }
  });

  // 🔴 Reaches the ORDERING half of the predicate, which is otherwise dead code. A moderator who
  // looked at an image and left it up is a `review` row like any other; if existence alone
  // licensed retraction, every image a moderator has ever touched would retract on a later
  // automated block. The activity here is written by the real `trackModActivity`.
  it('does not retract when the only moderator activity predates the block', async () => {
    store.images.push(image(9, SCANNED_USER));

    await trackModActivity(MOD_ID, { entityType: 'image', entityId: 9, activity: 'review' });
    await blockByScanner(9);

    // Positive control on the ordering the case depends on. If these two ever land in the same
    // millisecond the comparison is satisfied by luck and the test proves nothing.
    const acted = store.modActivity.find((a) => a.entityId === 9)!.createdAt.getTime();
    const queued = store.queue.find((q) => q.entityId === 9)!.createdAt.getTime();
    expect(acted, 'the fixture did not order the activity before the block').toBeLessThan(queued);

    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    expect(retractionFor(9), 'the image was not deleted at all').not.toBeUndefined();
    expect(
      retractionFor(9),
      'a moderator glance from before the block licensed retraction of an automated one'
    ).toBe(false);
  });

  // 🔴 Reaches the VOCABULARY half. Setting a rating, resolving an appeal or restoring an image
  // are all moderator actions on one image, and none of them is a decision to destroy its bytes.
  it('does not retract for a moderator activity that is not a takedown', async () => {
    store.images.push(image(10, SCANNED_USER));

    await blockByScanner(10);
    await trackModActivity(MOD_ID, {
      entityType: 'image',
      entityId: 10,
      activity: 'setNsfwLevel',
    });

    const acted = store.modActivity.find((a) => a.entityId === 10)!.createdAt.getTime();
    const queued = store.queue.find((q) => q.entityId === 10)!.createdAt.getTime();
    // The opposite control to the test above: here the ordering DOES hold, so the only thing left
    // that can reject this image is the activity name.
    expect(acted, 'the fixture did not order the activity after the block').toBeGreaterThan(queued);
    expect(
      (MODERATOR_TAKEDOWN_ACTIVITIES as readonly string[]).includes('setNsfwLevel'),
      'setNsfwLevel is now counted as a takedown — this test no longer isolates the vocabulary'
    ).toBe(false);

    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    expect(retractionFor(10), 'the image was not deleted at all').not.toBeUndefined();
    expect(
      retractionFor(10),
      'a rating change was read as a decision to destroy the shared stored object'
    ).toBe(false);
  });

  // Not a retraction claim. `unblockAccountDeletionImages` restores an image on the presence of
  // the grace breadcrumb ALONE, and its docstring promises it will not put back content a
  // moderator hid — a promise that is false for any row marked first and blocked second, which is
  // an ordinary ordering (self-delete with grace, report lands on day 3, moderator blocks). The
  // block has to take the breadcrumb off for that promise to hold.
  for (const [label, marker] of [
    ['a plausible value', 'Scanned'],
    ['JSON null', null],
  ] as const) {
    it(`clears the account-deletion breadcrumb (${label}) when a moderator blocks`, async () => {
      store.images.push(
        image(12, TAKEDOWN_USER, {
          metadata: { [PRIOR_INGESTION_KEY]: marker, keepMe: 1 },
        })
      );

      await handleBlockImages({ ids: [12], moderatorId: MOD_ID });

      const meta = store.images.find((i) => i.id === 12)!.metadata;
      expect(
        meta && PRIOR_INGESTION_KEY in meta,
        'a later account restore would read this breadcrumb and un-block moderated content'
      ).toBe(false);
      // Nothing else about the row's metadata may move — the strip names two keys, not the object.
      expect(meta).toEqual({ keepMe: 1 });
    });
  }

  // Both populations in ONE batch, because the split is what is being tested and a per-case run
  // cannot tell "classified correctly" from "the job stopped retracting".
  it('separates the two populations inside a single batch', async () => {
    store.images.push(image(7, TAKEDOWN_USER), image(8, SCANNED_USER));

    await handleBlockImages({ ids: [7], moderatorId: MOD_ID });
    await blockByScanner(8);
    ageQueuePastRetention();
    await removeBlockedImages.run(ctx).result;

    expect(retractionFor(7)).toBe(true);
    expect(retractionFor(8)).toBe(false);
    // The purge itself is unchanged: both are still hard-deleted on schedule.
    expect(store.queue, 'the queue was not drained').toEqual([]);
  });
});

/**
 * The orchestrator content-rating block, driven through the exported webhook entry point rather
 * than the module-private `blockImageFromRating`. The scan continues past the block into tag
 * processing, which this fixture does not model; the throw is swallowed because the block write
 * has already happened by then and is what the assertions read.
 */
async function blockByScanner(imageId: number) {
  await processImageScanWorkflow({
    workflowId: `wf-${imageId}`,
    status: 'succeeded',
    imageId,
    steps: [
      { $type: 'wdTagging', output: { tags: {} } },
      {
        $type: 'mediaRating',
        output: { nsfwLevel: 'x', isBlocked: true, blockedReason: 'CSAM' },
      },
    ] as never,
  }).catch(() => undefined);
}
