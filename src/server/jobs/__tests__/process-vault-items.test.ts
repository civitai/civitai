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
  getEligibleVaultItemsQuery,
  MAX_FAILURES,
  VAULT_ITEMS_BATCH_SIZE,
} from '~/server/jobs/process-vault-items';

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
    const lteBranch = q.where.OR.find((b: any) => typeof b.meta?.lte === 'number');
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
    const budget = (q.where.OR.find((b: any) => typeof b.meta?.lte === 'number') as any).meta
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
