import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockLogToAxiom = loggingMock.logToAxiom;
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ROUTE-level coverage for civitai#3845 on `GET /api/v1/apps/{slug}`.
 *
 * Distinct from the sibling suite `apps.test.ts`, which stubs
 * `handleEndpointError` wholesale and therefore pins only status codes: this
 * suite keeps the **REAL** `handleEndpointError` (stubbing only the
 * `MixedAuthEndpoint` wrapper, which needs a live session/db) so the assertions
 * below pin the ACTUAL public response bytes an anonymous caller receives —
 * not a test double's idea of them.
 *
 * Two things are pinned:
 *   1. DISCLOSURE — a driver throw must not put table/column/Prisma text on the
 *      wire (the #3845 incident).
 *   2. ENVELOPE — 400 / 404 / 500 all conform to ONE shape carrying a stable
 *      machine-readable `code`, and a real 200 does NOT carry it.
 */

const { mockResolveScope, mockDetail, mockRateLimit, mockIsHostForColor } = vi.hoisted(() => ({
  mockResolveScope: vi.fn(),
  mockDetail: vi.fn(),
  mockRateLimit: vi.fn(),
  mockIsHostForColor: vi.fn(),
}));

// Keep the REAL handleEndpointError — that is the whole point of this suite.
// Only the auth wrapper is stubbed (it would need a live session + db).
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MixedAuthEndpoint: (handler: unknown) => handler,
}));
// `endpoint-helpers` imports `getAllServerHosts` from this module, so spread the
// original rather than replacing it wholesale.
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isHostForColor: mockIsHostForColor,
}));
// Spread the ORIGINAL: `~/server/logging/client` exports 7 symbols and this suite
// only needs to intercept 3. Replacing it wholesale makes the mock silently stale
// the moment anything in the import graph reaches for a fourth export.
vi.mock('~/server/services/app-blocks-flag', () => ({
  resolveStoreVisibilityScope: mockResolveScope,
}));
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  listAvailableListings: vi.fn(),
  getListingDetail: mockDetail,
}));
vi.mock('~/server/utils/apps-catalog-rate-limit', () => ({
  enforceAppsCatalogRateLimit: mockRateLimit,
}));

import { TRPCError } from '@trpc/server';
import detailHandler from '~/pages/api/v1/apps/[slug]';
import { GENERIC_SERVER_ERROR_MESSAGE as GENERIC_MESSAGE } from '~/server/utils/rest-error-envelope';

type Handler = (req: unknown, res: unknown, user: unknown) => Promise<unknown>;

const LEAKED_TABLE = 'app_collaborators';
const LEAKED_COLUMN = 'app_listing_id';
const MUST_NOT_DISCLOSE = [
  LEAKED_TABLE,
  LEAKED_COLUMN,
  'appCollaborator',
  'findMany',
  'prisma.',
  'invocation',
  'does not exist in the current database',
];

/** Verbatim reproduction of the driver text served in the #3845 incident. */
function driverError() {
  return new Error(
    '\nInvalid `prisma.appCollaborator.findMany()` invocation:\n\n\n' +
      `The column \`${LEAKED_TABLE}.${LEAKED_COLUMN}\` does not exist in the current database.`
  );
}

function createMocks({ query = {} }: { query?: Record<string, string> } = {}) {
  const req = {
    method: 'GET',
    url: '/api/v1/apps/x',
    query,
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
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

const MOD = { id: 7, isModerator: true };

/**
 * The envelope contract, asserted STRUCTURALLY (key presence + type of each key
 * + the discriminator's exact value) — never a substring match on a word some
 * other response could also spell.
 *
 * 🔴 `error` is asserted BY VALUE, not by key presence. Key presence is the
 * weakest possible check on the one field the shipped Go CLI renders in
 * PREFERENCE to `message` (`readError` in `pkg/civitai/read.go` takes `error`
 * whenever it is non-empty and only falls back to `message`): a build that
 * blanked `error`, or retyped the 400's away from the zod flatten object the CLI
 * special-cases, would keep the key and pass a presence check while every
 * CLI-visible error string went blank or lost its per-field detail.
 *
 * `expectedError` is either a literal to match exactly, or the sentinel
 * `ZOD_FLATTEN` meaning "the `{formErrors, fieldErrors}` object".
 */
const ZOD_FLATTEN = Symbol('zod-flatten-object');

function expectErrorEnvelope(
  body: unknown,
  label: string,
  expectedCode: string,
  expectedError: string | typeof ZOD_FLATTEN
) {
  expect(body, `${label}: body must be a non-null JSON object`).toBeTypeOf('object');
  expect(body, `${label}: body must be a non-null JSON object`).not.toBeNull();
  const b = body as Record<string, unknown>;
  expect(b.code, `${label}: must carry the \`code\` discriminator`).toBe(expectedCode);
  // Must stay a string: the Go CLI decodes `message` into a `Message string`,
  // and a non-string value fails the whole envelope unmarshal.
  expect(typeof b.message, `${label}: \`message\` must be a string`).toBe('string');
  expect(
    Object.prototype.hasOwnProperty.call(b, 'error'),
    `${label}: must retain the legacy \`error\` key`
  ).toBe(true);

  if (expectedError === ZOD_FLATTEN) {
    // The exact shape `badRequestDetail` special-cases to render per-field
    // errors. A `parsed.error.message` (a STRING) fails the first assertion; a
    // partially-shaped object fails the next two.
    expect(
      typeof b.error,
      `${label}: \`error\` must be the zod flatten OBJECT the CLI special-cases, not a string`
    ).toBe('object');
    const flat = b.error as Record<string, unknown>;
    expect(Array.isArray(flat?.formErrors), `${label}: \`error.formErrors\` must be an array`).toBe(
      true
    );
    expect(typeof flat?.fieldErrors, `${label}: \`error.fieldErrors\` must be an object`).toBe(
      'object'
    );
  } else {
    expect(
      b.error,
      `${label}: \`error\` must carry the human text VERBATIM — the CLI renders it in ` +
        `preference to \`message\`, so a blank/renamed value silently empties every CLI error`
    ).toBe(expectedError);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(false);
  mockIsHostForColor.mockReturnValue(false);
  mockResolveScope.mockImplementation(async ({ user }: { user?: { isModerator?: boolean } }) =>
    user?.isModerator ? 'full' : 'none'
  );
  mockDetail.mockResolvedValue({ id: 'al_a', serialId: 1, slug: 'a', kind: 'onsite', name: 'a' });
});

describe('GET /api/v1/apps/{slug} — error envelope + disclosure', () => {
  // ── Guard: the #3845 disclosure, through the REAL handler ──────────────────
  it('a driver throw does NOT disclose table/column/Prisma detail on the wire', async () => {
    mockDetail.mockRejectedValueOnce(driverError());
    const { req, res } = createMocks({ query: { slug: 'sensei' } });

    await (detailHandler as unknown as Handler)(req, res, MOD);

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

  // ── Guard: one envelope across every non-2xx status this route emits ───────
  it('400, 404 and 500 all conform to ONE envelope carrying the discriminator', async () => {
    // 400 — invalid/absent slug (zod). `error` stays the zod flatten OBJECT:
    // the shipped Go CLI special-cases that shape to render field errors.
    const bad = createMocks({ query: {} });
    await (detailHandler as unknown as Handler)(bad.req, bad.res, MOD);
    expect(bad.res._status()).toBe(400);
    expectErrorEnvelope(bad.res._json(), '400', 'BAD_REQUEST', ZOD_FLATTEN);

    // 404 — out-of-scope caller (the default-closed scope gate).
    const scoped = createMocks({ query: { slug: 'secret-app' } });
    await (detailHandler as unknown as Handler)(scoped.req, scoped.res, undefined);
    expect(scoped.res._status()).toBe(404);
    expectErrorEnvelope(scoped.res._json(), '404 (scope gate)', 'NOT_FOUND', 'App not found');

    // 404 — the OTHER 404 site: service resolved nothing.
    mockDetail.mockResolvedValueOnce(null);
    const absent = createMocks({ query: { slug: 'ghost' } });
    await (detailHandler as unknown as Handler)(absent.req, absent.res, MOD);
    expect(absent.res._status()).toBe(404);
    expectErrorEnvelope(absent.res._json(), '404 (absent listing)', 'NOT_FOUND', 'App not found');

    // 500 — unhandled throw via the shared helper.
    mockDetail.mockRejectedValueOnce(driverError());
    const boom = createMocks({ query: { slug: 'sensei' } });
    await (detailHandler as unknown as Handler)(boom.req, boom.res, MOD);
    expect(boom.res._status()).toBe(500);
    expectErrorEnvelope(boom.res._json(), '500', 'INTERNAL_SERVER_ERROR', GENERIC_MESSAGE);
  });

  // ── Guard: the OTHER 500 branch, through the SAME real route ───────────────
  // `getListingDetail` reaches its data through services that funnel driver
  // failures into `throwDbError` → a `TRPCError`, which takes the helper's
  // TRPCError branch, not the else-branch the two tests above exercise. Same
  // route, same public caller, different code path — and it leaked identically
  // until this round.
  it('a TRPCError-wrapped driver throw is ALSO generic on the wire (both fields)', async () => {
    mockDetail.mockRejectedValueOnce(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: driverError().message,
        cause: driverError(),
      })
    );
    const { req, res } = createMocks({ query: { slug: 'sensei' } });

    await (detailHandler as unknown as Handler)(req, res, MOD);

    expect(res._status()).toBe(500);
    const serialized = JSON.stringify(res._json());
    for (const secret of MUST_NOT_DISCLOSE) {
      expect(
        serialized,
        `#3845 (TRPCError branch, route level): must not disclose ${JSON.stringify(
          secret
        )} — full body was ${serialized}`
      ).not.toContain(secret);
    }
    expectErrorEnvelope(res._json(), '500 (TRPCError)', 'INTERNAL_SERVER_ERROR', GENERIC_MESSAGE);
  });

  // ── Guard: the 4xx pass-through is UNCHANGED on the same route ─────────────
  it('INVARIANT: a 4xx TRPCError still passes its body through untouched', async () => {
    mockDetail.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'That app was removed' })
    );
    const { req, res } = createMocks({ query: { slug: 'gone' } });

    await (detailHandler as unknown as Handler)(req, res, MOD);

    expect(res._status(), 'a 4xx must not be swept into the server-fault branch').toBe(404);
    expect(res._json(), 'the 4xx body must stay exactly what the helper always produced').toEqual({
      message: 'That app was removed',
    });
  });

  // ── Positive control: the discriminator actually DISCRIMINATES ─────────────
  // Asserts BOTH sides in one test so it cannot pass vacuously: a `code` that
  // were present on every response (or on none) fails here.
  it('the `code` discriminator is present on an error and ABSENT from a real 200', async () => {
    // Negative side — a genuine success.
    const ok = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(ok.req, ok.res, MOD);
    expect(ok.res._status()).toBe(200);
    const okBody = ok.res._json() as Record<string, unknown>;
    expect(
      Object.prototype.hasOwnProperty.call(okBody, 'code'),
      'a 200 must NOT carry the error discriminator — otherwise it discriminates nothing'
    ).toBe(false);

    // Positive side — the same key IS present on an error from the same route.
    const err = createMocks({ query: { slug: 'ghost' } });
    mockDetail.mockResolvedValueOnce(null);
    await (detailHandler as unknown as Handler)(err.req, err.res, MOD);
    expect(err.res._status()).toBe(404);
    expect(
      Object.prototype.hasOwnProperty.call(err.res._json() as object, 'code'),
      'the discriminator must be present on error responses'
    ).toBe(true);
  });

  // ── Guard: nothing on the request path throws OUTSIDE the try ─────────────
  // The rate limiter and the scope gate used to sit before the `try`, so a throw
  // from either escaped `handleEndpointError` entirely — Next.js's default 500,
  // no envelope, no `code`, no fault log. Neither has a KNOWN throw path today
  // (the limiter catches its own Redis errors; `isFlipt` swallows init/eval
  // failures), so this pins the STRUCTURE: wherever the throw comes from on this
  // route, the response is the envelope.
  it('a throw from the SCOPE GATE still produces the envelope, not an escaped throw', async () => {
    mockResolveScope.mockRejectedValueOnce(new Error('flipt exploded'));
    const { req, res } = createMocks({ query: { slug: 'my-app' } });

    await expect(
      (detailHandler as unknown as Handler)(req, res, MOD),
      'the handler must not reject — the throw belongs to handleEndpointError'
    ).resolves.not.toThrow();

    expect(res._status()).toBe(500);
    expectErrorEnvelope(
      res._json(),
      '500 (scope gate throw)',
      'INTERNAL_SERVER_ERROR',
      GENERIC_MESSAGE
    );
  });

  it('a throw from the RATE LIMITER still produces the envelope, not an escaped throw', async () => {
    mockRateLimit.mockRejectedValueOnce(new Error('redis exploded'));
    const { req, res } = createMocks({ query: { slug: 'my-app' } });

    await expect(
      (detailHandler as unknown as Handler)(req, res, MOD),
      'the handler must not reject — the throw belongs to handleEndpointError'
    ).resolves.not.toThrow();

    expect(res._status()).toBe(500);
    expectErrorEnvelope(
      res._json(),
      '500 (limiter throw)',
      'INTERNAL_SERVER_ERROR',
      GENERIC_MESSAGE
    );
  });

  // ── Invariant: the 200 payload is untouched by this change ────────────────
  it('INVARIANT: a 200 still returns the listing detail unchanged', async () => {
    const { req, res } = createMocks({ query: { slug: 'my-app' } });
    await (detailHandler as unknown as Handler)(req, res, MOD);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({
      id: 'al_a',
      serialId: 1,
      slug: 'a',
      kind: 'onsite',
      name: 'a',
    });
  });
});
