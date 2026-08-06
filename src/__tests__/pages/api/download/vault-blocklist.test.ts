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
// The address a caller puts in the forwarding headers. Asserted inert.
const SUPPLIED = '198.51.100.9';
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

  it('REGRESSION: blocks when the list is written WITH spaces after the commas', async () => {
    // Entries are compared with exact string equality, so the address must
    // match an entry TRIMMED. The listed address is deliberately the SECOND
    // one: `'9.9.9.9, 203.0.113.7'.split(',')` gives `' 203.0.113.7'`, and only
    // an entry after the first can observe whether the split trims.
    mockFindUnique.mockResolvedValue({ value: `9.9.9.9, ${BLOCKED}` });
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(
      res.status,
      'a spaced ip-blacklist did not match its second entry, so this route is splitting the row without trimming it'
    ).toHaveBeenCalledWith(403);
    expect(mockGetVaultWithStorage).not.toHaveBeenCalled();
  });

  it('SECURITY: the blocklist is compared against the derived address, not a supplied one', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': SUPPLIED,
      'x-forwarded-for': SUPPLIED,
      'x-real-ip': SUPPLIED,
    });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetVaultWithStorage).not.toHaveBeenCalled();
  });

  it('SECURITY: a supplied address is not consulted when deciding the block', async () => {
    blocklist(SUPPLIED);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': SUPPLIED,
    });
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });

  /**
   * 🔴 THE DISCRIMINATING INPUT — `cf-connecting-ip` with NO `cf-ray`.
   *
   * Every other fixture in the four download suites pairs those two headers,
   * and that pairing is the one input on which the trusted predicate and the
   * looser `resolveClientIp` AGREE. So none of them can tell which derivation
   * the route took: swapping this endpoint to `resolveClientIp` passed all of
   * them. Unpaired, they disagree — `getTrustedClientIp` rejects the
   * unattested header and falls through to the transport peer, while a
   * derivation that trusts `cf-connecting-ip` on its own returns whatever the
   * caller wrote.
   *
   * Which means an abuser on the blocklist escapes it simply by sending a
   * `cf-connecting-ip` of their choosing on a request that does not transit
   * the edge. That is the concrete cost, and this is the test that sees it.
   */
  it('SECURITY: cf-connecting-ip WITHOUT cf-ray is not trusted — a listed caller cannot spoof past the block', async () => {
    // The peer is the listed address; the caller declares an unlisted one.
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-connecting-ip': SUPPLIED }, BLOCKED);
    await promise;
    expect(
      res.status,
      'the unattested cf-connecting-ip was trusted, so the transport peer — which IS on the ' +
        'blocklist — was never compared. This is the predicate swap.'
    ).toHaveBeenCalledWith(403);
    expect(mockGetVaultWithStorage).not.toHaveBeenCalled();
  });

  it('SECURITY: an unattested cf-connecting-ip cannot get an innocent caller blocked either', async () => {
    // The mirror direction: the declared address is listed, the real peer is
    // not. A derivation that trusted the header would 403 a caller who is not
    // on the list.
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-connecting-ip': BLOCKED }, SUPPLIED);
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });
});
