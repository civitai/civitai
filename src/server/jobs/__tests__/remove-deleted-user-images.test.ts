import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockDbRead,
  mockDbWrite,
  mockDeleteImages,
  mockQueueSearchIndex,
  mockInvalidateExistence,
  mockBustCachesForPosts,
  mockLogToAxiom,
  mockSafeError,
  mockSysRedis,
  mockGetJobDate,
} = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
  mockDeleteImages: vi.fn(),
  mockQueueSearchIndex: vi.fn(async () => undefined),
  mockInvalidateExistence: vi.fn(async () => undefined),
  mockBustCachesForPosts: vi.fn(async () => undefined),
  mockLogToAxiom: vi.fn(async () => undefined),
  mockSafeError: vi.fn((e: unknown) => ({
    message: (e as Error).message,
    stack: (e as Error).stack,
  })),
  mockSysRedis: { get: vi.fn() },
  mockGetJobDate: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({
  deleteImages: mockDeleteImages,
  queueImageSearchIndexUpdate: mockQueueSearchIndex,
  invalidateManyImageExistence: mockInvalidateExistence,
}));
vi.mock('~/server/services/post.service', () => ({
  bustCachesForPosts: mockBustCachesForPosts,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  safeError: mockSafeError,
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { SYSTEM: { DELETED_USER_IMAGE_PURGE_LIMIT: 'k' } },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: mockGetJobDate,
}));

import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';
import {
  removeDeletedUserImages,
  CURSOR_START,
  DEFAULT_IMAGES_PER_RUN,
  FRESH_CURSOR_KEY as FRESH_KEY,
  BACKLOG_CURSOR_KEY as BACKLOG_KEY,
} from '~/server/jobs/remove-deleted-user-images';

/**
 * The suite stands in a tiny in-memory Postgres for the job: `seed()` interprets each SQL
 * statement the job issues against the fixtures, including the `deletedAt` gates, the removal
 * choice, the delete-queue trigger and both cursor bounds. A restored user is therefore only
 * protected if the job actually carries the gate — dropping it makes the fixture hand back the
 * rows and the restore tests fail.
 */
type Fixture = {
  deletedAt: Date;
  images: number[];
  /** `User.meta` as the replica hands it back, keyed as the job spells it. */
  meta?: Record<string, string>;
  /** `User.meta` as the primary holds it, when the two have not converged yet. */
  primaryMeta?: Record<string, string>;
  /** Per-image `ingestion`; an id absent from here is `Scanned`. */
  ingestion?: Record<number, string>;
  /** Per-image `blockedFor`; an id absent from here holds NULL. */
  blockedFor?: Record<number, string>;
  /** Per-image `postId`; an id absent from here holds NULL. */
  postIdOf?: Record<number, number>;
  /** Image ids holding a `JobQueue(BlockedImageDelete)` row. */
  jobQueue?: number[];
  /** Blocked by another writer in the window between the job's image read and its write. */
  blockAfterRead?: number[];
  posts?: number[];
  /** Still in the (replica-read) worklist, but the primary now says `deletedAt IS NULL`. */
  restored?: boolean;
  /** Restored in the window between a freshness check and the write that check guards. */
  restoredAfterCheck?: boolean;
  /** Restored once this many image batches have cleared the job's in-batch freshness check. */
  restoreAfterBatches?: number;
  /** Re-deleted as `grace` on the primary once this many in-batch checks have cleared. */
  graceAfterBatches?: number;
};

let fixtures: Record<number, Fixture> = {};
let cursorStore: Record<string, Date> = {};
let cursorSets: Record<string, Date[]> = {};
let imageLimits: number[] = [];
let pagedImageIds: number[] = [];
let deletedPostIds: number[] = [];
let blockedUpdates: Record<string, unknown>[] = [];
let batchChecks: Record<number, number> = {};

/** The atom that keeps already-blocked rows out of a pass. */
const SKIPS_BLOCKED = `ingestion <> 'Blocked'`;
/** The atom that scopes a statement to rows that are already blocked. */
const TAKES_BLOCKED = `ingestion = 'Blocked'`;
/** The parenthesised form of the choice check on the destructive path. */
const IMMEDIATE_PREDICATE = /\((u\.meta->>'[^']*' IS NULL OR u\.meta->>'[^']*' = '[^']*')\)/;

const AI_NOT_VERIFIED = 'AiNotVerified';

const ingestionOf = (fixture: Fixture, id: number) => fixture.ingestion?.[id] ?? 'Scanned';
const blockedForOf = (fixture: Fixture, id: number) => fixture.blockedFor?.[id] ?? null;

/** The atom that pulls `AiNotVerified` rows back in so the purge job will accept them. */
const takesAiNotVerified = (sql: string, values: unknown[]) =>
  /"blockedFor" = \?/.test(sql) && values.includes(AI_NOT_VERIFIED);

/**
 * Reads the pass's own image predicate out of the statement rather than assuming one spelling, so
 * dropping either atom in the job shows up as the fixture handing back the wrong set of rows.
 */
function pendingImages(sql: string, values: unknown[], fixture: Fixture) {
  const skipsBlocked = sql.includes(SKIPS_BLOCKED);
  const takesAi = takesAiNotVerified(sql, values);
  return fixture.images.filter((id) => {
    if (!skipsBlocked) return true;
    if (ingestionOf(fixture, id) !== 'Blocked') return true;
    return takesAi && blockedForOf(fixture, id) === AI_NOT_VERIFIED;
  });
}

/**
 * Answers the meta atoms of a predicate from a given `meta` map. Each atom is read down to the
 * key it names and that key is what the fixture is asked for: the key is a bare literal on both
 * sides of the app, so a rename that only lands here has to surface as a user the fixture reports
 * no choice for.
 */
function metaHolds(condition: string, meta: Record<string, string> | undefined) {
  return condition.split(/\s+OR\s+/).some((atom) => {
    const key = /meta->>'([^']*)'/.exec(atom)?.[1];
    const choice = key == null ? undefined : meta?.[key];
    return atom.includes('IS NULL') ? choice == null : choice === /= '([^']*)'/.exec(atom)?.[1];
  });
}

/**
 * Evaluates the worklist's mode expression instead of pattern-matching one accepted spelling of
 * it, so a `CASE` that normalizes the wrong way reads as the wrong mode rather than as no
 * normalization at all.
 */
function modeExpression(sql: string) {
  const branches = /CASE\s+WHEN ([\s\S]+?)\s+THEN '(\w+)' ELSE '(\w+)'\s+END AS mode/.exec(sql);
  if (!branches) throw new Error(`unrecognized mode expression: ${sql}`);

  const [, condition, whenTrue, whenFalse] = branches;
  return (fixture: Fixture) => (metaHolds(condition, fixture.meta) ? whenTrue : whenFalse);
}

/** The primary-side statements re-read the choice; absent from the SQL means they do not. */
function passesPrimaryChoice(sql: string, fixture: Fixture) {
  const predicate = IMMEDIATE_PREDICATE.exec(sql)?.[1];
  if (!predicate) return true;
  return metaHolds(predicate, fixture.primaryMeta ?? fixture.meta);
}

function splitAssignments(body: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Reads the `SET` assignments back out of the statement — a literal off the SQL text, a `?` off
 * the parameter list — so the recorded row is what the job actually wrote rather than what the
 * test expects it to write. The jsonb merge keeps its source expressions: they read the *old*
 * row, so only the per-image applier can resolve them.
 */
function parseSetClause(sql: string, params: unknown[]) {
  const body = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf('WHERE'));
  const queue = [...params];
  const row: Record<string, unknown> = {};
  for (const assignment of splitAssignments(body)) {
    const split = assignment.indexOf('=');
    const column = assignment.slice(0, split).trim().replace(/"/g, '');
    const value = assignment.slice(split + 1).trim();

    if (value === '?') row[column] = queue.shift();
    else if (value === 'now()') row[column] = new Date();
    else if (value === 'NULL') row[column] = null;
    else if (value.startsWith('"metadata" || jsonb_build_object(')) {
      const args = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')')).split(',');
      const merge: { key: string; source: string }[] = [];
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i].trim();
        merge.push({
          key: key.startsWith('?') ? (queue.shift() as string) : key.replace(/'/g, ''),
          source: args[i + 1].trim(),
        });
      }
      row[column] = merge;
    } else row[column] = value.replace(/::.*$/, '').replace(/'/g, '');
  }
  return row;
}

function resolveMetadata(
  merge: { key: string; source: string }[],
  fixture: Fixture,
  id: number
): Record<string, unknown> {
  return Object.fromEntries(
    merge.map(({ key, source }) => {
      const column = source.replace(/::.*$/, '').replace(/"/g, '');
      if (column === 'ingestion') return [key, ingestionOf(fixture, id)];
      if (column === 'blockedFor') return [key, blockedForOf(fixture, id)];
      throw new Error(`unhandled metadata source: ${source}`);
    })
  );
}

function enqueueBlockedDelete(fixture: Fixture, id: number) {
  const queue = (fixture.jobQueue ??= []);
  if (queue.includes(id)) return false;
  queue.push(id);
  return true;
}

/** Stands in for `trg_blocked_image_delete_queue`: an `ingestion` transition into Blocked only. */
function fireBlockedDeleteTrigger(
  fixture: Fixture,
  id: number,
  before: string,
  row: Record<string, unknown>
) {
  if (row.ingestion !== 'Blocked' || before === 'Blocked') return;
  if (row.blockedFor === AI_NOT_VERIFIED) return;
  enqueueBlockedDelete(fixture, id);
}

function applyImageUpdate(sql: string, values: unknown[]) {
  const joined = values.findIndex((v) => Array.isArray((v as { values?: number[] })?.values));
  const ids = ((values[joined] as { values?: number[] })?.values ?? []) as number[];
  const userId = values[joined + 1] as number;
  const fixture = fixtures[userId];
  if (sql.includes('u."deletedAt" IS NOT NULL') && fixture.restored) return [];

  const row = parseSetClause(sql, values);
  // Only the WHERE clause selects rows; the SET clause names the same columns.
  const where = sql.slice(sql.indexOf('WHERE'));
  const targets = ids.filter((id) => {
    if (!fixture.images.includes(id)) return false;
    const blocked = ingestionOf(fixture, id) === 'Blocked';
    if (where.includes(TAKES_BLOCKED))
      return (
        blocked &&
        (!takesAiNotVerified(where, values) || blockedForOf(fixture, id) === AI_NOT_VERIFIED)
      );
    if (where.includes(SKIPS_BLOCKED)) return !blocked;
    return true;
  });

  const touched: { id: number; postId: number | null }[] = [];
  for (const id of targets) {
    const before = ingestionOf(fixture, id);
    const recorded = { ...row };
    if (Array.isArray(row.metadata))
      recorded.metadata = resolveMetadata(
        row.metadata as { key: string; source: string }[],
        fixture,
        id
      );

    if (typeof row.ingestion === 'string') (fixture.ingestion ??= {})[id] = row.ingestion;
    if (typeof row.blockedFor === 'string') (fixture.blockedFor ??= {})[id] = row.blockedFor;
    fireBlockedDeleteTrigger(fixture, id, before, recorded);

    blockedUpdates.push({ id, ...recorded });
    touched.push({ id, postId: fixture.postIdOf?.[id] ?? null });
  }
  return touched;
}

function seed(next: Record<number, Fixture>) {
  fixtures = next;
  const newestFirst = Object.keys(fixtures)
    .map(Number)
    .sort((a, b) => fixtures[b].deletedAt.getTime() - fixtures[a].deletedAt.getTime());

  mockDbRead.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    const ascending = sql.includes('ORDER BY u."deletedAt" ASC');
    const [bound, mark] = values.filter((v): v is Date => v instanceof Date);
    const limit = values[values.length - 1] as number;
    // The comparison is read out of the SQL, not assumed, so a strict bound in the job shows
    // up here as a skipped timestamp tie instead of being papered over by the fixture.
    const tieSafe = sql.includes(ascending ? 'u."deletedAt" >=' : 'u."deletedAt" <=');
    const inRange = (d: Date) => {
      const withinBound = ascending
        ? tieSafe
          ? d >= bound
          : d > bound
        : tieSafe
        ? d <= bound
        : d < bound;
      // The backlog page carries the high-water mark as a second, always-strict bound.
      return withinBound && (mark === undefined || d < mark);
    };
    const selectsImageOwners = /FROM "Image" i\s+WHERE i\."userId" = u\.id/.test(sql);
    const selectsPostOwners = sql.includes('FROM "Post" p WHERE p."userId" = u.id');
    // Like the bound comparisons, the mode predicates are read out of the SQL: dropping one in
    // the job makes the fixture hand back a row the job then mishandles, rather than hiding it.
    const skipsBlockedForGraceOnly = sql.includes(`m.mode = 'immediate'`);
    const skipsGracePosts = /m\.mode = 'immediate'\s+AND EXISTS \(SELECT 1 FROM "Post"/.test(sql);
    const selectsMode = /SELECT u\.id, u\."deletedAt", m\.mode/.test(sql);
    const modeOf = modeExpression(sql);
    const order = ascending ? [...newestFirst].reverse() : newestFirst;

    return Promise.resolve(
      order
        .filter((id) => bound === undefined || inRange(fixtures[id].deletedAt))
        .filter((id) => {
          const fixture = fixtures[id];
          const immediate = modeOf(fixture) === 'immediate';
          const images =
            skipsBlockedForGraceOnly && immediate
              ? fixture.images
              : pendingImages(sql, values, fixture);
          const posts = skipsGracePosts && !immediate ? [] : fixture.posts ?? [];
          return (
            (selectsImageOwners && images.length > 0) || (selectsPostOwners && posts.length > 0)
          );
        })
        .slice(0, limit)
        .map((id) => ({
          id,
          deletedAt: fixtures[id].deletedAt,
          ...(selectsMode ? { mode: modeOf(fixtures[id]) } : {}),
        }))
    );
  });

  mockDbWrite.$queryRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');

      if (sql.includes('UPDATE "Image"')) return Promise.resolve(applyImageUpdate(sql, values));

      const userId = values[0] as number;
      const fixture = fixtures[userId];
      const gated = sql.includes('u."deletedAt" IS NOT NULL');

      if (sql.includes('"hasImages"')) {
        const state = { stillDeleted: !fixture.restored, hasImages: fixture.images.length > 0 };
        if (fixture.restoredAfterCheck) fixture.restored = true;
        return Promise.resolve([state]);
      }
      if (sql.includes('"hasPending"'))
        return Promise.resolve([{ hasPending: pendingImages(sql, values, fixture).length > 0 }]);
      if (sql.includes('"stillDeleted"')) {
        const checks = (batchChecks[userId] = (batchChecks[userId] ?? 0) + 1);
        if (fixture.restoreAfterBatches != null && checks > fixture.restoreAfterBatches)
          fixture.restored = true;
        if (fixture.graceAfterBatches != null && checks > fixture.graceAfterBatches)
          fixture.primaryMeta = { imageRemoval: 'grace' };
        const state = {
          stillDeleted: !fixture.restored && passesPrimaryChoice(sql, fixture),
        };
        if (fixture.restoredAfterCheck) fixture.restored = true;
        return Promise.resolve([state]);
      }
      if (sql.includes('FROM "Image" i')) {
        const limit = values[values.length - 1] as number;
        imageLimits.push(limit);
        if (gated && (fixture.restored || !passesPrimaryChoice(sql, fixture)))
          return Promise.resolve([]);
        const images = pendingImages(sql, values, fixture);
        const page = images.slice(0, limit).map((id) => ({
          id,
          wasBlocked: ingestionOf(fixture, id) === 'Blocked',
        }));
        pagedImageIds.push(...page.map((row) => row.id));
        for (const id of fixture.blockAfterRead ?? []) (fixture.ingestion ??= {})[id] = 'Blocked';
        return Promise.resolve(page);
      }
      if (sql.includes('FROM "Post"'))
        return Promise.resolve((fixture.posts ?? []).map((id) => ({ id })));

      throw new Error(`unexpected dbWrite read: ${sql}`);
    }
  );

  mockDbWrite.$executeRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');

      if (sql.includes('INSERT INTO "JobQueue"')) {
        const userId = values[0] as number;
        const fixture = fixtures[userId];
        if (sql.includes('u."deletedAt" IS NOT NULL') && fixture.restored)
          return Promise.resolve(0);
        const excluded = sql.includes('IS DISTINCT FROM') ? (values[1] as string) : null;
        const eligible = fixture.images.filter(
          (id) => ingestionOf(fixture, id) === 'Blocked' && blockedForOf(fixture, id) !== excluded
        );
        return Promise.resolve(eligible.filter((id) => enqueueBlockedDelete(fixture, id)).length);
      }

      // The id list is the only `Prisma.join` in the statement, and the owner check follows it.
      const joined = values.findIndex((v) => Array.isArray((v as { values?: number[] })?.values));
      const ids = ((values[joined] as { values?: number[] })?.values ?? []) as number[];
      const userId = values[joined + 1] as number;
      const fixture = fixtures[userId];
      if (sql.includes('u."deletedAt" IS NOT NULL') && fixture.restored) return Promise.resolve(0);
      if (!passesPrimaryChoice(sql, fixture)) return Promise.resolve(0);

      deletedPostIds.push(...ids);
      fixture.posts = (fixture.posts ?? []).filter((id) => !ids.includes(id));
      return Promise.resolve(ids.length);
    }
  );

  mockDeleteImages.mockImplementation(async (ids: number[]) => {
    for (const fixture of Object.values(fixtures))
      fixture.images = fixture.images.filter((id) => !ids.includes(id));
    return ids.map((id) => ({ id }));
  });
}

const ids = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => offset + i + 1);

function seedUser({
  id,
  imageRemoval,
  images,
  posts = 0,
  alreadyBlocked = 0,
  blockedAfterRead = 0,
  postId,
  deletedAt = NEWER,
  ...restoreHooks
}: {
  id: number;
  imageRemoval?: string;
  images: number;
  posts?: number;
  alreadyBlocked?: number;
  blockedAfterRead?: number;
  postId?: number;
  deletedAt?: Date;
} & Pick<Fixture, 'restored' | 'restoredAfterCheck' | 'restoreAfterBatches'>) {
  seed({
    [id]: {
      deletedAt,
      meta: imageRemoval ? { imageRemoval } : undefined,
      images: ids(images),
      ingestion: Object.fromEntries(ids(alreadyBlocked).map((imageId) => [imageId, 'Blocked'])),
      blockedFor: Object.fromEntries(ids(alreadyBlocked).map((imageId) => [imageId, 'moderated'])),
      postIdOf: postId
        ? Object.fromEntries(ids(images).map((imageId) => [imageId, postId]))
        : undefined,
      blockAfterRead: ids(blockedAfterRead, alreadyBlocked),
      posts: ids(posts, 900),
      ...restoreHooks,
    },
  });
}

const blockedRows = () => blockedUpdates;
const blockedImageIds = () => blockedUpdates.map((row) => row.id);
const remainingPosts = (userId: number) => fixtures[userId].posts ?? [];
const queuedForDelete = (userId: number) => [...(fixtures[userId].jobQueue ?? [])].sort();

const run = (checkIfCanceled: () => void = () => undefined) =>
  (removeDeletedUserImages as unknown as (ctx: { checkIfCanceled: () => void }) => Promise<any>)({
    checkIfCanceled,
  });

const NOW = new Date('2026-07-31T00:00:00Z');
const RECENT = new Date('2026-07-30T23:00:00Z');
const NEWER = new Date('2026-07-30T10:00:00Z');
const OLDER = new Date('2026-07-29T10:00:00Z');
const ANCIENT = new Date('2024-01-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  // The high-water mark seeds itself off the wall clock, so the fixtures' `deletedAt` values
  // only mean "backlog" or "fresh" relative to a pinned now.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fixtures = {};
  cursorStore = {};
  cursorSets = {};
  imageLimits = [];
  pagedImageIds = [];
  deletedPostIds = [];
  blockedUpdates = [];
  batchChecks = {};
  mockSysRedis.get.mockResolvedValue(null);
  mockGetJobDate.mockImplementation(async (key: string, defaultValue: Date) => [
    cursorStore[key] ?? defaultValue,
    async (date?: Date) => {
      cursorStore[key] = date ?? new Date();
      (cursorSets[key] ??= []).push(cursorStore[key]);
    },
  ]);
  seed({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('removeDeletedUserImages', () => {
  it('deletes a deleted user images in batches of 100 and then removes their posts', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900] } });

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(mockDeleteImages.mock.calls[0][0]).toHaveLength(100);
    expect(mockDeleteImages.mock.calls[1][0]).toHaveLength(50);
    expect(deletedPostIds).toEqual([900]);
    expect(result.deletedImages).toBe(150);
    expect(result.deletedUsers).toBe(1);
  });

  it('leaves posts alone while the user still has images left', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900] } });

    const result = await run();

    expect(result.deletedImages).toBe(100);
    expect(deletedPostIds).toEqual([]);
  });

  it('deletes posts when the drain lands exactly on the budget', async () => {
    mockSysRedis.get.mockResolvedValue('150');
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900] } });

    // The old count-vs-budget heuristic read "returned exactly the budget" as "more may
    // remain" and stranded these posts forever; the post-drain re-check settles it.
    const result = await run();

    expect(result.deletedImages).toBe(150);
    expect(deletedPostIds).toEqual([900]);
    expect(result.deletedUsers).toBe(1);
  });

  it('deletes posts for a user who owns posts but no images', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: [900, 901] } });

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(deletedPostIds).toEqual([900, 901]);
    expect(result.deletedUsers).toBe(1);
  });

  it('chunks the post delete', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: ids(250, 1000) } });

    await run();

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(3);
    expect(deletedPostIds).toHaveLength(250);
  });

  it('does nothing when no deleted user owns images or posts', async () => {
    seed({});

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(result.deletedImages).toBe(0);
  });

  it('skips a user restored between the worklist read and the drain', async () => {
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900], restored: true } });

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(deletedPostIds).toEqual([]);
    expect(result.deletedImages).toBe(0);
    expect(result.deletedUsers).toBe(0);
  });

  it('leaves the posts of a restored user alone', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: [900], restored: true } });

    const result = await run();

    expect(deletedPostIds).toEqual([]);
    expect(result.deletedUsers).toBe(0);
  });

  it('stops draining a user restored between image batches', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({ 7: { deletedAt: NEWER, images: ids(300), posts: [900], restoreAfterBatches: 1 } });

    const result = await run();

    // Without a per-batch re-read the restore only costs the ids already fetched — which is
    // every image the budget would have paid for.
    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(100);
    expect(deletedPostIds).toEqual([]);
    expect(result.deletedUsers).toBe(0);
  });

  it('gates the post delete itself, not just the decision to run it', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: [900], restoredAfterCheck: true } });

    const result = await run();

    expect(deletedPostIds).toEqual([]);
    // The gated DELETE affects nothing, so the run neither counts the user nor moves past them.
    expect(result.deletedUsers).toBe(0);
    expect(cursorSets[BACKLOG_KEY]).toBeUndefined();
  });

  it('keeps going when one user fails, and logs the failure with a stack', async () => {
    seed({
      7: { deletedAt: NEWER, images: [1] },
      8: { deletedAt: OLDER, images: [2] },
    });
    const boom = new Error('s3 exploded');
    mockDeleteImages.mockRejectedValueOnce(boom).mockImplementationOnce(async (batch: number[]) => {
      fixtures[8].images = [];
      return batch.map((id) => ({ id }));
    });

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(result.deletedImages).toBe(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'remove-deleted-user-images',
        userId: 7,
        error: expect.objectContaining({ stack: boom.stack }),
      })
    );
    // User 7 may be half-drained, so the cursor must not step over them to reach user 8.
    expect(cursorSets[BACKLOG_KEY]).toBeUndefined();
  });

  it('logs a success line with the run counts', async () => {
    seed({ 7: { deletedAt: NEWER, images: ids(10), posts: [900] } });

    await run();

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        name: 'remove-deleted-user-images',
        deletedImages: 10,
        deletedUsers: 1,
      })
    );
  });

  it('checks for cancellation between image batches without logging it as a failure', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({ 7: { deletedAt: NEWER, images: ids(300) } });
    let checks = 0;
    const checkIfCanceled = () => {
      // 1 = the per-user check, 2 = the first in-batch check. Without an in-batch check the
      // job never reaches a third call for a single user and all three batches run.
      if (++checks === 3) throw new Error('Job has ended');
    };

    await run(checkIfCanceled);

    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('removeDeletedUserImages cursors', () => {
  it('advances the backlog cursor to the last user it fully drained', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({
      7: { deletedAt: NEWER, images: ids(10), posts: [900] },
      8: { deletedAt: OLDER, images: ids(10, 100), posts: [901] },
    });

    await run();

    expect(cursorSets[BACKLOG_KEY]).toEqual([OLDER]);
  });

  it('does not advance past a user the budget left half-drained', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seed({
      7: { deletedAt: NEWER, images: ids(150) },
      8: { deletedAt: OLDER, images: ids(10, 200) },
    });

    const first = await run();

    expect(first.deletedImages).toBe(100);
    expect(cursorSets[BACKLOG_KEY]).toBeUndefined();

    // User 7 is still the newest candidate, so the next run resumes on their remainder.
    const second = await run();

    expect(second.deletedImages).toBe(50 + 10);
    expect(fixtures[7].images).toEqual([]);
  });

  it('resets the backlog cursor when its page comes back empty', async () => {
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    const result = await run();

    expect(result.deletedImages).toBe(0);
    expect(cursorSets[BACKLOG_KEY]).toEqual([CURSOR_START]);
  });

  it('picks up a user the backlog cursor had passed once the reset wraps', async () => {
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    await run();
    const second = await run();

    expect(second.deletedImages).toBe(10);
  });

  it('drains a fresh self-deletion on the next run with an undrained backlog below the cursor', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    cursorStore[FRESH_KEY] = NEWER;
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({
      1: { deletedAt: ANCIENT, images: ids(10), posts: [900] },
      9: { deletedAt: RECENT, images: ids(10, 100), posts: [901] },
    });

    await run();

    // A single descending cursor sorts every deletion newer than itself out of range, so the
    // fresh account waits for the whole backlog below the cursor to drain first.
    expect(fixtures[9].images).toEqual([]);
    expect(deletedPostIds).toContain(901);
  });

  it('spends a scarce budget on the fresh deletion before the backlog', async () => {
    mockSysRedis.get.mockResolvedValue('10');
    cursorStore[FRESH_KEY] = NEWER;
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({
      1: { deletedAt: ANCIENT, images: ids(10) },
      9: { deletedAt: RECENT, images: ids(10, 100) },
    });

    const result = await run();

    expect(result.deletedImages).toBe(10);
    expect(fixtures[9].images).toEqual([]);
    expect(fixtures[1].images).toHaveLength(10);
  });

  it('persists the seeded high-water mark on the first run', async () => {
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    await run();

    // Re-seeding the mark to a later `now` every run would leave anything deleted in between
    // above the mark and below the backlog cursor — visible to neither pass.
    const selfDeleted = new Date(NOW.getTime() + 30 * 60 * 1000);
    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60 * 1000));
    seed({
      7: { deletedAt: NEWER, images: [] },
      9: { deletedAt: selfDeleted, images: ids(5, 500) },
    });

    const second = await run();

    expect(second.deletedImages).toBe(5);
  });

  it('does not skip accounts that share the cursor timestamp', async () => {
    mockSysRedis.get.mockResolvedValue('10');
    seed({
      7: { deletedAt: NEWER, images: ids(10) },
      8: { deletedAt: NEWER, images: ids(10, 100) },
    });

    const first = await run();

    expect(first.deletedImages).toBe(10);
    expect(cursorSets[BACKLOG_KEY]).toEqual([NEWER]);

    // A bulk delete stamps one `now()` across many accounts; a strict comparison drops the
    // rest of the tie the moment the cursor lands on it.
    const second = await run();

    expect(second.deletedImages).toBe(10);
    expect(fixtures[8].images).toEqual([]);
  });
});

describe('removeDeletedUserImages budget', () => {
  it('does nothing when the Redis limit is 0', async () => {
    mockSysRedis.get.mockResolvedValue('0');

    const result = await run();

    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(result.paused).toBe(true);
  });

  it('coerces a Buffer reply from the HA sysRedis', async () => {
    mockSysRedis.get.mockResolvedValue(Buffer.from('150'));
    seed({ 7: { deletedAt: NEWER, images: ids(200) } });

    const result = await run();

    // Budget of 150 (not the 200 available, not the compiled default) honoured:
    // a full batch of 100, then a truncated batch of 50.
    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(mockDeleteImages.mock.calls[1][0]).toHaveLength(50);
    expect(result.deletedImages).toBe(150);
  });

  it('floors a fractional Redis value so the LIMIT stays an integer', async () => {
    mockSysRedis.get.mockResolvedValue('1.5');
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    const result = await run();

    // `LIMIT 1.5` is a Postgres type error that takes down every user in the run.
    expect(imageLimits).toEqual([1]);
    expect(result.deletedImages).toBe(1);
  });

  it('stops at the budget and leaves later users for the next run', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seed({
      7: { deletedAt: NEWER, images: ids(100) },
      8: { deletedAt: OLDER, images: ids(10, 200) },
    });

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(100);
    expect(fixtures[8].images).toHaveLength(10);
  });

  it('falls back to a conservative default when the key is unset', async () => {
    mockSysRedis.get.mockResolvedValue(null);
    seed({ 7: { deletedAt: NEWER, images: ids(600), posts: [900] } });

    const result = await run();

    expect(DEFAULT_IMAGES_PER_RUN).toBe(500);
    expect(result.deletedImages).toBe(500);
    expect(deletedPostIds).toEqual([]);
  });

  it('falls back to the default when the Redis value is not a number', async () => {
    mockSysRedis.get.mockResolvedValue('not-a-number');
    seed({ 7: { deletedAt: NEWER, images: ids(150) } });

    const result = await run();

    // A broken fallback that lets a non-finite budget through would cap `remaining`
    // at NaN and process nothing.
    expect(result.deletedImages).toBe(150);
    expect(result.paused).toBeUndefined();
  });

  it('falls back to the default when the Redis value is negative', async () => {
    mockSysRedis.get.mockResolvedValue('-5');
    seed({ 7: { deletedAt: NEWER, images: ids(150) } });

    const result = await run();

    // A broken fallback that lets -5 through would make the job's own `budget <= 0`
    // gate pause it instead of running with the default.
    expect(result.deletedImages).toBe(150);
    expect(result.paused).toBeUndefined();
  });
});

describe('grace mode', () => {
  it('blocks a grace user images instead of deleting them', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 150 });

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(blockedImageIds()).toHaveLength(150);
    expect(blockedRows()[0]).toMatchObject({
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: 'moderated',
    });
    expect(result.blockedImages).toBe(150);
  });

  it('stamps updatedAt so the 7-day retention clock starts now', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10 });

    await run();

    // `@updatedAt` is a Prisma-client concern that raw SQL skips, and remove-blocked-images
    // counts the `moderated` retention window from `updatedAt` — an unstamped row is already
    // past the cutoff and gets hard-deleted on the next hourly run.
    expect(blockedRows()[0]).toMatchObject({ updatedAt: NOW });
  });

  it('clears needsReview the way the moderator block path does', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 1 });

    await run();

    // Left set, these pile up in moderator review queues for an account that no longer exists,
    // and a later unblock branches on it for poi/minor handling.
    expect(blockedRows()[0]).toHaveProperty('needsReview', null);
  });

  it('leaves a grace user posts alone', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, posts: 5 });

    await run();

    // Posts follow the images out via CleanIfEmpty once remove-blocked-images
    // purges them at day 7; deleting them now would strand the grace window.
    expect(remainingPosts(7)).toHaveLength(5);
  });

  it('does not reselect a grace user whose images are all blocked', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, posts: 5 });

    await run();
    mockDeleteImages.mockClear();
    mockLogToAxiom.mockClear();
    const second = await run();

    expect(second.blockedImages).toBe(0);
    expect(second.deletedImages).toBe(0);
    // Posts they keep for the grace window must not pull them back into the worklist, where
    // every wrap would re-count them as drained for no work.
    expect(mockLogToAxiom).toHaveBeenCalledWith(expect.objectContaining({ candidates: 0 }));
  });

  it('skips images that are already blocked so their 7-day clock is not restarted', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, alreadyBlocked: 4 });

    const result = await run();

    expect(result.blockedImages).toBe(6);
  });

  it('spends the budget only on images that still need blocking', async () => {
    mockSysRedis.get.mockResolvedValue('6');
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, alreadyBlocked: 4 });

    const result = await run();

    // Reading already-blocked rows back would spend the whole budget on no-op updates and
    // never reach the images that still need one.
    expect(result.blockedImages).toBe(6);
  });

  it('skips an image blocked between the read and the write', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, blockedAfterRead: 2 });

    const result = await run();

    // The id list is as stale as the read that produced it, so only carrying the predicate into
    // the UPDATE keeps a concurrently-blocked image off a fresh 7-day clock.
    expect(result.blockedImages).toBe(8);
    expect(blockedImageIds()).not.toContain(1);
  });

  it('gates the block itself, not just the decision to run it', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, restoredAfterCheck: true });

    const result = await run();

    expect(result.blockedImages).toBe(0);
    expect(blockedImageIds()).toEqual([]);
  });

  it('stops blocking a grace user restored between batches', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seedUser({ id: 7, imageRemoval: 'grace', images: 300, restoreAfterBatches: 1 });

    const result = await run();

    // The gate on the UPDATE keeps the writes correct on its own; re-reading between batches is
    // what stops the run charging its whole budget to statements that now affect nothing.
    expect(result.blockedImages).toBe(100);
  });

  it('hard-deletes a user with no recorded choice', async () => {
    seedUser({ id: 7, images: 10 });

    const result = await run();

    expect(result.deletedImages).toBe(10);
    expect(result.blockedImages).toBe(0);
  });

  it('still drains an immediate user whose images are all blocked', async () => {
    seedUser({ id: 7, images: 10, alreadyBlocked: 10 });

    const result = await run();

    // Scoping the unblocked-image predicate to grace users is what keeps these reachable: their
    // rows can predate the JobQueue trigger, so remove-blocked-images would never see them.
    expect(result.deletedImages).toBe(10);
  });

  it('blocks a user whose recorded choice is not one the job knows', async () => {
    seedUser({ id: 7, imageRemoval: 'sometime-later', images: 10 });

    const result = await run();

    // Absent stays immediate for the backlog's sake, but a value we cannot read should cost
    // seven days of storage rather than the images.
    expect(result.blockedImages).toBe(10);
    expect(mockDeleteImages).not.toHaveBeenCalled();
  });

  it('charges blocked images against the budget', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seedUser({ id: 7, imageRemoval: 'grace', images: 250 });

    const result = await run();

    expect(result.blockedImages).toBe(100);
  });
});

describe('grace mode search index and caches', () => {
  it('removes the blocked images from the search index', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10 });

    await run();

    // The incremental pull filters on `ingestion = 'Scanned'`, so a bare UPDATE leaves the row
    // indexed and findable in site search until the next full reindex.
    expect(mockQueueSearchIndex).toHaveBeenCalledWith({
      ids: ids(10),
      action: SearchIndexUpdateQueueAction.Delete,
    });
    expect(mockInvalidateExistence).toHaveBeenCalledWith(ids(10));
  });

  it('busts the caches of the posts that held them', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, postId: 900 });

    await run();

    expect(mockBustCachesForPosts).toHaveBeenCalledWith([900]);
  });

  it('propagates only the rows the update actually changed', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, blockedAfterRead: 2 });

    await run();

    // Propagating the fetched ids rather than the updated ones would evict two images a
    // concurrent writer owns from the index on this account's behalf.
    expect(mockQueueSearchIndex).toHaveBeenCalledWith({
      ids: [3, 4, 5, 6, 7, 8, 9, 10],
      action: SearchIndexUpdateQueueAction.Delete,
    });
  });

  it('does not call the post cache bust with an empty list', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10 });

    await run();

    expect(mockBustCachesForPosts).not.toHaveBeenCalled();
  });
});

describe('grace mode delete queue', () => {
  it('queues the images it blocks through the delete-queue trigger', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 3 });

    await run();

    expect(queuedForDelete(7)).toEqual([1, 2, 3]);
  });

  it('queues a blocked image the trigger never enqueued', async () => {
    seed({
      7: {
        deletedAt: NEWER,
        meta: { imageRemoval: 'grace' },
        images: [1, 2],
        ingestion: { 1: 'Blocked' },
        blockedFor: { 1: 'moderated' },
      },
    });

    await run();

    // Blocked inside the week the trigger migration's backfill excluded, so it holds no queue
    // row — and remove-blocked-images reads nothing else. Left alone it is retained forever
    // while the immediate branch, which has no ingestion predicate, deletes it.
    expect(queuedForDelete(7)).toEqual([1, 2]);
  });

  it('re-points an AiNotVerified block so the purge job will accept it', async () => {
    seed({
      7: {
        deletedAt: NEWER,
        meta: { imageRemoval: 'grace' },
        images: [1],
        ingestion: { 1: 'Blocked' },
        blockedFor: { 1: AI_NOT_VERIFIED },
      },
    });

    const result = await run();

    // remove-blocked-images refuses `AiNotVerified` outright and evicts its queue rows as stale.
    expect(result.blockedImages).toBe(1);
    expect(blockedRows()[0]).toMatchObject({ blockedFor: 'moderated', updatedAt: NOW });
    expect(queuedForDelete(7)).toEqual([1]);
  });

  it('does not arm the queue for a user restored mid-run', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, restoredAfterCheck: true });

    await run();

    expect(queuedForDelete(7)).toEqual([]);
  });
});

describe('grace mode restore breadcrumbs', () => {
  it('records the ingestion it overwrote', async () => {
    seed({
      7: {
        deletedAt: NEWER,
        meta: { imageRemoval: 'grace' },
        images: [1],
        ingestion: { 1: 'Pending' },
      },
    });

    await run();

    // Restoring these to a flat `Scanned` would promote an image past the scan it never had.
    expect(blockedRows()[0].metadata).toEqual({ [PRIOR_INGESTION_KEY]: 'Pending' });
  });

  it('records the block reason it overwrote when re-pointing', async () => {
    seed({
      7: {
        deletedAt: NEWER,
        meta: { imageRemoval: 'grace' },
        images: [1],
        ingestion: { 1: 'Blocked' },
        blockedFor: { 1: AI_NOT_VERIFIED },
      },
    });

    await run();

    expect(blockedRows()[0].metadata).toEqual({
      [PRIOR_INGESTION_KEY]: 'Blocked',
      [PRIOR_BLOCKED_FOR_KEY]: AI_NOT_VERIFIED,
    });
  });
});

describe('removal choice re-read on the destructive path', () => {
  it('keeps the images of a user whose choice has not replicated yet', async () => {
    seed({
      7: {
        deletedAt: NEWER,
        images: ids(10),
        posts: [900],
        primaryMeta: { imageRemoval: 'grace' },
      },
    });

    const result = await run();

    // The worklist reads the choice off a replica; a restore plus a re-delete with a different
    // choice inside the replication window resolves to the stale one, and the stale direction
    // that hurts is `immediate`.
    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(result.deletedImages).toBe(0);
    // Carried on the JOIN rather than only on the per-batch re-read: an id list the run is not
    // allowed to act on should never be built in the first place.
    expect(pagedImageIds).toEqual([]);
  });

  it('gates the post delete on the choice as well as on deletedAt', async () => {
    seed({
      7: { deletedAt: NEWER, images: [], posts: [900], primaryMeta: { imageRemoval: 'grace' } },
    });

    const result = await run();

    expect(deletedPostIds).toEqual([]);
    expect(result.deletedUsers).toBe(0);
  });

  it('stops deleting when the choice flips to grace between image batches', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({ 7: { deletedAt: NEWER, images: ids(300), graceAfterBatches: 1 } });

    const result = await run();

    // The fetched id list is as stale as the read that produced it; without the re-read the
    // flip still costs the account every id already fetched.
    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(100);
  });
});
