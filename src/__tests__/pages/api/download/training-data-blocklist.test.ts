import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for the abuse IP blocklist on `/api/download/[...key]`.
 *
 * The blocklist is an enforcement control, so the address it compares against
 * has to be one the caller cannot select. These tests pin the stronger of the
 * two available contracts: the verdict is a function of the DERIVED address
 * alone. Varying a supplied address must leave the verdict unchanged whatever
 * the list contains, which is what distinguishes "the supplied value is
 * ignored" from "the supplied value is merely one of several considered".
 */

const { mockGetDownloadUrl, mockGetServerAuthSession } = vi.hoisted(() => ({
  mockGetDownloadUrl: vi.fn(),
  mockGetServerAuthSession: vi.fn(),
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
import { dbMock } from '~/__tests__/mocks/db.mock';
// The handler reads the blocklist from the REPLICA only (`dbRead.keyValue.findUnique` in
// the route). The old fixture aliased dbRead and dbWrite to one spy, so a read routed to
// the primary would have satisfied it silently; binding dbRead alone makes that
// distinguishable.
const mockFindUnique = dbMock.dbRead.keyValue.findUnique;

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

  it('REGRESSION: blocks when the list is written WITH spaces after the commas', async () => {
    // Entries are compared with exact string equality, so the address must
    // match an entry TRIMMED. `'9.9.9.9, 203.0.113.7'.split(',')` yields a
    // second entry of `' 203.0.113.7'`, which cannot equal any address the
    // derivation returns — so the listed address here is deliberately the
    // SECOND one, which is the only position that can observe the difference.
    mockFindUnique.mockResolvedValue({ value: `9.9.9.9, ${BLOCKED}` });
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(
      res.status,
      'a spaced ip-blacklist did not match its second entry, so this route is splitting the row without trimming it'
    ).toHaveBeenCalledWith(403);
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('SECURITY: the blocklist is compared against the derived address, not a supplied one', async () => {
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

  it('SECURITY: a supplied address is not consulted when deciding the block', async () => {
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

  it('SECURITY: the verdict is a function of the derived address alone', async () => {
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

  /**
   * 🔴 THE DISCRIMINATING INPUT — `cf-connecting-ip` with NO `cf-ray`.
   *
   * Every other fixture in this suite pairs those two headers, and that pairing
   * is the one input on which the trusted predicate and the looser
   * `resolveClientIp` AGREE. So none of them can tell which derivation the route
   * took. Measured: a mutant that keeps the `getTrustedClientIp` import AND a
   * call to it, but makes the blocklist decision from `resolveClientIp`,
   * survived this entire suite — and the ledger's binding check could not see it
   * either, because the weak call was ADDED rather than substituted.
   *
   * Unpaired, the two derivations disagree: `getTrustedClientIp` rejects the
   * unattested header and falls through to the transport peer, while a
   * derivation that trusts `cf-connecting-ip` on its own returns whatever the
   * caller wrote. Which is the concrete cost — an abuser on the blocklist
   * escapes it by sending a `cf-connecting-ip` of their choosing on a request
   * that does not transit the edge.
   *
   * Both directions are pinned, because each fails differently: a block that can
   * be evaded, and a block an innocent caller can be pushed into.
   */
  it('SECURITY: cf-connecting-ip WITHOUT cf-ray is not trusted — a listed caller cannot spoof past the block', async () => {
    // The peer is the listed address; the caller declares an unlisted one.
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-connecting-ip': NOT_BLOCKED }, BLOCKED);
    await promise;
    expect(
      res.status,
      'the unattested cf-connecting-ip was trusted, so the transport peer — which IS on the ' +
        'blocklist — was never compared. This is the predicate swap.'
    ).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });

  it('SECURITY: an unattested cf-connecting-ip cannot get an innocent caller blocked either', async () => {
    // The mirror direction: the declared address is listed, the real peer is
    // not. A derivation that trusted the header would 403 a caller who is not
    // on the list.
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-connecting-ip': BLOCKED }, NOT_BLOCKED);
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    // Positive control on what the request DID do — unauthenticated, so it is
    // sent to login. Proves the handler ran past the blocklist rather than
    // failing somewhere unobserved.
    expect(res.redirect).toHaveBeenCalledWith('/login?returnUrl=/api/download/some/file.zip');
  });

  it('an empty blocklist blocks nobody', async () => {
    mockFindUnique.mockResolvedValue(null);
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});
