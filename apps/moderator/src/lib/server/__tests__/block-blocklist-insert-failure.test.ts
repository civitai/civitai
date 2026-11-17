import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insert, logAxiomError, logToAxiom } = vi.hoisted(() => ({
  logToAxiom: vi.fn(async (_data: Record<string, unknown>) => undefined),
  insert: vi.fn(async (_args: { table: string; values: unknown[] }) => undefined),
  logAxiomError: vi.fn(async (_error: unknown, _extra?: Record<string, unknown>) => undefined),
}));

// Every query builder call chains, and `execute` finds no rows: the other side effects in the set
// have nothing to act on, so only the blocklist step does any work.
vi.mock('../db', () => {
  const chain: unknown = new Proxy(() => chain, {
    get: (_t, key) => (key === 'execute' ? async () => [] : key === 'then' ? undefined : chain),
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

const blocklistInserts = () =>
  insert.mock.calls.filter(([args]) => args.table === 'blocked_images');

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockReset();
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
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'csam-blocklist-write-failed',
        payload: expect.objectContaining({ imageCount: 1 }),
      })
    );
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
          hashes: [HASH],
        }),
      })
    );
  });
});
