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

/**
 * The OTHER blocklist on this route, which the IP suite above deliberately
 * steps around by running unauthenticated.
 *
 * It had the same defect the IP list was fixed for and kept it: the route
 * open-coded `(value ?? '').split(',')`, so an operator writing the list the
 * obvious way — `123, 456` — got entries of `'123'` and `' 456'`, and the
 * leading space meant every id after the first could never equal
 * `session.user.id.toString()`. The list silently covered one user. Nothing
 * reported it, because a blocklist that does not match looks exactly like a
 * caller who is not on it.
 */
describe('/api/download/attachments/[fileId] — user blocklist', () => {
  const LISTED_USER = 456;
  const UNLISTED_USER = 999;

  /** Key-aware KeyValue mock — the two rows must answer differently here. */
  function rows(values: Record<string, unknown>) {
    mockFindUnique.mockImplementation(async (args: { where: { key: string } }) =>
      args.where.key in values ? { value: values[args.where.key] } : null
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFileWithPermission.mockResolvedValue({
      id: 77,
      url: 'files/attachment.pdf',
      name: 'attachment.pdf',
      entityId: 5,
      entityType: 'Article',
    });
    mockGetDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/attachment.pdf' });
  });

  function asUser(id: number) {
    mockGetServerAuthSession.mockResolvedValue({ user: { id, isModerator: false } });
  }

  it('CONTROL: an unlisted user completes the download', async () => {
    // Positive control. Without it, a 403 asserted below could be coming from
    // anywhere in the handler and the test would be green for the wrong reason.
    asUser(UNLISTED_USER);
    rows({ 'user-blacklist': `123,${LISTED_USER}` });
    const { promise, res } = run({}, SUPPLIED);
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/attachment.pdf');
  });

  it('blocks a listed user when the list is written without spaces', async () => {
    asUser(LISTED_USER);
    rows({ 'user-blacklist': `123,${LISTED_USER}` });
    const { promise, res } = run({}, SUPPLIED);
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetFileWithPermission).not.toHaveBeenCalled();
  });

  it('REGRESSION: blocks a listed user when the list is written WITH spaces', async () => {
    // `'123, 456'.split(',')` → `['123', ' 456']`. This is the case the inline
    // split got wrong, and it is the way an operator would naturally write it.
    asUser(LISTED_USER);
    rows({ 'user-blacklist': `123, ${LISTED_USER}` });
    const { promise, res } = run({}, SUPPLIED);
    await promise;
    expect(
      res.status,
      'the second and subsequent entries of a spaced user-blacklist never matched'
    ).toHaveBeenCalledWith(403);
    expect(mockGetFileWithPermission).not.toHaveBeenCalled();
  });

  it('a malformed (non-string) user-blacklist row does not throw, and does not block', async () => {
    // `KeyValue.value` is a Json column. The inline form called `.split` on it
    // and produced a 500; the shared helper reports it and returns no entries.
    // Asserted so the direction of that change is a deliberate, visible one.
    asUser(LISTED_USER);
    rows({ 'user-blacklist': { not: 'a string' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { promise, res } = run({}, SUPPLIED);
      await promise;
      expect(res.status).not.toHaveBeenCalledWith(500);
      expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/attachment.pdf');
      // …but it must not be silent about it.
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0][0])).toContain('user-blacklist');
    } finally {
      spy.mockRestore();
    }
  });
});
