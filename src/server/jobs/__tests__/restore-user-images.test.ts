import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbWrite,
  mockUnblock,
  mockLogToAxiom,
  mockSafeError,
  mockSysRedis,
  mockResetNsfwLevel,
  mockQueueSearchIndex,
  mockBustCachesForPosts,
} = vi.hoisted(() => ({
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
  mockUnblock: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
  mockSafeError: vi.fn((e: unknown) => ({ message: (e as Error).message })),
  mockSysRedis: { sAdd: vi.fn(), sMembers: vi.fn(), sRem: vi.fn() },
  mockResetNsfwLevel: vi.fn(async () => undefined),
  mockQueueSearchIndex: vi.fn(async () => undefined),
  mockBustCachesForPosts: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbWrite, dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  safeError: mockSafeError,
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { SYSTEM: { PENDING_IMAGE_RESTORES: 'pending-restores' } },
}));
vi.mock('~/server/services/image.service', () => ({
  resetBlockedNsfwLevel: mockResetNsfwLevel,
  queueImageSearchIndexUpdate: mockQueueSearchIndex,
}));
vi.mock('~/server/services/post.service', () => ({ bustCachesForPosts: mockBustCachesForPosts }));
// Partial: the reversal itself has its own suite, but the worklist reads/writes stay REAL so the
// set semantics — and the Buffer the HA client hands back — are exercised here rather than mocked.
vi.mock('~/server/services/account-deletion-images', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, unblockAccountDeletionImages: mockUnblock };
});
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { restoreUserImages, RESTORE_USERS_PER_RUN } from '~/server/jobs/restore-user-images';

/**
 * The suite stands in a tiny in-memory Postgres and Redis for the job. The owner gate is
 * interpreted rather than canned: the predicates are read back out of the statement and evaluated
 * against the `User` fixture, so dropping the `deletedAt` check makes the fixture hand back a
 * still-deleted account and the test that guards it fails. The pending set is a real set behind
 * the real `readPendingImageRestores`/`clearPendingImageRestore`, so an id is only gone from it
 * because the job removed it.
 */
type UserRow = { id: number; deletedAt: Date | null };

let users: UserRow[] = [];
let pendingSet: (string | Buffer)[] = [];

const EXISTS_SELECT = /SELECT EXISTS\s*\(([\s\S]*?)\)\s*AS\s+"?(\w+)"?/;

function evaluateOwnerGate(sql: string, values: unknown[]) {
  const match = EXISTS_SELECT.exec(sql);
  if (!match) throw new Error(`unexpected read: ${sql}`);

  const [, body, alias] = match;
  if (!/FROM "User" u/.test(body)) throw new Error(`the gate must read "User": ${body}`);

  const params = [...values];
  // Every predicate is applied, and one this does not recognise is rejected rather than assumed,
  // so a gate that widens its scope cannot pass by relying on the harness to narrow it back.
  const predicates = body
    .slice(body.indexOf('WHERE') + 5)
    .split(/\s+AND\s+/)
    .map((clause) => {
      const args = params.splice(0, (clause.match(/\?/g) ?? []).length);
      if (/^\s*u\.id = \?/.test(clause)) return (row: UserRow) => row.id === args[0];
      if (/^\s*u\."deletedAt" IS NOT NULL/.test(clause))
        return (row: UserRow) => row.deletedAt != null;
      if (/^\s*u\."deletedAt" IS NULL/.test(clause)) return (row: UserRow) => row.deletedAt == null;
      throw new Error(`unrecognized owner-gate predicate: ${clause.trim()}`);
    });

  return [{ [alias]: users.some((row) => predicates.every((holds) => holds(row))) }];
}

const decoded = (member: string | Buffer) =>
  Buffer.isBuffer(member) ? member.toString('utf8') : member;

beforeEach(() => {
  vi.clearAllMocks();
  users = [];
  pendingSet = [];

  mockDbWrite.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(evaluateOwnerGate(strings.join('?'), values))
  );
  mockSysRedis.sMembers.mockImplementation(async () => [...pendingSet]);
  mockSysRedis.sRem.mockImplementation(async (_key: string, member: string) => {
    const before = pendingSet.length;
    pendingSet = pendingSet.filter((entry) => decoded(entry) !== member);
    return before - pendingSet.length;
  });
  mockUnblock.mockResolvedValue({ unblocked: 3, stillBlocked: 0, skipped: 0, drained: true });
});

type RunResult = { pending: number; finished: number; unblocked: number; stillDeleted: number };

const run = () => (restoreUserImages as unknown as () => Promise<RunResult>)();

const restored = (id: number): UserRow => ({ id, deletedAt: null });

describe('restoreUserImages', () => {
  it('reads nothing but the worklist when no account is pending', async () => {
    const result = await run();

    // Restores are rare, so this is the shape of almost every run: `Image` has no index on the
    // breadcrumb across ~120M rows and a filtered `User` scan measures ~1.7s.
    expect(mockSysRedis.sMembers).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockUnblock).not.toHaveBeenCalled();
    expect(mockSysRedis.sRem).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pending: 0, finished: 0, unblocked: 0 });
  });

  it('unblocks the images of an account that came back', async () => {
    users = [restored(7)];
    pendingSet = ['7'];

    const result = await run();

    expect(mockUnblock).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({ finished: 1, unblocked: 3 });
  });

  it('leaves an account that is deleted again alone', async () => {
    users = [{ id: 7, deletedAt: new Date('2026-07-29T00:00:00Z') }];
    pendingSet = ['7'];

    const result = await run();

    // Reversing here would undo the grace block `remove-deleted-user-images` is once again
    // correct to have written.
    expect(mockUnblock).not.toHaveBeenCalled();
    expect(pendingSet).toEqual(['7']);
    expect(result).toMatchObject({ stillDeleted: 1, finished: 0 });
  });

  it('drops the account off the worklist once its reversal drains', async () => {
    users = [restored(7)];
    pendingSet = ['7'];

    await run();

    expect(mockSysRedis.sRem).toHaveBeenCalledWith('pending-restores', '7');
    expect(pendingSet).toEqual([]);
  });

  it('keeps the account queued while its reversal still has rows to claim', async () => {
    users = [restored(7)];
    pendingSet = ['7'];
    mockUnblock.mockResolvedValueOnce({
      unblocked: 500,
      stillBlocked: 0,
      skipped: 0,
      drained: false,
    });

    const first = await run();

    // Dropped here, a reversal stopped at its batch ceiling leaves the rest of the gallery hidden
    // with nothing left pointing at it.
    expect(first).toMatchObject({ finished: 0, unblocked: 500 });
    expect(pendingSet).toEqual(['7']);

    await run();

    expect(mockUnblock).toHaveBeenCalledTimes(2);
    expect(pendingSet).toEqual([]);
  });

  it('does no work on a second run over an account it already finished', async () => {
    users = [restored(7)];
    pendingSet = ['7'];

    await run();
    const second = await run();

    expect(mockUnblock).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ pending: 0, finished: 0, unblocked: 0 });
  });

  it('reads a worklist member back as the account it names, whichever way Redis spells it', async () => {
    users = [restored(7), restored(8)];
    // sysRedis hands BLOB_STRING replies back as Buffers on the Sentinel setup, so both spellings
    // reach the job and both have to resolve to the same account the reversal takes an id for.
    pendingSet = ['7', Buffer.from('8', 'utf8')];

    await run();

    expect(mockUnblock).toHaveBeenCalledWith(7);
    expect(mockUnblock).toHaveBeenCalledWith(8);
    expect(pendingSet).toEqual([]);
  });

  it('drops a member that is not a user id before it reaches Postgres', async () => {
    users = [restored(7)];
    pendingSet = ['not-an-id', '7'];

    await run();

    // Unfiltered, `NaN` is carried all the way into the gate's parameter list on every run.
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockUnblock).toHaveBeenCalledWith(7);
  });

  it('keeps working past an account whose reversal throws', async () => {
    users = [restored(7), restored(8)];
    pendingSet = ['7', '8'];
    mockUnblock.mockRejectedValueOnce(new Error('deadlock detected'));

    await run();

    expect(mockUnblock).toHaveBeenCalledWith(8);
    // The failure stays queued, and the account behind it is not stranded by it.
    expect(pendingSet).toEqual(['7']);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'restore-user-images', userId: 7 })
    );
  });

  it('caps how many accounts a single run takes on', async () => {
    const total = RESTORE_USERS_PER_RUN + 5;
    users = Array.from({ length: total }, (_, i) => restored(i + 1));
    pendingSet = users.map((user) => String(user.id));

    await run();

    expect(mockUnblock).toHaveBeenCalledTimes(RESTORE_USERS_PER_RUN);
    expect(pendingSet).toHaveLength(5);
  });
});
