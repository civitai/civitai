import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  imageAuditContentHash,
  parseReviewBatchRecord,
  reviewBatchHash,
} from '@civitai/shared/review-batch';

/**
 * The review batch mint: who may mint, how the tier is decided, what the batch store holds, and how
 * repeats and key revocation end batches. Postgres signals and ClickHouse labels are faked rows;
 * sysRedis is an in-memory store with NX/EX, sets and MULTI.
 */

const { mockIsFlipt, mockClickhouseQuery, mockGetSessionUser } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockClickhouseQuery: vi.fn(),
  mockGetSessionUser: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { query: mockClickhouseQuery } }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: mockGetSessionUser },
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: ({ user }: { user: { permissions?: string[] } }) => ({
    csamReports: !!user.permissions?.includes('csamReports'),
  }),
}));

const { mintReviewBatch, isDeclared } = await import('../review-batch.service');
const { revokeReviewBatchesOfKeys } = await import('../review-batch.store');

// ---------------------------------------------------------------------------------------------
// In-memory sysRedis.
type Entry = { value: string | Set<string>; expiresAt: number | null };
let store = new Map<string, Entry>();
const live = (key: string) => {
  const e = store.get(key);
  if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) store.delete(key);
  return store.get(key);
};
const ops = {
  set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && live(key)) return null;
    store.set(key, { value, expiresAt: opts?.EX ? Date.now() + opts.EX * 1000 : null });
    return 'OK';
  },
  get: (key: string) => {
    const v = live(key)?.value;
    return typeof v === 'string' ? v : null;
  },
  del: (keys: string | string[]) => {
    for (const key of [keys].flat()) store.delete(key);
    return 1;
  },
  sAdd: (key: string, member: string) => {
    const e = live(key);
    const set = e?.value instanceof Set ? e.value : new Set<string>();
    set.add(member);
    store.set(key, { value: set, expiresAt: e?.expiresAt ?? null });
    return 1;
  },
  sRem: (key: string, member: string) => {
    const v = live(key)?.value;
    if (v instanceof Set) v.delete(member);
    return 1;
  },
  sMembers: (key: string) => {
    const v = live(key)?.value;
    return v instanceof Set ? [...v] : [];
  },
  expire: (key: string, seconds: number) => {
    const e = live(key);
    if (e) e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function installFakeSysRedis() {
  store = new Map();
  const r = redisMock.sysRedis;
  for (const [name, op] of Object.entries(ops))
    r[name].mockImplementation(async (...args: unknown[]) => {
      await tick();
      return (op as (...a: unknown[]) => unknown)(...args);
    });
  r.multi.mockImplementation(() => {
    const queued: [keyof typeof ops, unknown[]][] = [];
    const chain: Record<string, unknown> = {
      exec: async () => {
        await tick();
        return queued.map(([name, args]) => (ops[name] as (...a: unknown[]) => unknown)(...args));
      },
    };
    for (const name of Object.keys(ops) as (keyof typeof ops)[])
      chain[name] = (...args: unknown[]) => {
        queued.push([name, args]);
        return chain;
      };
    return chain;
  });
}

const batchKeys = () => [...store.keys()].filter((k) => /^app:review-batch:[^:]+$/.test(k));
const batchFor = (batchId: string) =>
  parseReviewBatchRecord(ops.get(`app:review-batch:${reviewBatchHash(batchId)}`));

// ---------------------------------------------------------------------------------------------

const MOD = { id: 7, isModerator: true, permissions: ['csamReports'] };
const VIEWER = { id: 8, isModerator: true, permissions: ['csamReports'] };
const ctx = { actor: MOD as never, apiKeyId: 99 };
const signalRow = (id: number, over: Partial<Record<string, unknown>> = {}) => ({
  id,
  suspect: false,
  unreadable: false,
  blockedFor: null,
  ...over,
});

let pgRows: ReturnType<typeof signalRow>[] = [];
// Per image: its scanner rows hold a CSAM/minor label (1), none (0), or it has no rows (absent).
let scannerRows = new Map<number, 0 | 1>();

const mint = (over: Partial<Parameters<typeof mintReviewBatch>[0]> = {}) =>
  mintReviewBatch(
    {
      ids: [1, 2],
      viewer: VIEWER.id,
      suspect: false,
      source: 'card-1',
      sourceText: ['look'],
      ...over,
    },
    ctx
  );

beforeEach(() => {
  installFakeSysRedis();
  setEnv({
    REVIEW_SHEET_SUSPECT_TERMS: 'alpha\nbeta gamma',
    REVIEW_SHEET_BLOCKEDFOR_PATTERNS: '# signal\n^sig$\n# known-non-minor\n^benign$',
  });
  mockIsFlipt.mockResolvedValue(true);
  mockGetSessionUser.mockImplementation(async (id: number) => (id === VIEWER.id ? VIEWER : null));
  pgRows = [signalRow(1), signalRow(2)];
  scannerRows = new Map([
    [1, 0],
    [2, 0],
  ]);
  dbMock.dbWrite.$queryRaw.mockImplementation(async () => pgRows);
  mockClickhouseQuery.mockImplementation(
    async ({ query_params }: { query_params: { hashes: string[] } }) => ({
      json: async () =>
        [...scannerRows]
          .filter(([id]) => query_params.hashes.includes(imageAuditContentHash(id)))
          .map(([id, hit]) => ({ contentHash: imageAuditContentHash(id), hit })),
    })
  );
});

describe('the tier', () => {
  it('clean images with clean source text mint general', async () => {
    expect((await mint()).tier).toBe('general');
  });

  it('a batch its minter declares suspect is held, whatever its images', async () => {
    const { batchId, tier } = await mint({ suspect: true });
    expect(tier).toBe('held');
    expect(batchFor(batchId)!.declared).toBe(true);
  });
  it('suspect=false is overridden by a term in the source text', async () => {
    expect((await mint({ sourceText: ['see ALPHA here'] })).tier).toBe('held');
  });

  it('no source card, or no source text, is held', async () => {
    expect((await mint({ source: ' ' })).tier).toBe('held');
    expect((await mint({ sourceText: [] })).tier).toBe('held');
  });

  it('an image with a Postgres signal, an unreadable scan, or no row at all is held', async () => {
    pgRows = [signalRow(1, { suspect: true }), signalRow(2)];
    expect((await mint()).tier).toBe('held');
    pgRows = [signalRow(1, { unreadable: true }), signalRow(2)];
    expect((await mint()).tier).toBe('held');
    pgRows = [signalRow(1)];
    expect((await mint()).tier).toBe('held');
    pgRows = [signalRow(1, { blockedFor: 'unknown' }), signalRow(2)];
    expect((await mint()).tier).toBe('held');
  });

  it('a label only ClickHouse holds makes the batch held', async () => {
    scannerRows.set(2, 1);
    expect((await mint()).tier).toBe('held');
  });

  it('ClickHouse failing or timing out is held', async () => {
    mockClickhouseQuery.mockRejectedValueOnce(new Error('timeout'));
    expect((await mint()).tier).toBe('held');
  });

  it('without the term list or the blockedFor patterns every batch is held', async () => {
    setEnv({ REVIEW_SHEET_SUSPECT_TERMS: undefined });
    expect(isDeclared({ suspect: false, source: 'c', sourceText: ['x'] })).toBe(true);
    expect((await mint()).tier).toBe('held');
    setEnv({
      REVIEW_SHEET_SUSPECT_TERMS: 'alpha',
      REVIEW_SHEET_BLOCKEDFOR_PATTERNS: undefined,
    });
    expect((await mint()).tier).toBe('held');
  });
});

describe('who may mint', () => {
  it('refuses with the brake off, without the held grant, without an API key, or for a viewer without it', async () => {
    mockIsFlipt.mockResolvedValueOnce(false);
    await expect(mint()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(
      mintReviewBatch(
        { ids: [1], viewer: 8, suspect: false, source: 'c', sourceText: ['x'] },
        { actor: { ...MOD, permissions: [] } as never, apiKeyId: 99 }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      mintReviewBatch(
        { ids: [1], viewer: 8, suspect: false, source: 'c', sourceText: ['x'] },
        { actor: MOD as never, apiKeyId: null }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mockGetSessionUser.mockResolvedValueOnce({ ...VIEWER, permissions: [] });
    await expect(mint()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(batchKeys()).toEqual([]);
  });
});

describe('the batch store', () => {
  it('stores the record under the id hash, never the id, card text or a signal', async () => {
    const { batchId, link } = await mint({ sourceText: ['secret words'] });
    expect(link).toBe(`https://moderator.civitai.com/api/review-media/b/${batchId}`);
    const raw = JSON.stringify([...store.entries()].map(([k, e]) => [k, [e.value].flat()]));
    expect(raw).not.toContain(batchId);
    expect(raw).not.toContain('secret words');
    expect(Object.keys(batchFor(batchId)!).sort()).toEqual(
      ['createdAt', 'createdBy', 'declared', 'ids', 'keyId', 'seat', 'tier', 'viewer'].sort()
    );
  });

  it('a repeat with one idempotency key leaves exactly one live batch', async () => {
    const first = await mint({ idempotencyKey: 'k'.repeat(22) });
    const second = await mint({ idempotencyKey: 'k'.repeat(22) });
    expect(batchFor(first.batchId)).toBeNull();
    expect(batchFor(second.batchId)).not.toBeNull();
    expect(batchKeys()).toHaveLength(1);
  });

  it('two concurrent mints with one idempotency key: one batch, the other answers 409', async () => {
    const results = await Promise.allSettled([
      mint({ idempotencyKey: 'c'.repeat(22) }),
      mint({ idempotencyKey: 'c'.repeat(22) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'CONFLICT' });
    expect(batchKeys()).toHaveLength(1);
  });

  it('revoking the key ends every batch it minted, and no other', async () => {
    const a = await mint();
    const b = await mint();
    const other = await mintReviewBatch(
      { ids: [1], viewer: VIEWER.id, suspect: false, source: 'c', sourceText: ['x'] },
      { actor: MOD as never, apiKeyId: 100 }
    );
    await revokeReviewBatchesOfKeys([99]);
    expect(batchFor(a.batchId)).toBeNull();
    expect(batchFor(b.batchId)).toBeNull();
    expect(batchFor(other.batchId)).not.toBeNull();
  });
});

describe('the scanner leg', () => {
  it('an image with no scanner rows yet cannot be shown clean, so the batch is held', async () => {
    scannerRows.delete(2);
    expect((await mint()).tier).toBe('held');
  });
});

describe('the viewer', () => {
  it.each([
    ['does not exist', null],
    ['is not a moderator', { ...VIEWER, isModerator: false }],
    ['is banned', { ...VIEWER, bannedAt: new Date() }],
  ])('a viewer who %s is refused, and nothing is stored', async (_case, viewer) => {
    mockGetSessionUser.mockResolvedValueOnce(viewer);
    await expect(mint()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(batchKeys()).toEqual([]);
  });
});
