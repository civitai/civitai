import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for the abuse IP blocklist on
 * `/api/download/vault/[vaultItemId]`. This endpoint is authenticated, so the
 * blocklist is the layer that stops an already-identified abuser regardless of
 * which account they present — which is exactly why the address it compares
 * has to be one they cannot select.
 */

const {
  mockFindUnique,
  mockGetVaultWithStorage,
  mockHasEntityAccess,
  mockVaultItemFindUnique,
  mockModelVersionFindUnique,
  mockResolveDownloadUrl,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockGetVaultWithStorage: vi.fn(),
  mockHasEntityAccess: vi.fn(),
  mockVaultItemFindUnique: vi.fn(),
  mockModelVersionFindUnique: vi.fn(),
  mockResolveDownloadUrl: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    keyValue: { findUnique: mockFindUnique },
    vaultItem: { findUnique: mockVaultItemFindUnique },
    modelVersion: { findUnique: mockModelVersionFindUnique },
  },
  dbWrite: { keyValue: { findUnique: mockFindUnique } },
}));

vi.mock('~/server/services/vault.service', () => ({
  getVaultWithStorage: mockGetVaultWithStorage,
}));

vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: mockHasEntityAccess }));

vi.mock('~/utils/delivery-worker', () => ({ resolveDownloadUrl: mockResolveDownloadUrl }));

vi.mock('~/utils/s3-utils', () => ({ getGetUrlByKey: vi.fn() }));

vi.mock('~/env/server', () => ({ env: { S3_VAULT_BUCKET: 'vault-bucket' } }));

const TEST_USER = { id: 4242, isModerator: false };

vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: typeof TEST_USER) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, TEST_USER),
}));

import handler from '~/pages/api/download/vault/[vaultItemId]';

const BLOCKED = '203.0.113.7';
const VICTIM = '198.51.100.9';
const CF_RAY = '8a1b2c3d4e5f6789-IAD';

function run(headers: Record<string, string>, remoteAddress?: string) {
  const req = {
    method: 'GET',
    query: { vaultItemId: '31', type: 'model' },
    headers,
    socket: remoteAddress ? { remoteAddress } : undefined,
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

function blocklist(...ips: string[]) {
  mockFindUnique.mockResolvedValue({ value: ips.join(',') });
}

describe('/api/download/vault/[vaultItemId] — IP blocklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // No ModelVersion row ⇒ the access/usage-control branches are skipped (the
    // documented "deleted from the site but still in vault" path), so the only
    // 403 reachable in these tests is the IP blocklist.
    mockModelVersionFindUnique.mockResolvedValue(null);
    mockHasEntityAccess.mockResolvedValue([{ hasAccess: true, permissions: 0xffff }]);
    mockResolveDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/model.safetensors' });
  });

  it('blocks a request whose edge-attested address is on the list', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetVaultWithStorage).not.toHaveBeenCalled();
  });

  it('SECURITY: a caller-supplied address does not evade a block on the real one', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': VICTIM,
      'x-forwarded-for': VICTIM,
      'x-real-ip': VICTIM,
    });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetVaultWithStorage).not.toHaveBeenCalled();
  });

  it('SECURITY: a caller-supplied address does not induce a block on someone else', async () => {
    blocklist(VICTIM);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': VICTIM,
    });
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });
});
