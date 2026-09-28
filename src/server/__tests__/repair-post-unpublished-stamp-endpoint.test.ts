import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { env, queueImageSearchIndexUpdate, deleteImagesForModelVersionCache, queueUpdate } =
  vi.hoisted(() => ({
    env: {
      WEBHOOK_TOKEN: 'test-token',
      LOGGING: '',
      NEXTAUTH_URL: 'https://example.test',
      TRPC_ORIGINS: [] as string[],
    },
    queueImageSearchIndexUpdate: vi.fn(async () => undefined),
    deleteImagesForModelVersionCache: vi.fn(async () => undefined),
    queueUpdate: vi.fn(async () => undefined),
  }));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate,
  deleteImagesForModelVersionCache,
}));

const handler = (await import('~/pages/api/admin/temp/repair-post-unpublished-stamp')).default;

type Payload = {
  dryRun: boolean;
  candidates: number;
  stashed: number;
  committedPosts: number;
  buckets: Record<string, { posts: number; sample: number[] }>;
  ops: Record<string, number>;
  sideEffects: Record<string, number> | null;
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

const published = new Date('2024-05-05T14:18:00.000Z');
const candidate = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  publishedAt: published,
  unpublishedAt: new Date('2024-05-05T15:03:00.000Z'),
  userId: 10,
  modelVersionId: 100 + id,
  versionStatus: 'Unpublished',
  modelStatus: 'Unpublished',
  modelUserId: 10,
  ...overrides,
});
const candidates = [
  candidate(1),
  candidate(2, { unpublishedAt: new Date('2024-05-01T00:00:00.000Z') }),
  candidate(3, { versionStatus: 'Published', modelStatus: 'Published' }),
];

const CLEAR = '"publishedAt" = NULL';
const STRIP = "- 'unpublishedAt' - 'unpublishedBy'";

// A statement reaches $queryRaw either as a tagged template or as a Prisma.Sql.
type Sent = { text: string; values: unknown[] };
const sent = (): Sent[] =>
  dbMock.dbWrite.$queryRaw.mock.calls.map((args: unknown[]) => {
    const [first, ...rest] = args as [{ strings?: string[]; values?: unknown[] } | string[]];
    if (Array.isArray(first)) return { text: first.join('?'), values: rest };
    return { text: (first.strings ?? []).join('?'), values: first.values ?? [] };
  });
const idBatches = (fragment: string) =>
  sent()
    .filter((s) => s.text.includes(fragment))
    .map((s) => s.values[0]);

/** Answers the first read with `select` and each UPDATE with the ids it was given, as RETURNING does. */
function answerUpdates(select: unknown[], missing: number[] = []) {
  let first = true;
  dbMock.dbWrite.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    if (first) {
      first = false;
      return select;
    }
    const ids = ((args[0] as { values: unknown[] }).values[0] as number[]) ?? [];
    return ids
      .filter((id) => !missing.includes(id))
      .map((id) => ({ id, modelVersionId: 100 + id }));
  });
}

describe('repair-post-unpublished-stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.$queryRaw.mockReset();
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ id: 900 }, { id: 901 }]);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ modelId: 7 }]);
  });

  it('rejects a call with the wrong token and reads nothing', async () => {
    const { statusCode } = await call({}, 'wrong');

    expect(statusCode).toBe(401);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('defaults to a dry run: reports the plan and runs no side effect', async () => {
    answerUpdates(candidates);

    const { statusCode, payload } = await call({});

    expect(statusCode).toBe(200);
    expect(payload.dryRun).toBe(true);
    expect(payload.candidates).toBe(3);
    expect(payload.buckets.orphan).toEqual({ posts: 1, sample: [1] });
    expect(payload.buckets.liveParent).toEqual({ posts: 1, sample: [3] });
    expect(payload.ops).toEqual({ clearedPublishedAt: 1, strippedStamp: 1, skipped: 1 });
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(deleteImagesForModelVersionCache).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('leaves the post of a live model alone unless told what to do with it', async () => {
    answerUpdates(candidates);

    await call({ dryRun: 'false' });

    expect(idBatches(CLEAR)).toEqual([[1]]);
    expect(idBatches(STRIP)).toEqual([[2]]);
  });

  it('strips the stamp of a live model post with liveParent=strip, never clears it', async () => {
    answerUpdates(candidates);

    await call({ dryRun: 'false', liveParent: 'strip' });

    expect(idBatches(CLEAR)).toEqual([[1]]);
    expect(idBatches(STRIP)).toEqual([[2, 3]]);
  });

  it('commits batchSize posts per transaction, never the whole set in one', async () => {
    answerUpdates([candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)]);

    const { payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(idBatches(CLEAR)).toEqual([[1, 2], [3, 4], [5]]);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(3);
    expect(payload.ops.clearedPublishedAt).toBe(5);
  });

  it('issues no UPDATE for an empty action list', async () => {
    answerUpdates([candidates[2]]);

    const { payload } = await call({ dryRun: 'false' });

    expect(sent()).toHaveLength(1);
    expect(payload.ops).toEqual({ clearedPublishedAt: 0, strippedStamp: 0, skipped: 1 });
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
  });

  it('reindexes and evicts for the rows the UPDATEs returned, not the rows planned', async () => {
    // Post 1 was planned but changed before its UPDATE ran, so only post 2 came back.
    answerUpdates(candidates, [1]);

    const { payload } = await call({ dryRun: 'false' });

    expect(dbMock.dbWrite.image.findMany.mock.calls[0][0].where).toEqual({
      postId: { in: [2] },
    });
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({ ids: [900, 901], action: 'Update' });
    expect(deleteImagesForModelVersionCache).toHaveBeenCalledWith([102]);
    expect(queueUpdate).toHaveBeenCalledWith([{ id: 7, action: 'Update' }]);
    expect(payload.ops.clearedPublishedAt).toBe(0);
    expect(payload.sideEffects).toEqual({
      imagesReindexed: 2,
      versionCachesEvicted: 1,
      modelsReindexed: 1,
    });
  });

  it('scopes the candidate read to postIds when given', async () => {
    answerUpdates([]);

    await call({ postIds: '5,6' });

    expect(JSON.stringify(sent()[0].values)).toContain('[5,6]');
  });

  it('reindexes what committed when a later batch fails, and says how far it got', async () => {
    let calls = 0;
    dbMock.dbWrite.$queryRaw.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [candidate(1), candidate(2), candidate(3)];
      if (calls === 2) return [{ id: 1, modelVersionId: 101 }];
      throw new Error('column "secret" does not exist');
    });

    const { statusCode, payload } = await call({ dryRun: 'false', batchSize: '1' });

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

  it('rollback restores only rows still in the state apply left, and counts the rest', async () => {
    let calls = 0;
    dbMock.dbWrite.$queryRaw.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [1, 2, 3, 4].map((id) => ({ id, modelVersionId: 100 + id }));
      if (calls === 2) return [{ id: 1, modelVersionId: 101 }];
      return [{ id: 2, modelVersionId: 102 }];
    });

    const { payload } = await call({ dryRun: 'false', action: 'rollback' });

    const [, restoreCleared, restoreStripped] = sent();
    expect(restoreCleared.text).toContain('p."publishedAt" IS NULL');
    expect(restoreStripped.text).toContain(`p.metadata->>'unpublishedAt' IS NULL`);
    expect(payload.ops).toEqual({
      restoredPublishedAt: 1,
      restoredStamp: 1,
      changedSinceApply: 2,
    });
    expect(queueImageSearchIndexUpdate).toHaveBeenCalled();
  });

  it('resync writes no Post row and re-runs the side effects for stashed rows', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ id: 1, modelVersionId: 101 }]);

    const { payload } = await call({ dryRun: 'false', action: 'resync' });

    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).not.toContain('UPDATE');
    expect(deleteImagesForModelVersionCache).toHaveBeenCalledWith([101]);
    expect(payload.stashed).toBe(1);
  });

  it('says the write committed when a side effect fails afterwards', async () => {
    answerUpdates(candidates);
    queueImageSearchIndexUpdate.mockRejectedValueOnce(new Error('redis down'));

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(500);
    expect(payload.error).toContain('action=resync');
    expect(payload.error).not.toContain('redis down');
    expect(payload.ops.clearedPublishedAt).toBe(1);
  });
});
