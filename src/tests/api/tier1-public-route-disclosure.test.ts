import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * civitai#3845 **TIER 1** — the five UNAUTHENTICATED REST routes that served a
 * caught error's text to anonymous callers.
 *
 * `rest-error-envelope-ledger.test.ts` enumerated these as known-unfixed and said
 * why they were not swept up with the other eleven: **each answered a 4xx for
 * EVERY failure, including a legitimate zod rejection**, so routing them blindly
 * through `handleEndpointError` would have turned a client's malformed query
 * string from a 400 into a 500 — fixing a disclosure by breaking the API
 * contract. Every route below therefore has TWO obligations, and this suite
 * asserts both for each:
 *
 *   1. **No disclosure.** A driver error's own prose never reaches the wire.
 *   2. **No contract break.** The validation rejection keeps its status AND its
 *      detail, byte-for-byte where it was byte-for-byte before.
 *
 * Obligation 2 is why several tests here are green on BOTH sides of the fix.
 * Those are labelled `INVARIANT:` and are NOT regression coverage — they are the
 * fence the fix had to stay inside. The `LEAK:` tests are the regression
 * coverage; each was observed failing on pre-fix code with an assertion failure.
 *
 * 🔴 The driver errors are REAL (`Prisma.PrismaClientKnownRequestError`, `pg`'s
 * `DatabaseError`) and the assertions read the WHOLE serialized body. A plain
 * `Error` serializes to `{}`, which is exactly why this class looked safe for
 * years, and these payloads leak through several keys at once.
 */

const { mockLogToAxiom, mockBuildCentralErrorLog, mockWasServerFaultLogged } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  mockBuildCentralErrorLog: vi.fn((e: unknown) => ({
    name: (e as Error)?.name,
    message: (e as Error)?.message,
  })),
  mockWasServerFaultLogged: vi.fn(() => false),
}));

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logToAxiom: mockLogToAxiom,
  buildCentralErrorLog: mockBuildCentralErrorLog,
  wasServerFaultLogged: mockWasServerFaultLogged,
}));

// 🔴 Spread the ORIGINAL: `handleEndpointError` is under test here, so replacing
// this module wholesale would make every route call `undefined` and fail for a
// reason that has nothing to do with the disclosure.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
  MixedAuthEndpoint: (handler: unknown) => handler,
}));

const {
  mockGetServerAuthSession,
  mockRunImageSearch,
  mockGetGenerationData,
  mockGetResourceData,
  mockGetFileForModelVersion,
  mockKeyValueFindUnique,
  mockModelFileFindUnique,
  mockFetchThroughCache,
  mockGetFullTensorAnalysisCached,
  mockHasExceededLimit,
  mockIncrement,
  mockBustUserDownloadsCache,
  mockTracker,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockRunImageSearch: vi.fn(),
  mockGetGenerationData: vi.fn(),
  mockGetResourceData: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockKeyValueFindUnique: vi.fn(),
  mockModelFileFindUnique: vi.fn(),
  mockFetchThroughCache: vi.fn(),
  mockGetFullTensorAnalysisCached: vi.fn(),
  mockHasExceededLimit: vi.fn(),
  mockIncrement: vi.fn(),
  mockBustUserDownloadsCache: vi.fn(),
  mockTracker: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));
vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: mockRunImageSearch,
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getGenerationData: mockGetGenerationData,
  getResourceData: mockGetResourceData,
}));
vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: mockGetFileForModelVersion,
}));
vi.mock('~/server/services/user.service', () => ({
  bustUserDownloadsCache: mockBustUserDownloadsCache,
}));
vi.mock('~/server/services/tensor-metadata.service', () => ({
  getFullTensorAnalysisCached: mockGetFullTensorAnalysisCached,
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: mockFetchThroughCache,
}));
vi.mock('~/server/utils/rate-limiting', () => ({
  createLimiter: () => ({ hasExceededLimit: mockHasExceededLimit, increment: mockIncrement }),
}));
vi.mock('~/server/utils/download-count', () => ({ fetchDownloadCount: vi.fn() }));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    keyValue: { findUnique: mockKeyValueFindUnique },
    modelFile: { findUnique: mockModelFileFindUnique },
  },
  dbWrite: {},
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Tracker: mockTracker,
}));
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
  };
});

import { Prisma } from '@prisma/client';
import { DatabaseError } from 'pg';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';

import imagesHandler from '~/pages/api/v1/images/index';
import generationDataHandler from '~/pages/api/generation/data';
import generationResourcesHandler from '~/pages/api/generation/resources';
import downloadModelRoute from '~/pages/api/download/models/[modelVersionId]';
import tensorMetadataRoute from '~/pages/api/v1/model-files/[id]/tensor-metadata';

/**
 * `MixedAuthEndpoint` is mocked to identity above, so this module exports its
 * INNER 3-arg handler at runtime while TypeScript still sees the wrapper's 2-arg
 * signature. Cast once, here.
 */
const tensorMetadataHandler = tensorMetadataRoute as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) => Promise<unknown>;

// ── The payloads. Both are REAL driver errors, not stand-ins. ────────────────
const LEAKED_TABLE = 'app_collaborators';
const LEAKED_COLUMN = 'app_listing_id';
const CLIENT_VERSION = '6.13.0';
const VICTIM_EMAIL = 'victim@example.com';

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

/**
 * The wrapper ~310 call sites use. This is the shape that actually reached the
 * wire in the #3845 incident: `throwDbError` copies the driver's message VERBATIM
 * into a TRPCError, and `prismaErrorToTrpcCode` sends P2022 to
 * INTERNAL_SERVER_ERROR — so the raw invocation text arrived as a 500 body.
 */
function dbWrappedPrismaError() {
  const driver = prismaDriverError();
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: driver.message, cause: driver });
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
  headers = {},
}: {
  query?: Record<string, unknown>;
  body?: unknown;
  method?: string;
  headers?: Record<string, string>;
} = {}) {
  const req = {
    method,
    url: '/api/test',
    headers: { host: 'civitai.com', ...headers },
    query,
    body,
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: unknown;
  let sent: unknown;
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
    send(b: unknown) {
      sent = b;
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
    _sent: () => sent,
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

/**
 * Every TIER-1 route, with the ONE dependency whose failure used to be serialized
 * into the response, plus the request that must still be REJECTED as a client
 * error after the fix.
 *
 * `throws` is what the route's failing dependency raises. It is deliberately the
 * `throwDbError`-wrapped TRPCError for the routes that reach the wire through
 * `handleEndpointError`'s TRPCError arm, and a bare driver error for the ones
 * whose catch never involved tRPC — matching how each route is actually reached
 * in production.
 */
type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const downloadModelHandler = downloadModelRoute as unknown as Handler;

/** Primes the dependency that must NOT be reached on an invalid-input request. */
const unreachable = (() => {
  throw new Error('MUST NOT BE REACHED: the invalid-input path ran the dependency');
}) as () => never;

const ROUTES = [
  {
    name: 'GET /api/v1/images',
    oldShape: '{ error: trpcError.message, code: trpcError.code } on a PublicEndpoint',
    run: (throwing: () => never) => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockRunImageSearch.mockImplementation(throwing);
      const { req, res } = createMocks({ query: {} });
      return { promise: imagesHandler(req, res), res };
    },
    // 🔴 The zod `safeParse` 400 already lived OUTSIDE the catch on this route, so
    // this is re-assertion, not change. `?limit=` is a `numericString`.
    invalidStatus: 400,
    runInvalid: () => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockRunImageSearch.mockImplementation(unreachable);
      const { req, res } = createMocks({ query: { limit: 'not-a-number' } });
      return { promise: imagesHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/generation/data',
    oldShape: 'catch-all → 400 { message: e.message } on a PublicEndpoint',
    run: (throwing: () => never) => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockGetGenerationData.mockImplementation(throwing);
      const { req, res } = createMocks({ query: { type: 'modelVersion', id: '1' } });
      return { promise: generationDataHandler(req, res), res };
    },
    invalidStatus: 400,
    runInvalid: () => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockGetGenerationData.mockImplementation(unreachable);
      // `type` is a discriminated-union literal — 'nonsense' has no arm.
      const { req, res } = createMocks({ query: { type: 'nonsense', id: '1' } });
      return { promise: generationDataHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/generation/resources',
    oldShape: 'catch-all → 400 { message: e.message } on a PublicEndpoint',
    run: (throwing: () => never) => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockGetResourceData.mockImplementation(throwing);
      const { req, res } = createMocks({ query: { ids: '1' } });
      return { promise: generationResourcesHandler(req, res), res };
    },
    invalidStatus: 400,
    runInvalid: () => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockGetResourceData.mockImplementation(unreachable);
      // `ids` is required — omitting it is the malformed-`?ids=` case the brief
      // named as the one a blind delegation would turn from a 400 into a 500.
      const { req, res } = createMocks({ query: {} });
      return { promise: generationResourcesHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/download/models/[modelVersionId]',
    oldShape: 'errorResponse(500, err.message) on a PublicEndpoint — JSON *and* text/plain',
    run: (throwing: () => never) => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockKeyValueFindUnique.mockResolvedValue(null);
      mockHasExceededLimit.mockResolvedValue(false);
      mockGetFileForModelVersion.mockImplementation(throwing);
      const { req, res } = createMocks({ query: { modelVersionId: '1' } });
      return { promise: downloadModelHandler(req, res), res };
    },
    invalidStatus: 400,
    runInvalid: () => {
      mockGetServerAuthSession.mockResolvedValue(null);
      mockKeyValueFindUnique.mockResolvedValue(null);
      mockHasExceededLimit.mockResolvedValue(false);
      mockGetFileForModelVersion.mockImplementation(unreachable);
      const { req, res } = createMocks({ query: { modelVersionId: 'not-a-number' } });
      return { promise: downloadModelHandler(req, res), res };
    },
  },
  {
    name: 'GET /api/v1/model-files/[id]/tensor-metadata',
    oldShape: '422 { error: err.message } on a MixedAuthEndpoint whose read path is public',
    run: (throwing: () => never) => {
      mockModelFileFindUnique.mockResolvedValue(TENSOR_FILE);
      mockGetFileForModelVersion.mockResolvedValue({
        status: 'success',
        url: 'https://files.example/model.safetensors',
      });
      mockFetchThroughCache.mockImplementation(throwing);
      mockGetFullTensorAnalysisCached.mockImplementation(throwing);
      const { req, res } = createMocks({ query: { id: '1' } });
      return { promise: tensorMetadataHandler(req, res, undefined), res };
    },
    invalidStatus: 400,
    runInvalid: () => {
      mockModelFileFindUnique.mockImplementation(unreachable);
      const { req, res } = createMocks({ query: { id: 'not-a-number' } });
      return { promise: tensorMetadataHandler(req, res, undefined), res };
    },
  },
] as const;

const TENSOR_FILE = {
  id: 1,
  modelVersionId: 2,
  name: 'model.safetensors',
  type: 'Model',
  sizeKB: 1024,
  metadata: {},
  modelVersion: { model: { type: 'Checkpoint' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockWasServerFaultLogged.mockReturnValue(false);
});

/**
 * 🔴 POSITIVE CONTROL ON THE FIXTURES — added because a mutation found the gap.
 *
 * Every `LEAK:` test below is a `.not.toContain`, and a `.not.toContain` is
 * trivially satisfied by a payload that never carried the secret. Collapsing
 * `prismaDriverError()` to a plain `Error` (which serializes to `{}` — the exact
 * reason this whole class looked safe for years) left ALL FIFTEEN of them green;
 * only one incidental log assertion noticed. So the fixtures are pinned here: if
 * a payload stops carrying the string, this fails instead of fifteen tests
 * quietly passing for the wrong reason.
 */
describe('civitai#3845 TIER 1 — fixture realism (the control the LEAK tests rest on)', () => {
  it('the Prisma fixture actually carries every secret the LEAK tests look for', () => {
    const serialized = JSON.stringify({
      error: prismaDriverError(),
      m: prismaDriverError().message,
    });
    for (const secret of PRISMA_SECRETS)
      expect(
        serialized,
        `the fixture no longer carries ${secret} — LEAK tests are vacuous`
      ).toContain(secret);
  });

  it('the pg fixture actually carries every secret the LEAK tests look for', () => {
    const serialized = JSON.stringify({ error: pgDriverError(), m: pgDriverError().message });
    for (const secret of PG_SECRETS)
      expect(
        serialized,
        `the fixture no longer carries ${secret} — LEAK tests are vacuous`
      ).toContain(secret);
  });

  it('the throwDbError-wrapped fixture forwards the driver text verbatim', () => {
    // `throwDbError` copies `.message` across and keeps the driver as `cause`.
    // If it stopped doing either, the 4xx genericization path would go untested.
    const wrapped = dbWrappedPrismaError();
    expect(wrapped.message).toBe(prismaDriverError().message);
    expect(wrapped.message).toContain(LEAKED_COLUMN);
    expect(wrapped.cause).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

describe("civitai#3845 TIER 1 — no unauthenticated route serves a caught error's text", () => {
  describe.each(ROUTES)('$name (was: $oldShape)', ({ run, runInvalid, invalidStatus }) => {
    it('LEAK: does NOT disclose Prisma driver, table or column detail', async () => {
      const throwing = (() => {
        throw dbWrappedPrismaError();
      }) as () => never;
      const { promise, res } = run(throwing);
      await promise;

      const serialized = JSON.stringify({ json: res._json(), sent: res._sent() });
      for (const secret of PRISMA_SECRETS) {
        expect(
          serialized,
          `must not disclose ${JSON.stringify(secret)} — full response was ${serialized}`
        ).not.toContain(secret);
      }
    });

    it('LEAK: does NOT disclose a raw (unwrapped) Prisma error either', async () => {
      // Not every path to these catches goes through `throwDbError`. A Prisma
      // client call made directly in a service reaches the route unwrapped, and
      // the object's own props are ENUMERABLE — so this is the case where a whole
      // error serializes its meta.column rather than merely its message.
      const throwing = (() => {
        throw prismaDriverError();
      }) as () => never;
      const { promise, res } = run(throwing);
      await promise;

      const serialized = JSON.stringify({ json: res._json(), sent: res._sent() });
      for (const secret of PRISMA_SECRETS) {
        expect(
          serialized,
          `must not disclose ${JSON.stringify(secret)} — full response was ${serialized}`
        ).not.toContain(secret);
      }
    });

    it('LEAK: does NOT disclose a pg unique-violation detail (an actual user row value)', async () => {
      const throwing = (() => {
        throw pgDriverError();
      }) as () => never;
      const { promise, res } = run(throwing);
      await promise;

      const serialized = JSON.stringify({ json: res._json(), sent: res._sent() });
      for (const secret of PG_SECRETS) {
        expect(
          serialized,
          `must not disclose ${JSON.stringify(secret)} — full response was ${serialized}`
        ).not.toContain(secret);
      }
    });

    it('INVARIANT: the failure still ANSWERS, with a string message the CLI can decode', async () => {
      const throwing = (() => {
        throw dbWrappedPrismaError();
      }) as () => never;
      const { promise, res } = run(throwing);
      await promise;

      expect(res._status(), 'a swallowed error would hang the request').toBeGreaterThanOrEqual(400);
      const body = res._json() as Record<string, unknown> | undefined;
      // The Go CLI unmarshals `message` into a `Message string`; a non-string
      // fails the WHOLE envelope decode, so this is a hard consumer constraint.
      if (body && 'message' in body) expect(typeof body.message).toBe('string');
      // …and it renders `error` in PREFERENCE to `message`, so an `error` key that
      // exists must not be emptied.
      if (body && 'error' in body) expect(body.error).toBeTruthy();
    });

    it('INVARIANT: an invalid request is still rejected as a CLIENT error, not a 500', async () => {
      // 🔴 This is the whole reason these five were held back from the parent
      // change, and it is the assertion a blind delegation fails. Green on BOTH
      // sides of the fix by construction — it is the fence the fix had to stay
      // inside, NOT regression coverage. Its mutation coverage is the
      // "blind-delegation" mutant reported in the PR body: replacing each route's
      // validation branch with `handleEndpointError` turns every one of these
      // 400s into a 500 and this goes red at all five.
      const { promise, res } = runInvalid();
      await promise;

      expect(
        res._status(),
        'a malformed query string must stay a client error — full body ' +
          JSON.stringify(res._json())
      ).toBe(invalidStatus);
      // And the detail is retained: this is feedback WE wrote about the caller's
      // own input, so genericizing it would remove good client feedback to redact
      // nothing. Non-empty is the assertable floor — the exact text is zod's and
      // is version-dependent.
      const body = res._json() as Record<string, unknown>;
      const detail = (body?.message ?? body?.error) as unknown;
      expect(detail, `no rejection detail survived: ${JSON.stringify(body)}`).toBeTruthy();
    });
  });

  // ── Route-specific behaviour the fix must not have broken ──────────────────

  it('LEAK: download/models does not leak through the text/plain BROWSER arm either', async () => {
    // 🔴 The ledger sweep only inspects `.json({…})` bodies, so this arm was
    // invisible to it: `errorResponse` answers a browser UA with `res.send(text)`,
    // which put the same driver prose on the wire as bare text/plain. A fix that
    // only touched the JSON arm would pass every ledger test.
    mockGetServerAuthSession.mockResolvedValue(null);
    mockKeyValueFindUnique.mockResolvedValue(null);
    mockHasExceededLimit.mockResolvedValue(false);
    mockGetFileForModelVersion.mockImplementation((() => {
      throw prismaDriverError();
    }) as () => never);
    const { req, res } = createMocks({
      query: { modelVersionId: '1' },
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36' },
    });
    await downloadModelHandler(req, res);

    expect(res._status()).toBe(500);
    // The browser arm answered, and with our text rather than the driver's.
    expect(typeof res._sent(), 'the browser arm must still send a body').toBe('string');
    expect(res._sent()).toBe('An unexpected error occurred');
    for (const secret of PRISMA_SECRETS) expect(String(res._sent())).not.toContain(secret);
  });

  it('INVARIANT: download/models still logs the un-redacted text — genericizing relocates, never destroys', async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    mockKeyValueFindUnique.mockResolvedValue(null);
    mockHasExceededLimit.mockResolvedValue(false);
    mockGetFileForModelVersion.mockImplementation((() => {
      throw prismaDriverError();
    }) as () => never);
    const { req, res } = createMocks({ query: { modelVersionId: '1' } });
    await downloadModelHandler(req, res);

    const logged = mockLogToAxiom.mock.calls.map(([c]) => JSON.stringify(c)).join('\n');
    expect(logged, 'the un-redacted text must reach `_axiom`').toContain(LEAKED_COLUMN);
  });

  it('INVARIANT: tensor-metadata KEEPS its 422 and serves a human-readable string', async () => {
    // The status is caller feedback about the requested FILE, so it is preserved
    // rather than reclassified into a 500 — and `ModelTensorMetadata.tsx` renders
    // `body.error` verbatim as the panel's message, so it must stay a non-empty
    // string. This is the pair a blind delegation breaks in BOTH directions.
    mockModelFileFindUnique.mockResolvedValue(TENSOR_FILE);
    mockGetFileForModelVersion.mockResolvedValue({
      status: 'success',
      url: 'https://files.example/model.safetensors',
    });
    mockGetFullTensorAnalysisCached.mockImplementation((() => {
      throw prismaDriverError();
    }) as () => never);
    const { req, res } = createMocks({ query: { id: '1' } });
    await tensorMetadataHandler(req, res, undefined);

    expect(res._status()).toBe(422);
    const body = res._json() as { error?: unknown };
    expect(typeof body.error).toBe('string');
    expect((body.error as string).length).toBeGreaterThan(0);
  });

  it('generation/data: a TRPCError NOT_FOUND now answers 404 (documented status change)', async () => {
    // Pre-fix this was a 400, because the catch answered EVERYTHING with 400.
    // `getMediaGenerationData` raises `throwNotFoundError()` for a missing media
    // id, so the new status is the CORRECT one — recorded here so the change is a
    // decision with a test behind it rather than a side effect nobody noticed.
    mockGetServerAuthSession.mockResolvedValue(null);
    mockGetGenerationData.mockImplementation((() => {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }) as () => never);
    const { req, res } = createMocks({ query: { type: 'image', id: '999' } });
    await generationDataHandler(req, res);

    expect(res._status()).toBe(404);
    expect(res._json()).toEqual({ message: 'NOT_FOUND' });
  });

  it('INVARIANT: generation/data — a hand-written BAD_REQUEST keeps its 400 AND its exact text', async () => {
    // 🔴 The trap this fix had to avoid. `getGenerationData`'s `default:` arm is
    // REACHABLE — the schema accepts `type: 'audio'` and the switch has no arm for
    // it — and it used to reach the wire as `400 "unsupported generation data
    // type"` purely because the catch answered everything 400. That throw was
    // converted from `new Error` to `throwBadRequestError` in the same commit so
    // it keeps both; a plain `Error` would now be a generic 500.
    mockGetServerAuthSession.mockResolvedValue(null);
    mockGetGenerationData.mockImplementation((() => {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'unsupported generation data type' });
    }) as () => never);
    const { req, res } = createMocks({ query: { type: 'audio', id: '1' } });
    await generationDataHandler(req, res);

    expect(res._status()).toBe(400);
    expect(res._json()).toEqual({ message: 'unsupported generation data type' });
  });

  it.each([
    [
      'generation/data',
      generationDataHandler,
      { type: 'modelVersion', id: '1' },
      mockGetGenerationData,
    ],
    ['generation/resources', generationResourcesHandler, { ids: '1' }, mockGetResourceData],
  ])(
    '%s does not write twice when the response was already sent',
    async (_name, handler, query, dep) => {
      // 🔴 Added because a mutation survived: deleting `if (res.headersSent) return;`
      // left every other test green. Node throws ERR_HTTP_HEADERS_SENT on a second
      // write, which would escape the catch and surface as an unhandled rejection —
      // and `handleEndpointError` only guards `headersSent` on its 499 branch, so
      // the route has to. The pre-fix code had the same guard spelled
      // `if (!res.headersSent) …`; this pins that it survived the rewrite.
      mockGetServerAuthSession.mockResolvedValue(null);
      (dep as ReturnType<typeof vi.fn>).mockImplementation((() => {
        throw prismaDriverError();
      }) as () => never);

      const { req, res } = createMocks({ query });
      // A response Node considers already committed: any further write throws.
      Object.defineProperty(res, 'headersSent', { get: () => true });
      const exploded = vi.fn();
      (res as unknown as { status: unknown }).status = () => {
        exploded();
        throw new Error('ERR_HTTP_HEADERS_SENT');
      };

      await expect(
        (handler as Handler)(req, res),
        'the handler must not reject when the response is already committed'
      ).resolves.not.toThrow();
      expect(exploded, 'nothing may be written after headersSent').not.toHaveBeenCalled();
    }
  );

  it.each([
    ['out-of-range (int4 overflow)', '1e30'],
    ['non-integer', '1.5'],
    ['negative', '-1'],
    ['zero', '0'],
  ])('tensor-metadata rejects an %s ?id= as a 400, never reaching the database', async (_n, id) => {
    // 🔴 Found by the blind audit. `z.preprocess(v => Number(v), z.number())`
    // ACCEPTS all four of these — `Number()` coerces them and neither an
    // out-of-range float nor a non-integer is a `.number()` failure. The value
    // then bound to `ModelFile.id` (int4) and Postgres threw from
    // `dbRead.modelFile.findUnique`, which sits BEFORE the handler's `try`, so the
    // throw escaped every civitai handler: a bare 500 with NO `logToAxiom` record.
    // Not a disclosure (measured), but an anonymous caller could mint
    // fault-record-free 500s at will — the forensic guarantee the rest of
    // civitai#3845 depends on. Bounded to int4 at the schema; this pins that the
    // DB is never reached.
    mockModelFileFindUnique.mockImplementation(unreachable);
    const { req, res } = createMocks({ query: { id } });
    await tensorMetadataHandler(req, res, undefined);

    expect(res._status()).toBe(400);
    expect(
      mockModelFileFindUnique,
      'the query must be rejected BEFORE the DB call'
    ).not.toHaveBeenCalled();
    // Caller feedback is retained — this is a rejection we wrote, not a disclosure.
    expect((res._json() as { error?: unknown }).error).toBeTruthy();
  });

  it('INVARIANT: tensor-metadata still accepts a legitimate integer id', async () => {
    // The counterpart control: a bound that rejects everything would pass the four
    // cases above while breaking the route. `buildTensorMetadataUrl` only ever
    // sends a real file id, and that must still reach the lookup.
    mockModelFileFindUnique.mockResolvedValue(null);
    const { req, res } = createMocks({ query: { id: '2147483647' } });
    await tensorMetadataHandler(req, res, undefined);

    expect(mockModelFileFindUnique, 'a valid int4 id must reach the DB').toHaveBeenCalled();
    expect(res._status(), 'and a missing row is a 404, not a 400').toBe(404);
  });

  it('INVARIANT: v1/images keeps its transient-search 503 ahead of the delegation', async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    mockRunImageSearch.mockImplementation((() => {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Meili is shedding' });
    }) as () => never);
    const { req, res } = createMocks({ query: {} });
    await imagesHandler(req, res);

    expect(res._status(), 'a 503 must not be genericized into a 500').toBe(503);
  });
});

/**
 * A STRUCTURAL guard for `download/models/[modelVersionId].ts`.
 *
 * 🔴 That route stays in `KNOWN_UNFIXED_SAME_CLASS` as an OVER-REPORT: its
 * `errorResponse` helper contains `res.json({ error: message })`, so the ledger's
 * shape sweep flags the file no matter what the call sites pass. The only ways to
 * clear it would be to restructure the helper purely to dodge a regex, or to
 * re-introduce a name allowlist — the exact change that buried this very route for
 * a whole review round.
 *
 * So the property that makes it an over-report is asserted directly instead of
 * asserted in a comment: **every `errorResponse(...)` call site passes text we
 * wrote.** Re-introducing `errorResponse(500, err.message)` fails HERE even though
 * the ledger stays green either way.
 */
describe('LEDGER: download/models `errorResponse` is never called with caught-error text', () => {
  const ROUTE = path.resolve(__dirname, '../../pages/api/download/models/[modelVersionId].ts');
  /**
   * Drop comments before scanning — a NAMED function, because the production
   * pipeline below and the tests must exercise the SAME code.
   *
   * 🔴 The `//` half was not free to find: the comment on the fixed line QUOTES
   * the old `errorResponse(500, err.message)` as the thing it replaced, and the
   * scan matched the quote and reported the live code as still leaking.
   *
   * 🔴 The `/* … *\/` half then arrived with a test that applied its OWN INLINE
   * COPY of this regex to a local string, never touching this pipeline at all. A
   * delta audit deleted the strip from here and got 46/46 green; replacing it with
   * `/ZZZ_NEVER_MATCHES/` also got 46/46 green. A test asserting against a copy of
   * the thing it tests is the purest form of the failure this whole file is about,
   * and it was in the file that exists to catch it. Hence: one function, called by
   * both.
   */
  function stripComments(raw: string): string {
    return raw
      .replace(/\/\*[^\n]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
  }

  const source = stripComments(readFileSync(ROUTE, 'utf8'));

  /**
   * The MESSAGE argument of every `errorResponse(...)` call — extracted by a
   * quote-aware paren scan, NOT by a regex over the status.
   *
   * 🔴 Third version, because the first two both decided whether to inspect a call
   * site based on the shape of its STATUS. `\d{3}` exempted
   * `errorResponse(status, err.message)`. Widening to `[^,)]+` looked structural
   * and was not — it cannot cross a `)`, so
   * `errorResponse(getStatusCode(fileResult.status), err.message)` was still never
   * extracted, and `every(...)` stayed vacuously true over it. That is not
   * hypothetical: `tensor-metadata.ts` already has exactly that `getStatusCode`
   * helper, and `download/models` open-codes the same mapping at six sites, so
   * consolidating them — an obvious, desirable refactor — would have blinded this
   * guard at every one.
   *
   * What makes a call site safe is its MESSAGE, so nothing about the status may
   * decide whether the site is looked at. Scan the argument list.
   */
  /** Matches every call site — NOT the `function errorResponse(...)` definition. */
  const CALL_SITE = () => /(?<!function\s)errorResponse\(/g;

  /**
   * One entry per `errorResponse(` occurrence — `null` means the scan FAILED.
   *
   * 🔴 The null is surfaced instead of being dropped, because dropping it is
   * exactly how the previous version defeated itself. `callArgs` did
   * `if (args && args.length >= 2) out.push(args[1])`, so a site the scanner
   * choked on vanished from the set and `every(...)` was vacuously true over it.
   * An audit injected two LIVE `errorResponse(500, err.message)` forwards into the
   * real route — one with an apostrophe in a trailing `// it's the status` comment,
   * one with a `/'/g` regex literal — and both went 48/48 GREEN, because each
   * leaves an odd number of quote characters so the quote-aware scan runs to EOF.
   * 13 sites, 12 extracted, nothing noticed: the positive control is `> 5`.
   * The PARENT version caught both. That is a regression introduced by the fix,
   * on the TIER-1 guard for an unauthenticated public download route.
   */
  function callArgLists(src: string): (string[] | null)[] {
    const out: (string[] | null)[] = [];
    const open = CALL_SITE();
    for (let m = open.exec(src); m; m = open.exec(src)) {
      const lparen = src.indexOf('(', m.index);
      // 🔴 The SAME fallback `bracedBodies` uses in the ledger, for the same
      // reason: an unterminated quote must not make the scan emit nothing, because
      // silence is the worse failure direction. Third time this lesson has come
      // up in this file family — hence reusing the shape rather than re-deriving.
      out.push(scanCallArgs(src, lparen, true) ?? scanCallArgs(src, lparen, false));
    }
    return out;
  }

  function callArgs(src: string): string[] {
    return callArgLists(src)
      .map((args) => (args && args.length >= 2 ? args[1] : null))
      .filter((a): a is string => a !== null);
  }

  /**
   * Split an argument list at its TOP-LEVEL commas, honouring nesting and quotes.
   *
   * Quote-aware for the same reason `scanBody` is in the ledger: a `)` or a `,`
   * inside a message literal would otherwise cut the argument short, and a
   * truncated argument fails `isCallerFacingText` — i.e. it goes RED on safe code,
   * which is the failure direction that teaches the next author to edit the guard.
   */
  function scanCallArgs(src: string, lparen: number, quoteAware: boolean): string[] | null {
    const args: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let argStart = lparen + 1;
    for (let i = lparen; i < src.length; i++) {
      const ch = src[i];
      if (quoteAware && quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (quoteAware && (ch === "'" || ch === '"' || ch === '`')) {
        quote = ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          args.push(src.slice(argStart, i));
          return args.map((a) => a.trim());
        }
      } else if (ch === ',' && depth === 1) {
        args.push(src.slice(argStart, i));
        argStart = i + 1;
      }
    }
    return null;
  }

  it('sees the call sites at all (positive control — a zero here proves nothing)', () => {
    // 🔴 A regex that matches nothing satisfies "no call site forwards an error"
    // perfectly. Prove the instrument can see before believing what it reports.
    expect(
      callArgs(source).length,
      'no errorResponse call sites found — the guard is inert'
    ).toBeGreaterThan(5);
  });

  it('COUNT PARITY: every `errorResponse(` occurrence yields a message argument', () => {
    // 🔴 The assertion that makes a SILENT DROP LOUD, and the only one here that
    // does not depend on the scanner being correct. `> 5` cannot see a drop: an
    // audit injected a 13th site the scan choked on, 12 were extracted, and
    // 12 > 5 so the suite stayed green while a live `err.message` forward went
    // uninspected. Counting the raw occurrences and demanding the same number of
    // extracted arguments is scanner-independent — whatever the scan does, it must
    // account for every site it was pointed at.
    const occurrences = [...source.matchAll(CALL_SITE())].length;
    const lists = callArgLists(source);

    expect(occurrences, 'the occurrence counter itself must see the sites').toBeGreaterThan(5);
    expect(lists.length, 'one entry per occurrence').toBe(occurrences);
    expect(
      lists.filter((l) => l === null).length,
      'a call site the scanner could not parse — it would be silently EXEMPT from ' +
        'the message check below. Do not filter it out; make the scan handle it.'
    ).toBe(0);
    expect(
      callArgs(source).length,
      'a site was dropped between parsing and the message check'
    ).toBe(occurrences);
  });

  it('CAN detect a forwarded error (negative control on the detector itself)', () => {
    const bad = `return errorResponse(500, err.message);\n`;
    const args = callArgs(bad);
    expect(args).toEqual(['err.message']);
    expect(args.some(isCallerFacingText), 'the detector must reject `err.message`').toBe(false);
  });

  it('extracts the message whatever the STATUS expression looks like', () => {
    // 🔴 Every version of this guard so far has been defeated here, one shape at a
    // time. All three must yield the same message argument.
    expect(callArgs(`return errorResponse(500, err.message);\n`)).toEqual(['err.message']);
    // (a) a variable status — defeated the `\d{3}` group
    expect(
      callArgs(`return errorResponse(status, err.message);\n`),
      'a variable status must not hide the call site'
    ).toEqual(['err.message']);
    // (b) a CALL as the status — defeated the `[^,)]+` group, which cannot cross
    //     the `)`. `tensor-metadata.ts` already has this exact helper.
    expect(
      callArgs(`return errorResponse(getStatusCode(fileResult.status), err.message);\n`),
      'a call-expression status must not hide the call site'
    ).toEqual(['err.message']);
    // (c) a comma INSIDE the message must not split the argument early.
    expect(
      callArgs(`return errorResponse(400, 'Missing id, try again');\n`),
      'a comma inside the message must not truncate it'
    ).toEqual([`'Missing id, try again'`]);
    // …and the definition itself is never treated as a call site.
    expect(callArgs(`function errorResponse(status: number, message: string) {\n`)).toEqual([]);
  });

  it('an ODD number of quote characters must not make a site vanish', () => {
    // 🔴 The two shapes an audit used to walk a LIVE `err.message` forward past
    // this guard. Both leave an unbalanced quote inside the argument list, so the
    // quote-aware scan runs to EOF and returned null — and the old `callArgs`
    // dropped the site rather than reporting it. Asserted on the extracted VALUE,
    // not merely on the count, so a fallback that "returns something" is not
    // enough: it has to return the right thing.
    // NB the extracted argument keeps a TRAILING `//` comment, because
    // `stripComments` deliberately drops only whole-line ones — a `//` inside
    // `'https://…'` must not be mangled (the same reasoning as the ledger's
    // `stripLineComments`). That is fine and is the point: what the guard owes is
    // that the site is SEEN and REJECTED, not that the text is pretty.
    const apostropheInComment = `return errorResponse(\n  500, // it's the status\n  err.message\n);\n`;
    expect(
      callArgLists(apostropheInComment).filter((l) => l === null),
      'must not be dropped'
    ).toEqual([]);
    expect(callArgs(apostropheInComment).length, 'an apostrophe in a trailing comment').toBe(1);
    expect(callArgs(apostropheInComment)[0]).toContain('err.message');
    expect(
      callArgs(apostropheInComment).every(isCallerFacingText),
      'and it must be REJECTED — this is what turns the guard red'
    ).toBe(false);

    const regexLiteral = `return errorResponse(500, err.message.replace(/'/g, ''));\n`;
    expect(
      callArgLists(regexLiteral).filter((l) => l === null),
      'must not be dropped'
    ).toEqual([]);
    expect(callArgs(regexLiteral).length, 'a regex literal containing a quote').toBe(1);
    expect(callArgs(regexLiteral)[0]).toContain('err.message');
    expect(callArgs(regexLiteral).every(isCallerFacingText)).toBe(false);

    // The counterpart: neither site may be silently dropped either.
    expect(callArgLists(apostropheInComment).filter((l) => l === null)).toEqual([]);
    expect(callArgLists(regexLiteral).filter((l) => l === null)).toEqual([]);
  });

  it('an escaped quote inside a message does not truncate the argument', () => {
    // 🔴 What makes `scanCallArgs`'s escape-skip OBSERVABLE, and it took two tries
    // to find a shape that discriminates — worth stating, because the first one
    // looked like coverage and was not.
    //
    // Without the escape-skip the quote-aware pass closes the string early at the
    // `\'`, runs to EOF, and the quote-blind FALLBACK then takes over. The fallback
    // usually lands correctly anyway, which masks the bug: with `'it\'s (bad)'` the
    // parens balance and both versions return the same argument, so that exemplar
    // killed nothing (measured — the mutant survived 51/51).
    //
    // It only becomes observable when the literal contains an UNBALANCED delimiter
    // the quote-blind scan will act on. A comma is the realistic one, and it is an
    // ordinary message: the fallback splits the argument there, yielding
    // `'That didn\'t work` — not a complete literal, so the guard goes RED ON SAFE
    // CODE. That failure direction is the whole reason the escape-skip exists.
    //
    // No `errorResponse` argument on the real route contains an escaped quote, so
    // against `source` this branch is unreachable; this exemplar is what gives it
    // an observable behaviour at all.
    const escaped = String.raw`return errorResponse(400, 'That didn\'t work, try again');` + '\n';
    expect(callArgs(escaped), 'the whole literal, comma and escape included').toEqual([
      String.raw`'That didn\'t work, try again'`,
    ]);
    expect(callArgs(escaped).every(isCallerFacingText), 'and it is text we wrote').toBe(true);
  });

  it('accepts the literals we DID write, and rejects assembled ones', () => {
    // 🔴 The reject half is the security property; the accept half is what keeps
    // the guard usable. A previous version scanned the whole argument for `+`/`${`
    // INCLUDING inside the quotes, so both of the first two went red on safe code.
    expect(isCallerFacingText(`"You don't have access to this file"`)).toBe(true);
    expect(isCallerFacingText(`'Try again in 5+ minutes'`)).toBe(true);
    expect(isCallerFacingText(`'it\\'s fine'`), 'an escaped quote is one literal').toBe(true);
    expect(isCallerFacingText('`We have noticed unusual downloading`')).toBe(true);
    expect(isCallerFacingText(`'File not found'`)).toBe(true);
    expect(isCallerFacingText('GENERIC_SERVER_ERROR_MESSAGE')).toBe(true);

    expect(
      isCallerFacingText(`'Error: ' + err.message + ''`),
      'a concatenated value is not text we wrote'
    ).toBe(false);
    expect(isCallerFacingText('`prefix ${err.message}`')).toBe(false);
    expect(isCallerFacingText('err.message')).toBe(false);
    expect(isCallerFacingText('message')).toBe(false);
  });

  it('does not read a single-line /* */ comment as live code', () => {
    // 🔴 Drives `stripComments` — the SAME function the `source` pipeline above
    // uses — not an inline copy of its regex. The previous version of this test
    // asserted against a private copy, so deleting the strip from production left
    // it green.
    const commented = `/* return errorResponse(500, err.message); */\nreturn errorResponse(500, 'ok');\n`;
    expect(callArgs(stripComments(commented))).toEqual([`'ok'`]);
    // And the `//` half, which had the same exposure.
    expect(callArgs(stripComments(`// return errorResponse(500, err.message);\n`))).toEqual([]);
  });

  it('the production `source` IS the stripped file — the pipeline, not a copy', () => {
    // Two distinct failure modes, and each needs its own assertion:
    //
    //  (a) the strip stops working  -> the `/* */` and `//` cases above go red,
    //      because they now drive `stripComments` itself (verified by mutation).
    //  (b) the PIPELINE stops calling it -> nothing above would notice, because
    //      those tests pass their own input. This identity pins that `source` is
    //      the stripped file and not the raw one.
    expect(source, '`source` is not the output of `stripComments` — the pipeline diverged').toBe(
      stripComments(readFileSync(ROUTE, 'utf8'))
    );

    // And the one end-to-end statement that CAN fail on real content: the route's
    // own comment quotes `errorResponse(500, err.message)` verbatim, so if
    // comment-stripping stops reaching the live scan this goes red.
    //
    // Positive control first — without it, "the comment did not reach the scan" is
    // also what you get when the comment no longer exists.
    expect(
      readFileSync(ROUTE, 'utf8'),
      'the exemplar comment is gone — this assertion no longer discriminates'
    ).toContain('errorResponse(500, err.message)');
    // 🔴 Exact-element, not `.includes('.message')`. The substring form went RED on
    // a literal we wrote (`'Your request is missing a .message field'`) and blamed
    // comment-stripping for it — failing loud on safe code AND pointing the next
    // author at the wrong cause.
    expect(
      callArgs(source),
      'a commented-out `err.message` call reached the live scan'
    ).not.toContain('err.message');

    // 🔴 NOT asserted: that `source` contains no `/* … */`. The route file has
    // ZERO block comments, so such an assertion cannot fail on this input and
    // would be exactly the vacuity this suite exists to remove. The `/* */`
    // behaviour is pinned on constructed input above instead, where it discriminates.
  });

  it('every call site passes a string literal or the shared generic constant', () => {
    for (const arg of callArgs(source))
      expect(
        isCallerFacingText(arg),
        `errorResponse called with \`${arg}\` — that is not text we wrote`
      ).toBe(true);
  });

  /**
   * Text WE authored: a quoted literal (incl. a template with no `${}`), or the
   * shared `GENERIC_SERVER_ERROR_MESSAGE` constant. Anything else — a `.message`,
   * a bare identifier, an interpolation — is rejected. Deliberately an allowlist:
   * the denylist version of this is what a name heuristic is, and a name heuristic
   * is what hid this route in the first place.
   */
  function isCallerFacingText(arg: string): boolean {
    if (arg === 'GENERIC_SERVER_ERROR_MESSAGE') return true;
    // The argument must be ONE COMPLETE literal and nothing else. That rejects
    // concatenation and interpolation structurally, by what the value IS.
    //
    // 🔴 The previous version tested the WHOLE argument for `+` or `${`, including
    // the text inside the quotes — so it went RED on messages we did write:
    // `errorResponse(403, "You don't have access to this file")` and
    // `errorResponse(429, 'Try again in 5+ minutes')` both failed. The live route
    // escapes only by accident, because its apostrophe message happens to use a
    // backtick. A guard that fails LOUD ON SAFE CODE is how a security guard gets
    // weakened: the next author edits the guard, not the code.
    //
    // Matching a complete literal instead means an apostrophe or a `+` inside the
    // text is just a character, while `'Error: ' + err.message + ''` leaves residue
    // outside the literal and cannot match. Escapes are honoured so `'it\'s'` is
    // one literal, not two.
    return (
      /^'(?:[^'\\]|\\.)*'$/.test(arg) ||
      /^"(?:[^"\\]|\\.)*"$/.test(arg) ||
      // Template: any char but a backtick/backslash/`$`, an escape, or a `$` that
      // does NOT open an interpolation.
      /^`(?:[^`\\$]|\\.|\$(?!\{))*`$/.test(arg)
    );
  }
});
