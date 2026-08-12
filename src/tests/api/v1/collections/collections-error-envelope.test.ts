import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SECOND route through the shared `handleEndpointError` (civitai#3845).
 *
 * `handleEndpointError` is the 500 chokepoint for 14 REST routes. The apps
 * suite alone would pin only that one route's behaviour, so this suite drives
 * the same non-disclosure assertion through an unrelated consumer —
 * `GET /api/v1/collections/{id}` — which makes the guard a claim about the
 * HELPER's contract rather than about `/api/v1/apps/{slug}`.
 *
 * As in the apps envelope suite, the REAL `handleEndpointError` is kept and only
 * the `MixedAuthEndpoint` wrapper is stubbed.
 */

const { mockGetPermissions, mockGetCollectionById, mockRateLimit, mockLogToAxiom } = vi.hoisted(
  () => ({
    mockGetPermissions: vi.fn(),
    mockGetCollectionById: vi.fn(),
    mockRateLimit: vi.fn(),
    mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  })
);

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MixedAuthEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  buildCentralErrorLog: vi.fn((e: unknown) => ({
    name: (e as Error)?.name,
    message: (e as Error)?.message,
  })),
  wasServerFaultLogged: vi.fn(() => false),
}));
vi.mock('~/server/services/collection.service', () => ({
  getUserCollectionPermissionsById: mockGetPermissions,
  getCollectionById: mockGetCollectionById,
}));
vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: mockRateLimit,
}));

import collectionHandler from '~/pages/api/v1/collections/[id]';

type Handler = (req: unknown, res: unknown, user: unknown) => Promise<unknown>;

const LEAKED_TABLE = 'CollectionItem';
const LEAKED_COLUMN = 'collection_owner_id';
const MUST_NOT_DISCLOSE = [
  LEAKED_TABLE,
  LEAKED_COLUMN,
  'collectionItem',
  'findMany',
  'prisma.',
  'invocation',
  'does not exist in the current database',
];

function driverError() {
  return new Error(
    '\nInvalid `prisma.collectionItem.findMany()` invocation:\n\n\n' +
      `The column \`${LEAKED_TABLE}.${LEAKED_COLUMN}\` does not exist in the current database.`
  );
}

function createMocks(query: Record<string, string> = { id: '42' }) {
  const req = { method: 'GET', url: '/api/v1/collections/42', query, headers: {} };
  let statusCode = 200;
  let payload: unknown;
  let headersSent = false;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      headersSent = true;
      return res;
    },
    setHeader() {
      /* noop */
    },
    end() {
      headersSent = true;
      return res;
    },
    get headersSent() {
      return headersSent;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockGetPermissions.mockResolvedValue({ read: true });
});

describe('GET /api/v1/collections/{id} — shared-helper non-disclosure', () => {
  it('a driver throw does NOT disclose table/column/Prisma detail on the wire', async () => {
    mockGetCollectionById.mockRejectedValueOnce(driverError());
    const { req, res } = createMocks();

    await (collectionHandler as unknown as Handler)(req, res, undefined);

    expect(res._status()).toBe(500);
    const serialized = JSON.stringify(res._json());
    for (const secret of MUST_NOT_DISCLOSE) {
      expect(
        serialized,
        `#3845: the public 500 body must not disclose ${JSON.stringify(
          secret
        )} — full body was ${serialized}`
      ).not.toContain(secret);
    }
  });

  it('the shared 500 envelope carries the `code` discriminator here too', async () => {
    mockGetCollectionById.mockRejectedValueOnce(driverError());
    const { req, res } = createMocks();

    await (collectionHandler as unknown as Handler)(req, res, undefined);

    const body = res._json() as Record<string, unknown>;
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(typeof body.message).toBe('string');
    expect(typeof body.error).toBe('string');
  });
});
