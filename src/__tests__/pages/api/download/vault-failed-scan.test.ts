import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

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

  const scanOf = (scan: { pickleScanResult: string; virusScanResult: string }) =>
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

  it('serves a file whose scan only errored', async () => {
    scanOf({ pickleScanResult: 'Error', virusScanResult: 'Success' });
    const { promise, res } = run();
    await promise;
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });
});
