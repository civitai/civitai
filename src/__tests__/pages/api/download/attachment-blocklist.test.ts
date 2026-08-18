import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for the abuse IP blocklist on
 * `/api/download/attachments/[fileId]`. Same contract as the sibling download
 * endpoints: the address compared against the list is derived from the edge
 * attestation or the transport peer, so the verdict is a function of that
 * derived address alone.
 */

const { mockGetServerAuthSession, mockGetFileWithPermission, mockGetDownloadUrl } = vi.hoisted(
  () => ({
    mockGetServerAuthSession: vi.fn(),
    mockGetFileWithPermission: vi.fn(),
    mockGetDownloadUrl: vi.fn(),
  })
);

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
import { dbMock } from '~/__tests__/mocks/db.mock';
// The handler reads the blocklist from the REPLICA only (`dbRead.keyValue.findUnique` in
// the route). The old fixture aliased dbRead and dbWrite to one spy, so a read routed to
// the primary would have satisfied it silently; binding dbRead alone makes that
// distinguishable.
const mockFindUnique = dbMock.dbRead.keyValue.findUnique;

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
    expect(mockGetFileWithPermission).not.toHaveBeenCalled();
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
    const { promise, res } = run({ 'cf-connecting-ip': SUPPLIED }, BLOCKED);
    await promise;
    expect(
      res.status,
      'the unattested cf-connecting-ip was trusted, so the transport peer — which IS on the ' +
        'blocklist — was never compared. This is the predicate swap.'
    ).toHaveBeenCalledWith(403);
    expect(mockGetFileWithPermission).not.toHaveBeenCalled();
  });

  it('SECURITY: an unattested cf-connecting-ip cannot get an innocent caller blocked either', async () => {
    // The mirror direction: the declared address is listed, the real peer is
    // not. A derivation that trusted the header would 403 a caller who is not
    // on the list.
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-connecting-ip': BLOCKED }, SUPPLIED);
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/attachment.pdf');
  });
});

/**
 * The OTHER blocklist on this route, which the IP suite above deliberately
 * steps around by running unauthenticated.
 *
 * The invariant: entries are compared with exact string equality against
 * `session.user.id.toString()`, so every id in the row must match regardless of
 * the spacing the operator wrote it with. This needs its own coverage because a
 * blocklist that fails to match is indistinguishable, from outside, from a
 * caller who is not on it — there is no signal to notice.
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
    // `'123, 456'.split(',')` → `['123', ' 456']`, so only an entry after the
    // first can observe whether the row is trimmed as well as split.
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

  it('FAIL DIRECTION: a malformed (non-string) user-blacklist row denies rather than allowing', async () => {
    // `KeyValue.value` is a Json column, so a non-string row is representable
    // and is an operator error. The direction it falls decides whether an
    // unreadable list means "nobody is blocked" or "this request does not
    // proceed" — and the first is undetectable from outside. It throws: the
    // request fails and the download does NOT complete.
    //
    // The message it fails WITH is deliberately content-free. This route is
    // public and the throw reaches the caller's response body, so the row's
    // identity is an OPERATOR signal and goes to the server log instead. Both
    // halves are asserted: the caller learns nothing internal, the operator
    // learns which row.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      asUser(LISTED_USER);
      rows({ 'user-blacklist': { not: 'a string' } });
      const { promise, res } = run({}, SUPPLIED);
      const thrown = await promise.then(
        () => null,
        (e: Error) => e
      );
      expect(thrown, 'a malformed row must fail closed').toBeInstanceOf(TypeError);
      expect(thrown!.message, 'the client-visible message names an internal row').not.toMatch(
        /user-blacklist|ip-blacklist|KeyValue/i
      );
      expect(res.redirect).not.toHaveBeenCalled();
      expect(mockGetDownloadUrl).not.toHaveBeenCalled();
      expect(
        errorLog.mock.calls.map((c) => c.join(' ')).join('\n'),
        'the operator has no server-side signal identifying the bad row'
      ).toContain('user-blacklist');
    } finally {
      errorLog.mockRestore();
    }
  });
});
