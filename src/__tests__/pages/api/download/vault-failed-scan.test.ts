import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as FailedScan from '~/server/utils/failed-scan';

/** A vault copy of a model file that failed its scan is refused like the site download. */

const { mockGetVaultWithStorage, mockHasEntityAccess, mockResolveDownloadUrl } = vi.hoisted(() => ({
  mockGetVaultWithStorage: vi.fn(),
  mockHasEntityAccess: vi.fn(),
  mockResolveDownloadUrl: vi.fn(),
}));

vi.mock('~/server/services/vault.service', () => ({
  getVaultWithStorage: mockGetVaultWithStorage,
}));

vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: mockHasEntityAccess }));

vi.mock('~/utils/delivery-worker', () => ({ resolveDownloadUrl: mockResolveDownloadUrl }));

vi.mock('~/utils/s3-utils', () => ({ getGetUrlByKey: vi.fn() }));

const mockRefuseUnjudged = vi.hoisted(() => vi.fn());
vi.mock('~/server/utils/failed-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof FailedScan>();
  return { ...actual, refuseUnjudgedVaultFile: mockRefuseUnjudged };
});
const { refuseUnjudgedVaultFile: realRefuseUnjudged } = await vi.importActual<typeof FailedScan>(
  '~/server/utils/failed-scan'
);

const TEST_USER = { id: 4242, isModerator: false };

vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: typeof TEST_USER) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, TEST_USER),
}));

import handler from '~/pages/api/download/vault/[vaultItemId]';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
const mockVaultItemFindUnique = dbMock.dbRead.vaultItem.findUnique;
const mockModelVersionFindUnique = dbMock.dbRead.modelVersion.findUnique;

function run() {
  const req = {
    method: 'GET',
    query: { vaultItemId: '31', type: 'model' },
    headers: {},
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;
  return { promise: handler(req, res), res };
}

describe('/api/download/vault/[vaultItemId] — a file that failed its scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefuseUnjudged.mockReset().mockImplementation(realRefuseUnjudged);
    TEST_USER.isModerator = false;
    setEnv({ S3_VAULT_BUCKET: 'vault-bucket' });
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
    mockGetVaultWithStorage.mockResolvedValue({
      updatedAt: new Date(),
      storageKb: 1_000_000,
      usedStorageKb: 1,
    });
    mockVaultItemFindUnique.mockResolvedValue({
      id: 31,
      modelVersionId: 9,
      modelName: 'model',
      versionName: 'v1',
      files: [{ id: 1, url: 'files/model.safetensors', displayName: 'model.safetensors' }],
    });
    mockModelVersionFindUnique.mockResolvedValue(null);
    mockHasEntityAccess.mockResolvedValue([{ hasAccess: true, permissions: 0xffff }]);
    mockResolveDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/model.safetensors' });
  });

  const scanOf = (scan: { type?: string; pickleScanResult: string; virusScanResult: string }) =>
    dbMock.dbRead.modelFile.findUnique.mockResolvedValue(scan as never);

  it('refuses it with 403 and does not resolve a url', async () => {
    scanOf({ pickleScanResult: 'Success', virusScanResult: 'Danger' });
    const { promise, res } = run();
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses a failed pickle scan with 403 too', async () => {
    scanOf({ pickleScanResult: 'Danger', virusScanResult: 'Success' });
    const { promise, res } = run();
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('serves it to a moderator', async () => {
    TEST_USER.isModerator = true;
    scanOf({ pickleScanResult: 'Success', virusScanResult: 'Danger' });
    const { promise, res } = run();
    await promise;
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });

  it.each(['Pending', 'Error'])(
    'refuses training data vaulted earlier whose scan is %s',
    async (virusScanResult) => {
      scanOf({ type: 'Training Data', pickleScanResult: 'Pending', virusScanResult });
      const { promise, res } = run();
      await promise;
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
    }
  );

  it('refuses training data vaulted earlier even once its scan completed', async () => {
    scanOf({ type: 'Training Data', pickleScanResult: 'Pending', virusScanResult: 'Success' });
    const { promise, res } = run();
    await promise;
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'training data',
      { type: 'Training Data', pickleScanResult: 'Pending', virusScanResult: 'Pending' },
      404,
    ],
    [
      'a failed scan',
      { type: 'Model', pickleScanResult: 'Success', virusScanResult: 'Danger' },
      403,
    ],
  ])('judges a deleted file by a live row holding the same bytes: %s', async (_, live, status) => {
    dbMock.dbRead.modelFile.findUnique.mockResolvedValue(null);
    // A clean sibling first: any row holding the bytes decides, not the first one returned.
    dbMock.dbRead.modelFile.findMany.mockResolvedValue([
      { type: 'Model', pickleScanResult: 'Success', virusScanResult: 'Success' },
      live,
    ] as never);
    const { promise, res } = run();
    await promise;
    expect(dbMock.dbRead.modelFile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { url: 'files/model.safetensors' } })
    );
    expect(res.status).toHaveBeenCalledWith(status);
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses training data whose row is gone, by the name it was stored under', async () => {
    mockVaultItemFindUnique.mockResolvedValue({
      id: 31,
      modelVersionId: 9,
      modelName: 'model',
      versionName: 'v1',
      files: [{ id: 1, url: 'files/data.zip', displayName: 'Training Data' }],
    });
    dbMock.dbRead.modelFile.findUnique.mockResolvedValue(null);
    dbMock.dbRead.modelFile.findMany.mockResolvedValue([]);
    const { promise, res } = run();
    await promise;
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses a file with no row and no scan snapshot', async () => {
    dbMock.dbRead.modelFile.findUnique.mockResolvedValue(null);
    dbMock.dbRead.modelFile.findMany.mockResolvedValue([]);
    const { promise, res } = run();
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  describe('a file whose own row is gone, judged by its vault snapshot', () => {
    const vaultedWith = (scan: {
      pickleScanResult?: string;
      virusScanResult?: string;
      rowDeletedAt?: string;
    }) =>
      mockVaultItemFindUnique.mockResolvedValue({
        id: 31,
        modelVersionId: 9,
        modelName: 'model',
        versionName: 'v1',
        files: [
          { id: 1, url: 'files/model.safetensors', displayName: 'model.safetensors', ...scan },
        ],
      });
    const noRows = (live: unknown[] = []) => {
      dbMock.dbRead.modelFile.findUnique.mockResolvedValue(null);
      dbMock.dbRead.modelFile.findMany.mockResolvedValue(live as never);
    };
    const DANGER = { pickleScanResult: 'Success', virusScanResult: 'Danger' };
    const CLEAN = { pickleScanResult: 'Success', virusScanResult: 'Success' };
    const DELETED = { rowDeletedAt: '2026-11-13T10:00:00Z' };

    it.each([
      ['taken when it was vaulted', DANGER],
      ['stamped when its row was deleted', { ...DANGER, ...DELETED }],
    ])('refuses a Danger snapshot %s with 403', async (_, scan) => {
      vaultedWith(scan);
      noRows();
      const { promise, res } = run();
      await promise;
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockRefuseUnjudged).not.toHaveBeenCalled();
      expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
    });

    it('refuses a Danger snapshot even when a live row with the same bytes is clean', async () => {
      vaultedWith(DANGER);
      noRows([{ type: 'Model', ...CLEAN }]);
      const { promise, res } = run();
      await promise;
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
    });

    it('serves a clean snapshot stamped at delete without consulting the unjudged-file policy', async () => {
      vaultedWith({ ...CLEAN, ...DELETED });
      noRows();
      const { promise, res } = run();
      await promise;
      expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
      expect(mockRefuseUnjudged).not.toHaveBeenCalled();
    });

    it.each([
      ['a clean one taken when it was vaulted', CLEAN],
      [
        'one stamped at delete before its scan finished',
        { pickleScanResult: 'Pending', virusScanResult: 'Success', ...DELETED },
      ],
    ])('leaves %s to the unjudged-file policy', async (_, scan) => {
      vaultedWith(scan);
      noRows();
      mockRefuseUnjudged.mockReturnValue(true);
      const { promise, res } = run();
      await promise;
      expect(mockRefuseUnjudged).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
    });

    it('serves a Danger snapshot to a moderator', async () => {
      TEST_USER.isModerator = true;
      vaultedWith(DANGER);
      noRows();
      const { promise, res } = run();
      await promise;
      expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
    });

    it('leaves a file with no row and no snapshot to the unjudged-file policy', async () => {
      noRows();
      mockRefuseUnjudged.mockReturnValueOnce(true);
      const { promise, res } = run();
      await promise;
      expect(mockRefuseUnjudged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, url: 'files/model.safetensors' })
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
    });

    it('keeps the 404 for training data with no row, whatever the unjudged-file policy', async () => {
      mockVaultItemFindUnique.mockResolvedValue({
        id: 31,
        modelVersionId: 9,
        modelName: 'model',
        versionName: 'v1',
        files: [{ id: 1, url: 'files/data.zip', displayName: 'Training Data' }],
      });
      noRows();
      mockRefuseUnjudged.mockReturnValue(true);
      const { promise, res } = run();
      await promise;
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('serves a moderator a file the unjudged-file policy would refuse', async () => {
      TEST_USER.isModerator = true;
      noRows();
      mockRefuseUnjudged.mockReturnValue(true);
      const { promise, res } = run();
      await promise;
      expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
    });
  });

  it('serves a file whose scan only errored', async () => {
    scanOf({ pickleScanResult: 'Error', virusScanResult: 'Success' });
    const { promise, res } = run();
    await promise;
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });
});
