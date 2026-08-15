import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockLogToAxiom = loggingMock.logToAxiom;
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SECOND route through the shared `handleEndpointError` (civitai#3845).
 *
 * `handleEndpointError` is the 500 chokepoint for 14 REST routes (10 on the
 * public `/api/v1` surface). The apps suite alone would pin only that one
 * route's behaviour, so this suite drives the same non-disclosure assertion
 * through an unrelated consumer — `GET /api/v1/collections/{id}` — which makes
 * the guard a claim about the HELPER's contract rather than about
 * `/api/v1/apps/{slug}`. Both of the helper's 500-producing branches are driven
 * here, since a driver failure in `getCollectionById` normally arrives as a
 * `throwDbError`-built TRPCError, not as a bare `Error`.
 *
 * As in the apps envelope suite, the REAL `handleEndpointError` is kept and only
 * the `MixedAuthEndpoint` wrapper is stubbed.
 */

const { mockGetPermissions, mockGetCollectionById, mockRateLimit } = vi.hoisted(() => ({
  mockGetPermissions: vi.fn(),
  mockGetCollectionById: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MixedAuthEndpoint: (handler: unknown) => handler,
}));
// Spread the ORIGINAL (7 exports) rather than replacing it with a 3-key object —
// same reason as the `endpoint-helpers` mock above.
vi.mock('~/server/services/collection.service', () => ({
  getUserCollectionPermissionsById: mockGetPermissions,
  getCollectionById: mockGetCollectionById,
}));
vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: mockRateLimit,
}));

import { TRPCError } from '@trpc/server';
import collectionHandler from '~/pages/api/v1/collections/[id]';
import { GENERIC_SERVER_ERROR_MESSAGE as GENERIC_MESSAGE } from '~/server/utils/rest-error-envelope';

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
    expect(body.code, 'the 500 envelope must carry the `code` discriminator').toBe(
      'INTERNAL_SERVER_ERROR'
    );
    expect(body.message, '`message` must be the generic server-fault text').toBe(GENERIC_MESSAGE);
    // BY VALUE, not by type: the shipped CLI renders `error` in preference to
    // `message`, so a blanked `error` would keep `typeof === 'string'` and empty
    // every CLI-visible error string.
    expect(body.error, '`error` must carry the generic text too — the CLI prefers it').toBe(
      GENERIC_MESSAGE
    );
  });

  // The route's OTHER 500 path: `getCollectionById` funnels driver failures
  // through `throwDbError`, so they arrive as a TRPCError and take the helper's
  // other branch. Same disclosure, different branch — this is a second consumer
  // proving that fix is a property of the HELPER, not of `/api/v1/apps`.
  it('a TRPCError-wrapped driver throw is generic here too', async () => {
    mockGetCollectionById.mockRejectedValueOnce(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: driverError().message,
        cause: driverError(),
      })
    );
    const { req, res } = createMocks();

    await (collectionHandler as unknown as Handler)(req, res, undefined);

    expect(res._status()).toBe(500);
    const serialized = JSON.stringify(res._json());
    for (const secret of MUST_NOT_DISCLOSE) {
      expect(
        serialized,
        `#3845 (TRPCError branch): the public 500 body must not disclose ${JSON.stringify(
          secret
        )} — full body was ${serialized}`
      ).not.toContain(secret);
    }
    expect((res._json() as Record<string, unknown>).error, '`error` must be genericized').toBe(
      GENERIC_MESSAGE
    );
  });
});
