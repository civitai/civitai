import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockLogToAxiom = loggingMock.logToAxiom;
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * civitai#3845 **investigation 4** — the ~11 hand-rolled copies of the error
 * envelope that do NOT go through `handleEndpointError`.
 *
 * PR #3850 fixed "population A" (the 14 routes that DO use the helper) and
 * enumerated population B without fixing it, because patching 11 copies would
 * keep the pattern alive to regrow. This suite covers the consolidation: every
 * one of those routes now delegates, and the property is asserted **at the route**
 * rather than only at the helper — the defect lived in the seam between them, and
 * a helper-only test is blind to a route that never calls it.
 *
 * 🔴 Why the whole SERIALIZED BODY is asserted rather than one field: the old
 * shapes leaked through four different keys — `error: err.message` (verbatim),
 * `error` (the whole error OBJECT), `error: error.cause` (the wrapped driver
 * error) and `cause: error` (the object under a second key). A per-field
 * assertion would have passed on three of them.
 *
 * The driver errors are REAL (`Prisma.PrismaClientKnownRequestError`, `pg`'s
 * `DatabaseError`) because that is the entire point: a plain `Error` has
 * non-enumerable props and serializes to `{}`, which is exactly why the
 * whole-object sites looked safe for years.
 */

const { mockWasServerFaultLogged } = vi.hoisted(() => ({
  mockWasServerFaultLogged: vi.fn(() => false),
}));

// 🔴 Spread the ORIGINAL. `handleEndpointError` is the thing under test here, so
// replacing this module wholesale with `{ PublicEndpoint: h => h }` — the pattern
// the older route suites used — would make every route below call `undefined` and
// fail for a reason that has nothing to do with the disclosure.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
  AuthedEndpoint: (handler: unknown) => handler,
}));

const {
  mockPublicApiContext2,
  mockHasEntityAccess,
  mockGetSessionUserById,
  mockGetPaginatedVaultItems,
  mockGetOrCreateVault,
  mockToggleModelVersionOnVault,
  mockPopulateNotificationDetails,
  mockTracker,
} = vi.hoisted(() => ({
  mockPublicApiContext2: vi.fn(),
  mockHasEntityAccess: vi.fn(),
  mockGetSessionUserById: vi.fn(),
  mockGetPaginatedVaultItems: vi.fn(),
  mockGetOrCreateVault: vi.fn(),
  mockToggleModelVersionOnVault: vi.fn(),
  mockPopulateNotificationDetails: vi.fn(),
  mockTracker: vi.fn(),
}));

vi.mock('~/server/createContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publicApiContext2: mockPublicApiContext2,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntityAccess: mockHasEntityAccess,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: mockGetSessionUserById },
}));
vi.mock('~/server/services/vault.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPaginatedVaultItems: mockGetPaginatedVaultItems,
  getOrCreateVault: mockGetOrCreateVault,
  toggleModelVersionOnVault: mockToggleModelVersionOnVault,
}));
vi.mock('~/server/notifications/detail-fetchers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  populateNotificationDetails: mockPopulateNotificationDetails,
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Tracker: mockTracker,
}));

import { Prisma } from '@prisma/client';
import { DatabaseError } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';

import creatorsHandler from '~/pages/api/v1/creators';
import tagsHandler from '~/pages/api/v1/tags';
import usersHandler from '~/pages/api/v1/users/index';
import contentHandler from '~/pages/api/v1/content/[[...slug]]';
import permissionsHandler from '~/pages/api/v1/permissions/check';
import vaultAllRoute from '~/pages/api/v1/vault/all';
import vaultGetRoute from '~/pages/api/v1/vault/get';
import vaultCheckRoute from '~/pages/api/v1/vault/check-vault';
import vaultToggleRoute from '~/pages/api/v1/vault/toggle-version';
import notificationDetailsRoute from '~/pages/api/notification/getDetails';
import runHandler from '~/pages/api/run/[modelVersionId]';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockVaultItemFindMany = dbMock.dbRead.vaultItem.findMany;
const mockModelVersionFindFirst = dbMock.dbRead.modelVersion.findFirst;

/**
 * `AuthedEndpoint` is mocked to an identity function above, so these modules
 * export their INNER 3-arg handler at runtime while TypeScript still sees the
 * wrapper's 2-arg signature. Cast once, here, rather than at each call site.
 */
type AuthedHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<unknown>;
const vaultAllHandler = vaultAllRoute as unknown as AuthedHandler;
const vaultGetHandler = vaultGetRoute as unknown as AuthedHandler;
const vaultCheckHandler = vaultCheckRoute as unknown as AuthedHandler;
const vaultToggleHandler = vaultToggleRoute as unknown as AuthedHandler;
const notificationDetailsHandler = notificationDetailsRoute as unknown as AuthedHandler;

// ── The payloads. Both are REAL driver errors, not stand-ins. ────────────────
const LEAKED_TABLE = 'app_collaborators';
const LEAKED_COLUMN = 'app_listing_id';
const CLIENT_VERSION = '6.13.0';
const VICTIM_EMAIL = 'victim@example.com';

/**
 * The exact error class and code from the #3845 incident. Its own props are
 * ENUMERABLE, so `JSON.stringify({ error })` yields
 * `{"code":"P2022","meta":{"column":"app_collaborators.app_listing_id"},…}`.
 */
function prismaDriverError() {
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.appCollaborator.findMany()\` invocation:\n\nThe column \`${LEAKED_TABLE}.${LEAKED_COLUMN}\` does not exist in the current database.`,
    {
      code: 'P2022',
      clientVersion: CLIENT_VERSION,
      meta: { column: `${LEAKED_TABLE}.${LEAKED_COLUMN}` },
    }
  );
}

/**
 * A real `pg` unique violation. `detail` on a 23505 quotes the offending row
 * VALUE — here a user's email address — and every field is enumerable, so a
 * whole-object envelope puts actual user data on the wire.
 */
function pgDriverError() {
  const e = new DatabaseError(
    'duplicate key value violates unique constraint "User_email_key"',
    100,
    'error'
  );
  Object.assign(e, {
    severity: 'ERROR',
    code: '23505',
    detail: `Key (email)=(${VICTIM_EMAIL}) already exists.`,
    schema: 'public',
    table: 'User',
    constraint: 'User_email_key',
  });
  return e;
}

const PRISMA_SECRETS = [
  LEAKED_TABLE,
  LEAKED_COLUMN,
  'appCollaborator',
  'findMany',
  'prisma.',
  'invocation',
  'P2022',
  CLIENT_VERSION,
];

const PG_SECRETS = [
  VICTIM_EMAIL,
  'Key (email)',
  'User_email_key',
  'duplicate key value',
  '23505',
  'User_email',
];

function createMocks({
  query = {},
  body = {},
  method = 'GET',
}: { query?: Record<string, unknown>; body?: unknown; method?: string } = {}) {
  const req = {
    method,
    url: '/api/test',
    headers: { host: 'civitai.com' },
    query,
    body,
  } as unknown as NextApiRequest;

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
      return res;
    },
    redirect() {
      headersSent = true;
      return res;
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
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

const USER = { id: 1, username: 'zach' } as unknown as SessionUser;

/**
 * Every route in population B, with the ONE dependency whose failure used to be
 * serialized into the response, and the shape it used to be serialized in.
 *
 * 🔴 This list is also a LEDGER. `rest-error-envelope-ledger.test.ts` asserts that
 * no file under `src/pages/api` hand-rolls the envelope any more, so a new copy
 * fails there; this list is what proves the ones we already know about actually
 * BEHAVE, rather than merely no longer matching a grep.
 */
const ROUTES = [
  {
    name: 'GET /api/v1/creators',
    oldShape: 'error: <whole object> (else-branch) / raw driver text (TRPCError branch)',
    run: (throwing: () => never) => {
      mockPublicApiContext2.mockResolvedValue({ user: { getCreators: throwing } });
      const { req, res } = createMocks({ query: {} });
      return { promise: creatorsHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/v1/tags',
    oldShape: 'error: <whole object>',
    run: (throwing: () => never) => {
      mockPublicApiContext2.mockResolvedValue({ tag: { getAll: throwing } });
      const { req, res } = createMocks({ query: {} });
      return { promise: tagsHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/v1/users',
    oldShape: 'error: err.message (verbatim)',
    run: (throwing: () => never) => {
      mockPublicApiContext2.mockResolvedValue({ user: { getAll: throwing } });
      const { req, res } = createMocks({ query: {} });
      return { promise: usersHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/v1/content/[[...slug]]',
    oldShape: 'error: error.cause (the WRAPPED driver error)',
    run: (throwing: () => never) => {
      mockPublicApiContext2.mockResolvedValue({ content: { get: throwing } });
      const { req, res } = createMocks({ query: { slug: ['tos'] } });
      return { promise: contentHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/v1/permissions/check',
    oldShape: 'error: <whole object>',
    run: (throwing: () => never) => {
      mockGetSessionUserById.mockResolvedValue(null);
      mockHasEntityAccess.mockImplementation(throwing);
      const { req, res } = createMocks({ query: { entityIds: '1,2' } });
      return { promise: permissionsHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/v1/vault/all',
    oldShape: 'error: <whole object>',
    run: (throwing: () => never) => {
      mockGetPaginatedVaultItems.mockImplementation(throwing);
      const { req, res } = createMocks({ query: {} });
      return { promise: vaultAllHandler(req, res, USER), res };
    },
  },
  {
    name: 'GET /api/v1/vault/get',
    oldShape: 'error: <whole object>',
    run: (throwing: () => never) => {
      mockGetOrCreateVault.mockImplementation(throwing);
      const { req, res } = createMocks({ query: {} });
      return { promise: vaultGetHandler(req, res, USER), res };
    },
  },
  {
    name: 'GET /api/v1/vault/check-vault',
    oldShape: 'error: <whole object>',
    run: (throwing: () => never) => {
      mockVaultItemFindMany.mockImplementation(throwing);
      const { req, res } = createMocks({ query: { modelVersionIds: '1,2' } });
      return { promise: vaultCheckHandler(req, res, USER), res };
    },
  },
  {
    name: 'POST /api/v1/vault/toggle-version',
    oldShape: 'error: <whole object>',
    run: (throwing: () => never) => {
      mockToggleModelVersionOnVault.mockImplementation(throwing);
      const { req, res } = createMocks({ query: { modelVersionId: '1' }, method: 'POST' });
      return { promise: vaultToggleHandler(req, res, USER), res };
    },
  },
  {
    name: 'POST /api/notification/getDetails',
    oldShape: 'error: <whole object>',
    run: (throwing: () => never) => {
      mockPopulateNotificationDetails.mockImplementation(throwing);
      const { req, res } = createMocks({
        method: 'POST',
        body: { id: 1, type: 'comment', details: {}, category: null },
      });
      return { promise: notificationDetailsHandler(req, res, USER), res };
    },
  },
  {
    name: 'GET /api/run/[modelVersionId]',
    oldShape: 'cause: <whole object> (under a SECOND key, next to a generic `error`)',
    run: (throwing: () => never) => {
      mockModelVersionFindFirst.mockResolvedValue({
        id: 1,
        model: { id: 1, name: 'm', type: 'Checkpoint', nsfw: false },
        name: 'v1',
        trainedWords: [],
        runStrategies: [{ url: 'https://partner.example/run', partner: { id: 1, name: 'p' } }],
      });
      // 🔴 Must be a `function`, not an arrow, and must throw from `partnerEvent`
      // rather than from the constructor. An arrow `mockImplementation` makes
      // `new Tracker(...)` raise `TypeError: … is not a constructor` — a DIFFERENT
      // error that also genericizes, so the three disclosure assertions below went
      // green without ever carrying the driver payload. The log-attribution
      // assertion is what exposed that.
      mockTracker.mockImplementation(function (this: unknown) {
        return { partnerEvent: throwing };
      });
      const { req, res } = createMocks({ query: { modelVersionId: '1' } });
      return { promise: runHandler(req, res), res };
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockWasServerFaultLogged.mockReturnValue(false);
});

describe('civitai#3845/4 — no REST route hand-rolls a driver-leaking error envelope', () => {
  describe.each(ROUTES)('$name (was: $oldShape)', ({ run }) => {
    it('does NOT disclose Prisma driver, table or column detail', async () => {
      const throwing = (() => {
        throw prismaDriverError();
      }) as () => never;
      const { promise, res } = run(throwing);
      await promise;

      const serialized = JSON.stringify(res._json());
      for (const secret of PRISMA_SECRETS) {
        expect(
          serialized,
          `must not disclose ${JSON.stringify(secret)} — full body was ${serialized}`
        ).not.toContain(secret);
      }
    });

    it('does NOT disclose a pg unique-violation detail (an actual user row value)', async () => {
      const throwing = (() => {
        throw pgDriverError();
      }) as () => never;
      const { promise, res } = run(throwing);
      await promise;

      const serialized = JSON.stringify(res._json());
      for (const secret of PG_SECRETS) {
        expect(
          serialized,
          `must not disclose ${JSON.stringify(secret)} — full body was ${serialized}`
        ).not.toContain(secret);
      }
    });

    it('still answers 5xx with the shared envelope (code + string message + error)', async () => {
      const throwing = (() => {
        throw prismaDriverError();
      }) as () => never;
      const { promise, res } = run(throwing);
      await promise;

      expect(res._status()).toBeGreaterThanOrEqual(400);
      const body = res._json() as Record<string, unknown>;
      expect(body.code, 'the envelope discriminator must be present').toBeTypeOf('string');
      // The Go CLI decodes `message` into a `Message string`; a non-string fails
      // the whole envelope unmarshal.
      expect(typeof body.message).toBe('string');
      // …and it renders `error` in PREFERENCE to `message`, so an empty `error`
      // empties every CLI-rendered error string.
      expect(body.error).toBeTruthy();
    });

    it('attributes the fault in the log — genericizing relocates the text, never destroys it', async () => {
      const throwing = (() => {
        throw prismaDriverError();
      }) as () => never;
      const { promise } = run(throwing);
      await promise;

      expect(mockLogToAxiom, 'the un-redacted text must reach `_axiom`').toHaveBeenCalledTimes(1);
      const logged = mockLogToAxiom.mock.calls[0][0] as { message?: string };
      expect(logged.message).toContain(LEAKED_COLUMN);
    });
  });

  // ── Route-specific behaviour the delegation must NOT have broken ────────────
  it('v1/users keeps its transient-search 503, ahead of the delegation', async () => {
    const { TRPCError } = await import('@trpc/server');
    mockPublicApiContext2.mockResolvedValue({
      user: {
        getAll: () => {
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: 'User search is temporarily overloaded — please retry.',
          });
        },
      },
    });
    const { req, res } = createMocks({ query: { query: 'heidi' } });
    await usersHandler(req, res);

    expect(res._status()).toBe(503);
    expect(res._json()).toEqual({
      error: 'User search is temporarily overloaded — please retry.',
    });
  });

  it('v1/users answers 499 for a client abort that ALSO looks transient (ordering guard)', async () => {
    // 🔴 This guard must be REACHABLE, not merely breakable. An earlier version
    // threw a bare `new Error('The operation was aborted')` — which satisfies
    // `isClientAbortError` but NOT `isTransientMeiliError`, so the 503 arm could
    // never have fired for it and the test passed with the ordering REVERSED.
    // Mutating `if (!isClientAbortError(error))` to `if (true)` — i.e. restoring
    // the exact pre-PR order this test exists to pin — left the suite green.
    //
    // The shape below satisfies BOTH predicates, which is the only way into the
    // branch. It is the real prod shape, not a contrivance: meilisearch-js's
    // `request()` catch re-wraps a failed fetch as `MeiliSearchCommunicationError`
    // preserving `name` and the original `message`, and
    // `isTransientMeiliError` returns true for that name once `code`/`errno` is a
    // string (`meilisearch/client.ts` — the network-level branch). An aborted
    // fetch is exactly how that arises.
    //
    // Without the ordering, a client that has ALREADY GONE AWAY is answered
    // 503 + `Retry-After: 2` + `Cache-Control: no-store`, and the abort is
    // counted as a search brownout.
    const abortedMeiliCall = Object.assign(new Error('The operation was aborted'), {
      name: 'MeiliSearchCommunicationError',
      code: 'ECONNRESET',
    });
    mockPublicApiContext2.mockResolvedValue({
      user: {
        getAll: () => {
          throw abortedMeiliCall;
        },
      },
    });
    const { req, res } = createMocks({ query: { query: 'heidi' } });
    await usersHandler(req, res);

    expect(res._status(), 'a departed client gets 499, never the transient-search 503').toBe(499);
    expect(res._json()).toBeUndefined();
  });

  it('vault/all keeps its MEMBERSHIP_REQUIRED 200 arm, ahead of the delegation', async () => {
    const { TRPCError } = await import('@trpc/server');
    mockGetPaginatedVaultItems.mockRejectedValue(
      new TRPCError({
        code: 'FORBIDDEN',
        message: 'nope',
        cause: new Error('MEMBERSHIP_REQUIRED'),
      })
    );
    const { req, res } = createMocks({ query: {} });
    await vaultAllHandler(req, res, USER);

    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ vault: null });
  });
});
