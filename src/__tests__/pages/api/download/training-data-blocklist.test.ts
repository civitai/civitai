import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for the abuse IP blocklist on `/api/download/[...key]`.
 *
 * The blocklist is an enforcement control, so the address it compares against
 * has to be one the caller cannot select. These tests pin that in BOTH
 * directions — a caller-supplied address neither evades a block nor induces
 * one — which is what distinguishes "the supplied value is ignored" from "the
 * supplied value is merely one of several considered".
 */

const { mockFindUnique, mockGetDownloadUrl, mockGetServerAuthSession } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockGetDownloadUrl: vi.fn(),
  mockGetServerAuthSession: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { keyValue: { findUnique: mockFindUnique } },
  dbWrite: { keyValue: { findUnique: mockFindUnique } },
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/utils/delivery-worker', () => ({
  getDownloadUrl: mockGetDownloadUrl,
  DeliveryWorkerError: class DeliveryWorkerError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
  safeError: (e: Error) => ({ message: e.message }),
}));

import handler from '~/pages/api/download/[...key]';

const BLOCKED = '203.0.113.7';
const NOT_BLOCKED = '198.51.100.9';
const CF_RAY = '8a1b2c3d4e5f6789-IAD';

function run(headers: Record<string, string>, remoteAddress?: string) {
  const req = {
    method: 'GET',
    query: { key: ['some', 'file.zip'] },
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

describe('/api/download/[...key] — IP blocklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No session: the only 403 this handler can produce is the blocklist, so a
    // 403 here is unambiguous evidence of THAT check and not another one.
    mockGetServerAuthSession.mockResolvedValue(null);
    mockGetDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/file.zip' });
  });

  it('blocks a request whose edge-attested address is on the list', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('blocks a request whose transport-peer address is on the list', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({}, BLOCKED);
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('SECURITY: a caller-supplied address does not evade a block on the real one', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': NOT_BLOCKED,
      'x-forwarded-for': NOT_BLOCKED,
      'x-real-ip': NOT_BLOCKED,
      'true-client-ip': NOT_BLOCKED,
    });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('SECURITY: a caller-supplied address does not induce a block on someone else', async () => {
    blocklist(NOT_BLOCKED);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': NOT_BLOCKED,
      'x-forwarded-for': NOT_BLOCKED,
    });
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    // Positive control on what the request DID do — unauthenticated, so it is
    // sent to login. Proves the handler ran past the blocklist rather than
    // failing somewhere unobserved.
    expect(res.redirect).toHaveBeenCalledWith('/login?returnUrl=/api/download/some/file.zip');
  });

  it('SECURITY: rotating the supplied address never changes the verdict', async () => {
    blocklist(BLOCKED);
    for (const n of [1, 2, 3, 200]) {
      vi.clearAllMocks();
      blocklist(BLOCKED);
      mockGetServerAuthSession.mockResolvedValue(null);
      const { promise, res } = run({
        'cf-ray': CF_RAY,
        'cf-connecting-ip': BLOCKED,
        'x-client-ip': `198.51.100.${n}`,
      });
      await promise;
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it('an empty blocklist blocks nobody', async () => {
    mockFindUnique.mockResolvedValue(null);
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});
