import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Caches from '~/server/redis/caches';

const {
  env,
  queueImageSearchIndexUpdate,
  deleteImagesForModelVersionCache,
  queueUpdate,
  refreshPostCount,
  refreshImageVideoCount,
} = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
  deleteImagesForModelVersionCache: vi.fn(async () => undefined),
  queueUpdate: vi.fn(async () => undefined),
  refreshPostCount: vi.fn(async () => undefined),
  refreshImageVideoCount: vi.fn(async () => undefined),
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate,
  deleteImagesForModelVersionCache,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userPostCountCache: { refresh: refreshPostCount },
  userImageVideoCountCaches: { refresh: refreshImageVideoCount },
}));

const handler = (await import('~/pages/api/admin/temp/repair-post-unpublished-stamp')).default;

type Payload = {
  dryRun: boolean;
  candidates: number;
  stashed: number;
  cleared: number;
  stripped: number;
  strippedLeftForPostIds: number;
  committedPosts: number;
  buckets: Record<string, { posts: number; sample: number[] }>;
  planned: Record<string, number>;
  ops: Record<string, number>;
  sideEffects: Record<string, number>;
  sideEffectFailures: number;
  error: string;
};

function call(query: Record<string, string>, token = 'test-token') {
  const req = {
    method: 'POST',
    query: { token, pauseMs: '0', ...query },
    headers: {},
  } as never;
  let statusCode = 0;
  let payload: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => ({
    statusCode,
    payload: payload as Payload,
  }));
}

const candidate = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  publishedAt: new Date('2024-05-05T14:18:00.000Z'),
  unpublishedAt: new Date('2024-05-05T15:03:00.000Z'),
  updatedAt: new Date('2024-05-01T00:00:00.000Z'),
  userId: 10,
  stampedByOwner: true,
  modelVersionId: 100 + id,
  versionStatus: 'Unpublished',
  modelStatus: 'Unpublished',
  modelUserId: 10,
  ...overrides,
});
const live = { versionStatus: 'Published', modelStatus: 'Published' };
const candidates = [candidate(1), candidate(2, live), candidate(3, { versionStatus: 'Published' })];

const CLEAR = '"publishedAt" = NULL';
const STRIP = "- 'unpublishedAt' - 'unpublishedBy'";
const RESTORE_CLEARED = `"publishedAt" = (p.metadata->>'repairPrevPublishedAt')`;
const RESTORE_STRIPPED = `jsonb_build_object('unpublishedAt'`;
const LIVE_PARENT = `mv.status = 'Published'`;

// A statement reaches $queryRaw either as a tagged template or as a Prisma.Sql.
type Sent = { text: string; values: unknown[] };
const sent = (): Sent[] =>
  dbMock.dbWrite.$queryRaw.mock.calls.map((args: unknown[]) => {
    const [first, ...rest] = args as [{ strings?: string[]; values?: unknown[] } | string[]];
    if (Array.isArray(first)) return { text: first.join('?'), values: rest };
    return { text: (first.strings ?? []).join('?'), values: first.values ?? [] };
  });
const statements = (fragment: string) => sent().filter((s) => s.text.includes(fragment));
const idBatches = (fragment: string) => statements(fragment).map((s) => s.values[0]);

/** Answers the first read with `select` and each UPDATE with the ids it was given, as RETURNING does. */
function answerUpdates(select: unknown[], { missing = [] as number[], hidden = true } = {}) {
  let first = true;
  dbMock.dbWrite.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    if (first) {
      first = false;
      return select;
    }
    const ids = ((args[0] as { values: unknown[] }).values[0] as number[]) ?? [];
    return ids
      .filter((id) => !missing.includes(id))
      .map((id) => ({ id, modelVersionId: 100 + id, userId: 10, hidden }));
  });
}

describe('repair-post-unpublished-stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.$queryRaw.mockReset();
    dbMock.dbWrite.image.findMany.mockImplementation(async ({ where }: never) =>
      (where as { postId: { in: number[] } }).postId.in.map((postId) => ({
        id: 900 + postId,
        postId,
      }))
    );
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ modelId: 7 }]);
  });

  it('rejects a call with the wrong token and reads nothing', async () => {
    const { statusCode } = await call({}, 'wrong');

    expect(statusCode).toBe(401);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('defaults to a dry run that sends no UPDATE and runs no side effect', async () => {
    answerUpdates(candidates);

    const { statusCode, payload } = await call({});

    expect(statusCode).toBe(200);
    expect(payload.dryRun).toBe(true);
    expect(payload.candidates).toBe(3);
    expect(payload.buckets.parentDown).toEqual({ posts: 1, sample: [1] });
    expect(payload.buckets.liveParent).toEqual({ posts: 1, sample: [2] });
    expect(payload.buckets.halfLive).toEqual({ posts: 1, sample: [3] });
    expect(payload.planned).toEqual({ clear: 1, strip: 2, skip: 0 });
    expect(sent()).toHaveLength(1);
    expect(statements('UPDATE')).toHaveLength(0);
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(refreshPostCount).not.toHaveBeenCalled();
  });

  it.each(['rollback', 'resync', 'cleanup'])(
    'writes nothing on a dry run of %s',
    async (action) => {
      answerUpdates([{ id: 1, modelVersionId: 101, userId: 10, hidden: true, stripped: false }]);

      const { statusCode, payload } = await call({ action });

      expect(statusCode).toBe(200);
      expect(payload.stashed).toBe(1);
      expect(statements('UPDATE')).toHaveLength(0);
      expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    }
  );

  it('clears under a parent that is down and strips the rest by default', async () => {
    answerUpdates(candidates);

    const { payload } = await call({ dryRun: 'false' });

    expect(idBatches(CLEAR)).toEqual([[1]]);
    expect(idBatches(STRIP)).toEqual([[2], [3]]);
    expect(payload.ops).toEqual({ clearedPublishedAt: 1, strippedStamp: 2, changedSincePlan: 0 });
  });

  it('makes each write re-check the parent it was planned against', async () => {
    answerUpdates(candidates);

    await call({ dryRun: 'false' });

    const [clear] = statements(CLEAR);
    const [strip] = statements(STRIP);
    expect(clear.text).toMatch(/AND NOT\s+EXISTS/);
    expect(clear.text).toContain(LIVE_PARENT);
    expect(strip.text).toMatch(/AND\s+EXISTS/);
    expect(strip.text).not.toMatch(/AND NOT\s+EXISTS/);
  });

  it('strips a post whose parent is not live without asking for a live parent', async () => {
    answerUpdates([candidate(3, { versionStatus: 'Published' })]);

    await call({ dryRun: 'false' });

    const [strip] = statements(STRIP);
    expect(strip.values[0]).toEqual([3]);
    expect(strip.text).not.toContain(LIVE_PARENT);
  });

  it('refuses liveParent=clear', async () => {
    const { statusCode } = await call({ dryRun: 'false', liveParent: 'clear' });

    expect(statusCode).toBe(400);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('stashes the stamp a clear saw, and rollback restores only under that stamp', async () => {
    answerUpdates([candidate(1)]);
    await call({ dryRun: 'false' });
    expect(statements(CLEAR)[0].text).toContain(`'repairStampAt', p.metadata->'unpublishedAt'`);

    dbMock.dbWrite.$queryRaw.mockReset();
    answerUpdates([{ id: 1, modelVersionId: 101, userId: 10, hidden: true, stripped: false }]);
    await call({ dryRun: 'false', action: 'rollback' });

    expect(statements(RESTORE_CLEARED)[0].text).toContain(
      `p.metadata->'unpublishedAt' = p.metadata->'repairStampAt'`
    );
  });

  it('writes batchSize posts per statement and reindexes each batch before the next', async () => {
    const order: string[] = [];
    answerUpdates([candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)]);
    const answer = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      order.push('write');
      return answer(...args);
    });
    queueImageSearchIndexUpdate.mockImplementation(async () => {
      order.push('reindex');
    });

    const { payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(idBatches(CLEAR)).toEqual([[1, 2], [3, 4], [5]]);
    expect(order).toEqual(['write', 'write', 'reindex', 'write', 'reindex', 'write', 'reindex']);
    expect(payload.ops.clearedPublishedAt).toBe(5);
  });

  it('removes the images of a cleared post from the index and reindexes a stripped one', async () => {
    dbMock.dbWrite.$queryRaw
      .mockResolvedValueOnce([candidate(1), candidate(2, live)])
      .mockResolvedValueOnce([{ id: 1, modelVersionId: 101, userId: 10, hidden: true }])
      .mockResolvedValueOnce([{ id: 2, modelVersionId: 102, userId: 11, hidden: false }]);

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(200);
    expect(queueImageSearchIndexUpdate.mock.calls).toEqual([
      [{ ids: [901], action: 'Delete' }],
      [{ ids: [902], action: 'Update' }],
    ]);
    expect(deleteImagesForModelVersionCache.mock.calls).toEqual([[[101]], [[102]]]);
    expect(queueUpdate).toHaveBeenCalledWith([{ id: 7, action: 'Update' }]);
    expect(refreshPostCount.mock.calls).toEqual([[[10]], [[11]]]);
    expect(refreshImageVideoCount.mock.calls).toEqual([[[10]], [[11]]]);
    expect(payload.sideEffects).toEqual({
      imagesRemoved: 1,
      imagesReindexed: 1,
      modelsReindexed: 2,
    });
  });

  it('runs side effects for the rows the UPDATE returned, not the rows planned', async () => {
    answerUpdates([candidate(1), candidate(4)], { missing: [1] });

    const { payload } = await call({ dryRun: 'false' });

    expect(dbMock.dbWrite.image.findMany.mock.calls[0][0].where).toEqual({
      postId: { in: [4] },
    });
    expect(payload.ops).toEqual({ clearedPublishedAt: 1, strippedStamp: 0, changedSincePlan: 1 });
  });

  it('issues no UPDATE when every candidate is skipped', async () => {
    answerUpdates([candidates[2]]);

    const { payload } = await call({ dryRun: 'false', halfLive: 'skip' });

    expect(sent()).toHaveLength(1);
    expect(payload.ops).toEqual({ clearedPublishedAt: 0, strippedStamp: 0, changedSincePlan: 0 });
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
  });

  it('scopes the candidate read to postIds when given', async () => {
    answerUpdates([]);

    await call({ postIds: '5,6' });

    expect(JSON.stringify(sent()[0].values)).toContain('[5,6]');
  });

  it('says how far it got when a later batch fails', async () => {
    let calls = 0;
    dbMock.dbWrite.$queryRaw.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [candidate(1), candidate(2), candidate(3)];
      if (calls === 2) return [{ id: 1, modelVersionId: 101, userId: 10, hidden: true }];
      throw new Error('column "secret" does not exist');
    });

    const { statusCode, payload } = await call({
      dryRun: 'false',
      batchSize: '1',
      halfLive: 'clear',
    });

    expect(statusCode).toBe(500);
    expect(payload.committedPosts).toBe(1);
    expect(payload.error).toContain('action=apply again');
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(deleteImagesForModelVersionCache).toHaveBeenCalledWith([101]);
  });

  it('keeps the text of a database error out of the response', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('column "secret" does not exist'));

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(500);
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
  });

  it('keeps writing when a side effect fails, and says to resync', async () => {
    answerUpdates([candidate(1), candidate(4)]);
    queueImageSearchIndexUpdate.mockRejectedValueOnce(new Error('redis down'));

    const { statusCode, payload } = await call({ dryRun: 'false', batchSize: '1' });

    expect(statusCode).toBe(500);
    expect(idBatches(CLEAR)).toEqual([[1], [4]]);
    expect(payload.sideEffectFailures).toBe(1);
    expect(payload.error).toContain('action=resync');
    expect(payload.error).not.toContain('redis down');
    expect(payload.ops.clearedPublishedAt).toBe(2);
  });

  const stashed = [
    { id: 1, modelVersionId: 101, userId: 10, hidden: true, stripped: false },
    { id: 2, modelVersionId: 102, userId: 10, hidden: true, stripped: false },
    { id: 3, modelVersionId: 103, userId: 10, hidden: false, stripped: true },
  ];

  it('rollback without postIds restores cleared posts and leaves stripped ones', async () => {
    answerUpdates(stashed, { missing: [2] });

    const { payload } = await call({ dryRun: 'false', action: 'rollback' });

    expect(idBatches(RESTORE_CLEARED)).toEqual([[1, 2]]);
    expect(statements(RESTORE_STRIPPED)).toHaveLength(0);
    expect(payload.strippedLeftForPostIds).toBe(1);
    expect(payload.ops).toEqual({
      restoredPublishedAt: 1,
      restoredStamp: 0,
      changedSinceApply: 1,
    });
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({ ids: [901], action: 'Delete' });
  });

  it('rollback restores a stripped post named in postIds', async () => {
    answerUpdates([stashed[2]]);

    const { payload } = await call({ dryRun: 'false', action: 'rollback', postIds: '3' });

    expect(idBatches(RESTORE_STRIPPED)).toEqual([[3]]);
    expect(payload.strippedLeftForPostIds).toBe(0);
    expect(payload.ops.restoredStamp).toBe(1);
  });

  it('resync writes no Post row and picks the index action from the row’s state now', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(stashed);

    const { payload } = await call({ dryRun: 'false', action: 'resync' });

    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).not.toContain('UPDATE');
    expect(queueImageSearchIndexUpdate.mock.calls).toEqual([
      [{ ids: [901, 902], action: 'Delete' }],
      [{ ids: [903], action: 'Update' }],
    ]);
    expect(payload.stashed).toBe(3);
  });

  it('cleanup drops every stash key and reindexes nothing', async () => {
    answerUpdates(stashed);

    const { statusCode, payload } = await call({ dryRun: 'false', action: 'cleanup' });

    expect(statusCode).toBe(200);
    const [drop] = statements('UPDATE');
    for (const key of [
      'repairPrevPublishedAt',
      'repairAddedPrevPublishedAt',
      'repairStampAt',
      'repairPrevUnpublishedAt',
      'repairPrevUnpublishedBy',
    ])
      expect(drop.text).toContain(`- '${key}'`);
    expect(drop.text).not.toContain('"publishedAt" =');
    expect(payload.ops).toEqual({ stashDropped: 3 });
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(refreshPostCount).not.toHaveBeenCalled();
  });
});
