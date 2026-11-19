import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insert, logAxiomError, logToAxiom } = vi.hoisted(() => ({
  logToAxiom: vi.fn(async (_data: Record<string, unknown>) => undefined),
  insert: vi.fn(async (_args: { table: string; values: unknown[] }) => undefined),
  logAxiomError: vi.fn(async (_error: unknown, _extra?: Record<string, unknown>) => undefined),
}));

const { copyFails } = vi.hoisted(() => ({ copyFails: { on: false } }));

// Every query builder call chains, and `execute` finds no rows: the other side effects in the set
// have nothing to act on, so only the blocklist step does any work. `executeQuery` runs the raw
// held-media copy, which fails while `copyFails.on`.
vi.mock('../db', () => {
  const executeQuery = async () => {
    if (copyFails.on) throw Object.assign(new Error('copy failed'), { code: 'P0001' });
    return { rows: [] };
  };
  const chain: unknown = new Proxy(() => chain, {
    get: (_t, key) =>
      key === 'execute'
        ? async () => []
        : key === 'executeQuery'
        ? executeQuery
        : key === 'then'
        ? undefined
        : chain,
    apply: () => chain,
  });
  return { dbRead: chain, dbWrite: chain };
});
const { query } = vi.hoisted(() => ({
  query: vi.fn(async (_args: { query: string }) => ({ json: async () => [] as unknown[] })),
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert, query }) }));
vi.mock('../axiom', () => ({ logAxiomError, logToAxiom }));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../redis', () => ({
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
  getRedis: vi.fn(),
}));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));
vi.mock('../cache', () => ({ bustCacheTag: vi.fn(), bustCachedObject: vi.fn() }));

const { applyBlockSideEffects, CsamBlocklistWriteError } = await import(
  '../image-moderation-effects'
);

const HASH = '-1234567890123456789';
const block = () =>
  applyBlockSideEffects(
    { pHash: HASH, needsReview: null, blockedFor: null, nsfwLevel: 1, postId: null, userId: 42 },
    { imageId: 7, actorUserId: 9, heldImage: true, removedForCsam: true }
  );

/** Every log call, errors with their message and cause, as one string. */
const serialisedLogs = () =>
  JSON.stringify([logToAxiom.mock.calls, logAxiomError.mock.calls], (_key, value) =>
    value instanceof Error ? { message: value.message, cause: value.cause } : value
  );

const blocklistInserts = () =>
  insert.mock.calls.filter(([args]) => args.table === 'blocked_images');

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockReset();
  copyFails.on = false;
});

describe('the blocklist insert on an image block', () => {
  it('writes the image hash (control: the mock sees the write)', async () => {
    await block();
    expect(blocklistInserts()).toEqual([
      [expect.objectContaining({ values: [{ hash: HASH, reason: 'CSAM' }] })],
    ]);
  });

  // A CSAM entry that fails to write is reported to the moderator, not swallowed, so they can
  // retry. The block itself has already committed by then.
  it('reports a failed CSAM insert to the caller, after the other effects ran, and logs it', async () => {
    insert.mockImplementation(async ({ table }) => {
      if (table === 'blocked_images') throw new Error('Socket hang up after 3 retries');
    });

    await expect(block()).rejects.toBeInstanceOf(CsamBlocklistWriteError);
    await expect(block()).rejects.toMatchObject({ failedStore: 'blocklist' });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'csam-blocklist-write-failed',
        payload: expect.objectContaining({ imageCount: 1 }),
      })
    );
  });

  it('reports a failed held-media copy to the caller, naming the copy', async () => {
    copyFails.on = true;

    await expect(block()).rejects.toMatchObject({ failedStore: 'held-media-copy' });
    expect(blocklistInserts()).toHaveLength(1);
  });

  it('still swallows a failed non-CSAM insert, logging the step (control)', async () => {
    insert.mockImplementation(async ({ table }) => {
      if (table === 'blocked_images') throw new Error('Socket hang up after 3 retries');
    });

    await expect(
      applyBlockSideEffects(
        {
          pHash: HASH,
          needsReview: null,
          blockedFor: null,
          nsfwLevel: 1,
          postId: null,
          userId: 42,
        },
        { imageId: 7, actorUserId: 9 }
      )
    ).resolves.toBeUndefined();
    expect(logAxiomError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ event: 'image moderation side effect failed', step: 'blocklist' })
    );
  });

  // Characterises the gap the issue reports: after one failed insert nothing holds the hash for a
  // later attempt. The log line is the only trace. Flip this when a durable retry lands.
  it('makes exactly one attempt and keeps no record of the failed hash', async () => {
    insert.mockImplementation(async ({ table }) => {
      if (table === 'blocked_images') throw new Error('Socket hang up after 3 retries');
    });

    await block().catch(() => undefined);
    expect(blocklistInserts()).toHaveLength(1);
    const otherWrites = insert.mock.calls.filter(([args]) =>
      JSON.stringify(args.values).includes(HASH)
    );
    expect(otherWrites).toHaveLength(1);
  });
});

describe('the blocklist check on a non-CSAM block', () => {
  const tosBlock = () =>
    applyBlockSideEffects(
      { pHash: HASH, needsReview: null, blockedFor: null, nsfwLevel: 1, postId: null, userId: 42 },
      { imageId: 7, actorUserId: 9 }
    );

  it('writes the hash when the check succeeds (control)', async () => {
    await tosBlock();
    expect(blocklistInserts()).toHaveLength(1);
  });

  // A driver message can quote the statement and its hashes; none of it reaches a log.
  it('logs no hash when the insert or the check fails with a message quoting it', async () => {
    insert.mockImplementation(async ({ table }) => {
      if (table === 'blocked_images') throw new Error(`Cannot parse input: {"hash":${HASH}}`);
    });
    await tosBlock();
    insert.mockReset();
    query.mockRejectedValueOnce(new Error(`ClickHouse query failed. Query: ... IN (${HASH})`));
    await tosBlock();

    expect(logAxiomError).toHaveBeenCalled();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'blocklist-insert-skipped' })
    );
    expect(serialisedLogs()).not.toContain(HASH.slice(1));
  });

  it('completes the action when the check fails, writes nothing, and logs it', async () => {
    query.mockRejectedValueOnce(new Error('Socket hang up'));

    await expect(tosBlock()).resolves.toBeUndefined();
    expect(blocklistInserts()).toHaveLength(0);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-insert-skipped',
        payload: expect.objectContaining({
          step: 'block',
          imageId: 7,
          actorUserId: 9,
          hashCount: 1,
        }),
      })
    );
  });
});
