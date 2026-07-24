import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbWrite,
  mockGetModelVersionData,
  mockGetPdf,
  mockFetchBlob,
  mockGetCustomPutUrl,
  mockGetS3Client,
  mockProcessedInc,
  mockFailedInc,
} = vi.hoisted(() => ({
  mockDbWrite: {
    vaultItem: { findMany: vi.fn(), update: vi.fn() },
  },
  mockGetModelVersionData: vi.fn(),
  mockGetPdf: vi.fn(),
  mockFetchBlob: vi.fn(),
  mockGetCustomPutUrl: vi.fn(),
  mockGetS3Client: vi.fn(),
  mockProcessedInc: vi.fn(),
  mockFailedInc: vi.fn(),
}));

vi.mock('@prisma/client', () => ({ Prisma: { AnyNull: Symbol('AnyNull') } }));
vi.mock('~/shared/utils/prisma/enums', () => ({
  VaultItemStatus: { Pending: 'Pending', Failed: 'Failed', Stored: 'Stored' },
}));
vi.mock('~/env/server', () => ({ env: { S3_VAULT_BUCKET: 'vault-bucket' } }));
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => ({ catch: () => {} }) }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: async () => [new Date(0), async () => {}],
}));
vi.mock('~/server/prom/client', () => ({
  vaultItemProcessedCounter: { inc: mockProcessedInc },
  vaultItemFailedCounter: { inc: mockFailedInc },
}));
vi.mock('~/server/services/vault.service', () => ({
  getModelVersionDataForVault: mockGetModelVersionData,
}));
vi.mock('~/server/utils/pdf-helpers', () => ({ getModelVersionDetailsPDF: mockGetPdf }));
vi.mock('~/utils/file-utils', () => ({ fetchBlob: mockFetchBlob }));
vi.mock('~/utils/s3-utils', () => ({
  getCustomPutUrl: mockGetCustomPutUrl,
  getS3Client: mockGetS3Client,
}));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/errorHandling', () => ({
  withRetries: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('~/server/common/constants', () => ({
  constants: {
    vault: {
      keys: {
        details: ':userId/:modelVersionId/details.pdf',
        images: ':userId/:modelVersionId/images.zip',
        cover: ':userId/:modelVersionId/cover',
      },
    },
  },
}));
vi.mock('jszip', () => ({
  default: class {
    file() {}
    async generateAsync() {
      return { size: 2048 };
    }
  },
}));

import {
  processVaultItem,
  processVaultItems,
  getEligibleVaultItemsQuery,
  MAX_FAILURES,
  VAULT_ITEMS_BATCH_SIZE,
  LEASE_STALENESS_MS,
} from '~/server/jobs/process-vault-items';

// The eligibility WHERE ANDs two OR-groups: [0] = retry-budget, [1] = overlap
// lease guard. Small helpers keep the assertions robust to ordering.
const budgetOr = (q: any) =>
  q.where.AND.find((g: any) => g.OR?.some((b: any) => b.meta?.path?.[0] === 'failures')).OR;
const leaseOr = (q: any) =>
  q.where.AND.find((g: any) => g.OR?.some((b: any) => b.meta?.path?.[0] === 'processingStartedAt'))
    .OR;

const makeItem = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  vaultId: 10,
  modelVersionId: 100,
  meta: null,
  ...overrides,
});

const ctx = { s3: {} as never, bucket: 'vault-bucket' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  mockGetS3Client.mockResolvedValue({});
  mockGetPdf.mockResolvedValue({ size: 512 });
  mockGetCustomPutUrl.mockResolvedValue({ url: 'https://put.example/obj' });
  mockGetModelVersionData.mockResolvedValue({
    modelVersion: {},
    images: [{ url: 'a', type: 'image', name: 'a.png' }],
  });
  mockFetchBlob.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) });
});

describe('getEligibleVaultItemsQuery — bounded batch + retry-budget exclusion', () => {
  it('caps the run at VAULT_ITEMS_BATCH_SIZE', () => {
    const q = getEligibleVaultItemsQuery();
    expect(q.take).toBe(VAULT_ITEMS_BATCH_SIZE);
    // sanity: the batch is bounded, not unbounded
    expect(q.take).toBeGreaterThan(0);
    expect(Number.isFinite(q.take)).toBe(true);
  });

  it('only selects items whose failure count is within the retry budget', () => {
    const q = getEligibleVaultItemsQuery();
    const lteBranch = budgetOr(q).find((b: any) => typeof b.meta?.lte === 'number');
    expect(lteBranch?.meta?.path).toEqual(['failures']);
    expect(lteBranch?.meta?.lte).toBe(MAX_FAILURES);

    // The lte branch is the mechanism that drops a permanently-failing item:
    // an item that has been (pre-)incremented past MAX_FAILURES no longer matches.
    const withinBudget = (failures: number) => failures <= (lteBranch?.meta?.lte as number);
    expect(withinBudget(MAX_FAILURES)).toBe(true);
    expect(withinBudget(MAX_FAILURES + 1)).toBe(false); // OOM'd one time too many -> excluded
  });
});

describe('processVaultItem — OOM-resilient failure accounting', () => {
  it('persists the failure increment BEFORE the heavy download+zip work', async () => {
    await processVaultItem(makeItem({ meta: { failures: 0 } }), ctx);

    // First DB write is the pre-attempt marker.
    const firstUpdate = mockDbWrite.vaultItem.update.mock.calls[0][0];
    expect(firstUpdate.where).toEqual({ id: 1 });
    expect(firstUpdate.data.meta.failures).toBe(1);
    // It must NOT prematurely flip status — it's only an attempt marker.
    expect(firstUpdate.data.status).toBeUndefined();

    // Ordering: the pre-increment update ran before the first heavy call.
    const preIncrementOrder = mockDbWrite.vaultItem.update.mock.invocationCallOrder[0];
    const heavyWorkOrder = mockGetModelVersionData.mock.invocationCallOrder[0];
    expect(preIncrementOrder).toBeLessThan(heavyWorkOrder);
  });

  it('treats a missing/null meta as 0 failures for the pre-increment', async () => {
    await processVaultItem(makeItem({ meta: null }), ctx);
    expect(mockDbWrite.vaultItem.update.mock.calls[0][0].data.meta.failures).toBe(1);
  });

  it('rolls the increment back to the prior value on success (no net failure counted)', async () => {
    await processVaultItem(makeItem({ meta: { failures: 2 } }), ctx);

    const calls = mockDbWrite.vaultItem.update.mock.calls;
    // pre-increment optimistically bumps to 3...
    expect(calls[0][0].data.meta.failures).toBe(3);
    // ...and the successful Stored write rolls it back to the prior 2.
    const storedWrite = calls[calls.length - 1][0];
    expect(storedWrite.data.status).toBe('Stored');
    expect(storedWrite.data.meta.failures).toBe(2);
    expect(mockProcessedInc).toHaveBeenCalledTimes(1);
    expect(mockFailedInc).not.toHaveBeenCalled();
  });

  it('counts exactly one failure on a catchable error (no double increment)', async () => {
    mockGetModelVersionData.mockRejectedValueOnce(new Error('boom'));

    await processVaultItem(makeItem({ meta: { failures: 1 } }), ctx);

    const calls = mockDbWrite.vaultItem.update.mock.calls;
    // pre-increment marker
    expect(calls[0][0].data.meta.failures).toBe(2);
    // catch path re-asserts the SAME count (prior+1), does not increment again
    const failWrite = calls[calls.length - 1][0];
    expect(failWrite.data.status).toBe('Failed');
    expect(failWrite.data.meta.failures).toBe(2);
    expect(failWrite.data.meta.latestError).toBe('boom');
    expect(mockFailedInc).toHaveBeenCalledTimes(1);
    expect(mockProcessedInc).not.toHaveBeenCalled();
  });

  it('climbs past MAX_FAILURES across repeated OOM-style attempts, then is excluded', () => {
    // Simulate the uncatchable path: each run only the pre-increment persists.
    const q = getEligibleVaultItemsQuery();
    const budget = (budgetOr(q).find((b: any) => typeof b.meta?.lte === 'number') as any).meta
      .lte as number;
    let failures = 0; // starts from null-meta -> 0
    let runs = 0;
    // Item stays eligible only while within budget; each attempt pre-increments.
    while (failures <= budget) {
      failures += 1; // the pre-attempt marker that survives an OOMKill
      runs += 1;
      if (runs > 100) throw new Error('did not converge'); // guard against infinite loop
    }
    expect(failures).toBe(MAX_FAILURES + 1);
    expect(failures > budget).toBe(true); // now excluded from the next findMany
  });
});

// Fix A: a transient failure on ONE item must not abort the whole batch.
describe('processVaultItems — per-item isolation (one failure never aborts the batch)', () => {
  it('continues to the next item when a per-item processing error propagates', async () => {
    const item1 = makeItem({ id: 1, modelVersionId: 100, meta: { failures: 0 } });
    const item2 = makeItem({ id: 2, modelVersionId: 200, meta: { failures: 0 } });
    mockDbWrite.vaultItem.findMany.mockResolvedValueOnce([item1, item2]);

    // The FIRST update (item1's pre-attempt increment — which runs OUTSIDE
    // processVaultItem's own try/catch) throws a transient DB error. Every
    // subsequent update succeeds.
    mockDbWrite.vaultItem.update
      .mockRejectedValueOnce(new Error('transient db blip'))
      .mockResolvedValue({});

    // Must not reject: the batch swallows item1's error and moves on.
    await expect(processVaultItems({} as never)).resolves.not.toThrow();

    // item2 was still processed: its heavy work ran with item2's modelVersionId.
    expect(mockGetModelVersionData).toHaveBeenCalledTimes(1);
    expect(mockGetModelVersionData).toHaveBeenCalledWith({ modelVersionId: 200 });
    // item2 reached its terminal Stored write (last update targets id 2).
    const lastUpdate = mockDbWrite.vaultItem.update.mock.calls.at(-1)?.[0];
    expect(lastUpdate.where).toEqual({ id: 2 });
    expect(lastUpdate.data.status).toBe('Stored');
  });

  it('processes every remaining item even if an earlier one throws mid-batch', async () => {
    const items = [1, 2, 3].map((id) => makeItem({ id, modelVersionId: id * 10, meta: null }));
    mockDbWrite.vaultItem.findMany.mockResolvedValueOnce(items);

    // Middle item's pre-increment update throws; the other two succeed.
    mockDbWrite.vaultItem.update
      .mockResolvedValueOnce({}) // item1 pre-increment
      .mockImplementation(async (arg: any) => {
        if (arg.where.id === 2 && arg.data.meta.processingStartedAt) {
          throw new Error('transient db blip on item 2');
        }
        return {};
      });

    await expect(processVaultItems({} as never)).resolves.not.toThrow();

    // Heavy work ran for item1 and item3 (not the throwing item2).
    const processedVersionIds = mockGetModelVersionData.mock.calls.map((c) => c[0].modelVersionId);
    expect(processedVersionIds).toContain(10);
    expect(processedVersionIds).toContain(30);
    expect(processedVersionIds).not.toContain(20);
  });
});

// Fix B: overlap guard — an in-flight (freshly-leased) item is excluded from the
// eligibility query; a stale lease (killed run) becomes eligible again.
describe('getEligibleVaultItemsQuery — overlap lease guard', () => {
  it('excludes freshly-leased in-flight items but includes stale/unleased ones', () => {
    const before = Date.now();
    const q = getEligibleVaultItemsQuery();
    const after = Date.now();

    const ltBranch = leaseOr(q).find((b: any) => typeof b.meta?.lt === 'number');
    const nullBranch = leaseOr(q).find((b: any) => b.meta?.equals !== undefined);

    // The lease cutoff = now - LEASE_STALENESS_MS (computed at query-build time).
    expect(ltBranch?.meta?.path).toEqual(['processingStartedAt']);
    expect(ltBranch?.meta?.lt).toBeGreaterThanOrEqual(before - LEASE_STALENESS_MS);
    expect(ltBranch?.meta?.lt).toBeLessThanOrEqual(after - LEASE_STALENESS_MS);
    // Unleased (absent/null) items stay eligible.
    expect(nullBranch?.meta?.path).toEqual(['processingStartedAt']);

    // Model the predicate the DB evaluates on `processingStartedAt`.
    const cutoff = ltBranch?.meta?.lt as number;
    const eligibleByLease = (leasedAt: number | null | undefined) =>
      leasedAt == null || leasedAt < cutoff;

    expect(eligibleByLease(undefined)).toBe(true); // never claimed
    expect(eligibleByLease(null)).toBe(true); // lease cleared on completion
    expect(eligibleByLease(Date.now())).toBe(false); // claimed just now -> in-flight -> skip
    expect(eligibleByLease(Date.now() - LEASE_STALENESS_MS - 1000)).toBe(true); // stale -> re-eligible
  });
});

describe('processVaultItem — lease claim/clear', () => {
  it('stamps a fresh processingStartedAt lease on the pre-attempt (claim) write', async () => {
    const before = Date.now();
    await processVaultItem(makeItem({ meta: { failures: 0 } }), ctx);
    const after = Date.now();

    const claimWrite = mockDbWrite.vaultItem.update.mock.calls[0][0];
    expect(typeof claimWrite.data.meta.processingStartedAt).toBe('number');
    expect(claimWrite.data.meta.processingStartedAt).toBeGreaterThanOrEqual(before);
    expect(claimWrite.data.meta.processingStartedAt).toBeLessThanOrEqual(after);
  });

  it('clears the lease on a successful (Stored) run', async () => {
    await processVaultItem(makeItem({ meta: { failures: 0 } }), ctx);
    const storedWrite = mockDbWrite.vaultItem.update.mock.calls.at(-1)?.[0];
    expect(storedWrite.data.status).toBe('Stored');
    expect(storedWrite.data.meta.processingStartedAt).toBeNull();
  });

  it('clears the lease on a caught failure so it retries next cycle', async () => {
    mockGetModelVersionData.mockRejectedValueOnce(new Error('boom'));
    await processVaultItem(makeItem({ meta: { failures: 0 } }), ctx);
    const failWrite = mockDbWrite.vaultItem.update.mock.calls.at(-1)?.[0];
    expect(failWrite.data.status).toBe('Failed');
    expect(failWrite.data.meta.processingStartedAt).toBeNull();
  });
});
