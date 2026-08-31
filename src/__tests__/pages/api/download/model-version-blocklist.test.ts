import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for `/api/download/models/[modelVersionId]`, which uses
 * the client IP for TWO controls:
 *
 *   1. the abuse IP blocklist (hard 403), and
 *   2. the anonymous download-quota bucket (`userKey`) — the value an anonymous
 *      caller's 24h download count is accumulated under.
 *
 * The contract for both is the same: the address is derived from the edge
 * attestation or the transport peer, never from a value the caller supplied.
 * For (2) that contract is stated as a stability property — the bucket is a
 * function of the derived address alone, so it does not move when the request's
 * forwarding headers vary, in either direction.
 */

const {
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockHasExceededLimit,
  mockIncrement,
  mockModelVersionEvent,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockHasExceededLimit: vi.fn(),
  mockIncrement: vi.fn(),
  mockModelVersionEvent: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: mockGetFileForModelVersion,
}));

vi.mock('~/server/services/user.service', () => ({
  bustUserDownloadsCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    modelVersionEvent = mockModelVersionEvent;
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/redis/client', () => {
  // Recursive key proxy so module-eval-time dereferences like
  // REDIS_SYS_KEYS.DOWNLOAD.COUNT resolve without a real redis client. The
  // return type is genuinely recursive-any; same shape as the sibling
  // adjust-tag-level test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  return { REDIS_SYS_KEYS: make(), REDIS_KEYS: make(), redis: {}, sysRedis: {} };
});

// Capture the exact userKey the quota is charged against.
vi.mock('~/server/utils/rate-limiting', () => ({
  createLimiter: () => ({
    hasExceededLimit: mockHasExceededLimit,
    increment: mockIncrement,
    getCount: vi.fn(),
  }),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/pages/api/download/models/[modelVersionId]';
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
    query: { modelVersionId: '123' },
    headers: { 'user-agent': 'test', ...headers },
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

/** The userKey the download quota was charged against on the last request. */
function chargedKey(): string {
  const calls = mockHasExceededLimit.mock.calls;
  return calls[calls.length - 1][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerAuthSession.mockResolvedValue(null);
  mockHasExceededLimit.mockResolvedValue(false);
  mockIncrement.mockResolvedValue(undefined);
  mockModelVersionEvent.mockResolvedValue(undefined);
  mockGetFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: 'https://example.invalid/model.safetensors',
    metadata: {},
    isDownloadable: true,
    published: true,
    modelId: 1,
    modelVersionId: 123,
    fileId: 9,
    nsfw: false,
    inEarlyAccess: false,
  });
});

describe('/api/download/models/[modelVersionId] — IP blocklist', () => {
  it('blocks a request whose edge-attested address is on the list', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
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
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
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
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
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
    // Positive control: the request completed as a real download.
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });

  /**
   * 🔴 THE DISCRIMINATING INPUT — `cf-connecting-ip` with NO `cf-ray`.
   *
   * Every other fixture in this suite pairs those two headers, and that pairing
   * is the one input on which the trusted predicate and the looser
   * `resolveClientIp` AGREE, so none of them can tell which derivation the route
   * took. A predicate swap on this route WAS caught before this pair existed —
   * but only by the QUOTA seam suite next door, which is a different assertion
   * about a different decision. The blocklist verdict is pinned here, by this
   * route's own suite, so it does not depend on a neighbouring surface
   * happening to observe the same variable.
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
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
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

describe('/api/download/models/[modelVersionId] — anonymous download quota bucket', () => {
  it('charges the quota to the edge-attested address for an anonymous caller', async () => {
    mockFindUnique.mockResolvedValue(null);
    const { promise } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(chargedKey()).toBe(BLOCKED);
  });

  it('SECURITY: the quota bucket is a function of the derived address alone', async () => {
    mockFindUnique.mockResolvedValue(null);
    const keys: string[] = [];
    for (const n of [1, 2, 3, 200]) {
      const { promise } = run({
        'cf-ray': CF_RAY,
        'cf-connecting-ip': BLOCKED,
        'x-client-ip': `198.51.100.${n}`,
        'x-forwarded-for': `198.51.100.${n}`,
      });
      await promise;
      keys.push(chargedKey());
    }
    // Positive control: the harness DID observe four charges, so the single
    // distinct value below is a real measurement and not an empty set.
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(BLOCKED);
  });

  it('SECURITY: the quota is charged to the derived address, not a supplied one', async () => {
    mockFindUnique.mockResolvedValue(null);
    const { promise } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': SUPPLIED,
      'x-forwarded-for': SUPPLIED,
      'true-client-ip': SUPPLIED,
    });
    await promise;
    expect(chargedKey()).toBe(BLOCKED);
    expect(chargedKey()).not.toBe(SUPPLIED);
    expect(mockIncrement).toHaveBeenCalledWith(BLOCKED);
  });

  it('an authenticated caller is still charged to the user id, not any address', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 4242 } });
    const { promise } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': SUPPLIED,
    });
    await promise;
    expect(chargedKey()).toBe('4242');
  });
});

/**
 * The user blocklist on this route — the second consumer of the shared
 * key-value list splitter.
 *
 * It gets its own coverage rather than leaning on the identical suite for
 * `/attachments/[fileId]`: the two are separate call sites, and a shared helper
 * is only as adopted as its least-tested call site. Coverage of one site says
 * nothing about the other.
 */
describe('/api/download/models/[modelVersionId] — user blocklist', () => {
  const LISTED_USER = 4242;

  /** Key-aware KeyValue mock — the two rows must answer differently here. */
  function rows(values: Record<string, unknown>) {
    mockFindUnique.mockImplementation(async (args: { where: { key: string } }) =>
      args.where.key in values ? { value: values[args.where.key] } : null
    );
  }

  it('CONTROL: an unlisted user is not blocked', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 777 } });
    rows({ 'user-blacklist': `123, ${LISTED_USER}` });
    const { promise, res } = run({}, SUPPLIED);
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('blocks a listed user when the list is written without spaces', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: LISTED_USER } });
    rows({ 'user-blacklist': `123,${LISTED_USER}` });
    const { promise, res } = run({}, SUPPLIED);
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('REGRESSION: blocks a listed user when the list is written WITH spaces', async () => {
    // `'123, 4242'.split(',')` → `['123', ' 4242']`, and a leading space means
    // the entry cannot equal `session.user.id.toString()`.
    mockGetServerAuthSession.mockResolvedValue({ user: { id: LISTED_USER } });
    rows({ 'user-blacklist': `123, ${LISTED_USER}` });
    const { promise, res } = run({}, SUPPLIED);
    await promise;
    expect(
      res.status,
      'the second and subsequent entries of a spaced user-blacklist never matched'
    ).toHaveBeenCalledWith(403);
  });
});
