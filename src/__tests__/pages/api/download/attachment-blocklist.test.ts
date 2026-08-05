import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for the abuse IP blocklist on
 * `/api/download/attachments/[fileId]`. Same contract as the sibling download
 * endpoints: the address compared against the list is derived from the edge
 * attestation or the transport peer, so the verdict is a function of that
 * derived address alone.
 */

const { mockFindUnique, mockGetServerAuthSession, mockGetFileWithPermission, mockGetDownloadUrl } =
  vi.hoisted(() => ({
    mockFindUnique: vi.fn(),
    mockGetServerAuthSession: vi.fn(),
    mockGetFileWithPermission: vi.fn(),
    mockGetDownloadUrl: vi.fn(),
  }));

vi.mock('~/server/db/client', () => ({
  dbRead: { keyValue: { findUnique: mockFindUnique } },
  dbWrite: { keyValue: { findUnique: mockFindUnique } },
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/server/services/file.service', () => ({
  getFileWithPermission: mockGetFileWithPermission,
}));

vi.mock('~/utils/delivery-worker', () => ({ getDownloadUrl: mockGetDownloadUrl }));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    file = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('~/env/server', () => ({ env: { UNAUTHENTICATED_DOWNLOAD: true } }));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/pages/api/download/attachments/[fileId]';

const BLOCKED = '203.0.113.7';
// The address a caller puts in the forwarding headers. Asserted inert.
const SUPPLIED = '198.51.100.9';
const CF_RAY = '8a1b2c3d4e5f6789-IAD';

function run(headers: Record<string, string>, remoteAddress?: string) {
  const req = {
    method: 'GET',
    query: { fileId: '77' },
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

describe('/api/download/attachments/[fileId] — IP blocklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No session ⇒ the user-blacklist branch is skipped, so the only 403 this
    // handler can emit is the IP blocklist.
    mockGetServerAuthSession.mockResolvedValue(null);
    mockGetFileWithPermission.mockResolvedValue({
      id: 77,
      url: 'files/attachment.pdf',
      name: 'attachment.pdf',
      entityId: 5,
      entityType: 'Article',
    });
    mockGetDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/attachment.pdf' });
  });

  it('blocks a request whose edge-attested address is on the list', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetFileWithPermission).not.toHaveBeenCalled();
  });

  it('blocks a request whose transport-peer address is on the list', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({}, BLOCKED);
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
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
    expect(mockGetFileWithPermission).not.toHaveBeenCalled();
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
    // Positive control on the completed path.
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/attachment.pdf');
  });
});
