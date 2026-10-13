import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { logToAxiom, markServerFaultLogged } from '~/server/logging/client';
// Namespace import so this file still collects on a tree without the counter export.
import * as httpErrors from '~/server/prom/http-errors';
import {
  __resetTrpcBatchMetricsForTest,
  isTrpcBatchOverCap,
} from '~/server/prom/trpc-batch.metrics';
import { getTrpcMaxBatchSize } from '~/server/trpc/batch-cap';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { TRPC_MAX_BATCH_SIZE } from '~/shared/constants/trpc.constants';
import client from 'prom-client';

/**
 * BEHAVIOURAL coverage for the wiring inside `src/pages/api/trpc/[trpc].ts`.
 *
 * 🔴 WHY THIS FILE EXISTS. Three properties of that route — the cap it hands the adapter, that
 * it instruments the request before delegating, and that its `onError` consults the log-storm
 * skip — used to be pinned by matching the route's SOURCE TEXT. Every one of those regexes was
 * walked by wrapping the real line in a block comment: the code was gone, the string was still
 * in the file, and the suite stayed green — including for the mutant that removes the cap
 * entirely. A source-text guard asserts SPELLING, and spelling survives being commented out.
 *
 * The assertions below read values the module actually produced and effects it actually had, so
 * there is nothing to spell around: comment the line out and the property is `undefined`, or the
 * call never happens, and the assertion written for it fails by name.
 *
 * The route IS loadable in a unit test — the earlier claim that it is not was wrong. Its module
 * graph pulls `appRouter` and `createContext`, and both are mockable; the adapter is mocked too,
 * so what is under test is exactly the options object and handler this file constructs.
 */

/** Only the parts of the adapter options this file asserts on. */
type CapturedOptions = {
  maxBatchSize?: number;
  allowMethodOverride?: boolean;
  onError?: (opts: Record<string, unknown>) => unknown;
  responseMeta?: (opts: Record<string, unknown>) => { headers?: Record<string, string> };
};

const h = vi.hoisted(() => ({
  /** The options object the route hands `createNextApiHandler`. */
  options: undefined as CapturedOptions | undefined,
  /** Stands in for the adapter's handler, so "did the route delegate, and when" is observable. */
  inner: vi.fn(),
  /** Whether the request was ALREADY marked over-cap at the moment the route delegated. */
  markedAtDelegation: undefined as boolean | undefined,
}));

vi.mock('~/server/routers', () => ({ appRouter: { __testRouter: true } }));
vi.mock('~/server/createContext', () => ({ createContext: vi.fn() }));
// withAxiom is a transparent wrapper here; the route's own body is what is under test.
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('@trpc/server/adapters/next', () => ({
  createNextApiHandler: (options: CapturedOptions) => {
    h.options = options;
    return h.inner;
  },
}));
// The route's Axiom ingest is `isProd`-gated, so without this the whole branch under test is
// unreachable and the skip assertions below would pass for the wrong reason.
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

const res = {} as NextApiResponse;
let route: NextApiHandler;

/**
 * A cap deliberately DIFFERENT from `TRPC_MAX_BATCH_SIZE`, applied to the env before the route
 * module is evaluated. The route resolves `maxBatchSize` once, at module scope — so asserting it
 * equals this value (and not the constant) distinguishes "resolves the env-backed cap" from
 * "hardcodes the compiled-in number", which are the same 30 in every other test here.
 */
const ROUTE_LOAD_CAP = 17;

/** A request shaped the way Next populates `[trpc]`: decoded dynamic segment + search params. */
const request = (width: number) =>
  ({
    method: 'GET',
    headers: {},
    query: { trpc: Array(width).fill('a').join(','), batch: '1' },
  } as unknown as NextApiRequest);

describe('src/pages/api/trpc/[trpc].ts wiring', () => {
  beforeAll(async () => {
    h.inner.mockImplementation((req: NextApiRequest) => {
      h.markedAtDelegation = isTrpcBatchOverCap(req);
    });
    setEnv({ TRPC_MAX_BATCH_SIZE: ROUTE_LOAD_CAP });
    route = (await import('~/pages/api/trpc/[trpc]')).default;
    // Cleared immediately: every per-request assertion below is against the DEFAULT cap, which
    // the metric resolves per call. Only the adapter options were frozen at import time.
    resetEnv();
  });

  beforeEach(() => {
    __resetTrpcBatchMetricsForTest();
    h.inner.mockClear();
    h.markedAtDelegation = undefined;
    vi.mocked(logToAxiom).mockClear();
  });

  // -------------------------------------------------------------------------
  // The cap actually reaches the adapter
  // -------------------------------------------------------------------------

  it('hands the adapter a maxBatchSize resolved from the env-backed cap', () => {
    // Reads the VALUE the route produced. Commenting the line out makes this `undefined`, which
    // is how tRPC spells "no cap at all" — the single most consequential mutant in this PR.
    expect(h.options?.maxBatchSize).toBe(ROUTE_LOAD_CAP);
    // …and not the compiled-in constant, so a hardcoded `maxBatchSize: 30` — which would look
    // right and silently ignore the env override the rollback path depends on — fails here.
    expect(h.options?.maxBatchSize).not.toBe(TRPC_MAX_BATCH_SIZE);
    expect(Number.isInteger(h.options?.maxBatchSize)).toBe(true);
    expect(h.options?.maxBatchSize).toBeGreaterThan(0);
  });

  it('with no override, that same resolution is the compiled-in constant', () => {
    // The control for the case above: it is an OVERRIDE that moved the number, not a coincidence.
    expect(getTrpcMaxBatchSize()).toBe(TRPC_MAX_BATCH_SIZE);
  });

  it('keeps allowMethodOverride on (a POST query is a supported shape, and is capped too)', () => {
    expect(h.options?.allowMethodOverride).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The request is instrumented BEFORE the adapter sees it
  // -------------------------------------------------------------------------

  it('marks an over-cap request BEFORE delegating to the tRPC handler', async () => {
    const req = request(TRPC_MAX_BATCH_SIZE + 1);
    await route(req, res);

    expect(h.inner).toHaveBeenCalledTimes(1);
    expect(h.inner).toHaveBeenCalledWith(req, res);
    // ORDERING, not just occurrence: this is read INSIDE the delegate, so an instrument call
    // moved after the delegation (or deleted) fails here.
    expect(h.markedAtDelegation).toBe(true);
    expect(isTrpcBatchOverCap(req)).toBe(true);
  });

  it('does not mark an under-cap request, but still delegates it', async () => {
    const req = request(TRPC_MAX_BATCH_SIZE);
    await route(req, res);

    expect(h.inner).toHaveBeenCalledTimes(1);
    expect(h.markedAtDelegation).toBe(false);
    expect(isTrpcBatchOverCap(req)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // onError consults the skip predicate — asserted by what it does, not what it says
  // -------------------------------------------------------------------------

  const capRejection = () =>
    new TRPCError({ code: 'BAD_REQUEST', message: 'Batch call exceeds maximum size' });

  const callOnError = (req: NextApiRequest, error: TRPCError) =>
    h.options?.onError?.({ error, type: 'query', path: undefined, input: undefined, ctx: {}, req });

  it('skips the Axiom ingest for a request the instrument marked over-cap', async () => {
    const req = request(TRPC_MAX_BATCH_SIZE + 1);
    await route(req, res); // marks it, exactly as production does
    vi.mocked(logToAxiom).mockClear();

    await callOnError(req, capRejection());
    expect(vi.mocked(logToAxiom)).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: an identical BAD_REQUEST on an UNMARKED request IS ingested', async () => {
    // Without this, "not called" above is indistinguishable from an onError wired to nothing —
    // and from an `isProd` gate that never opened. Same error, same shape, one variable changed.
    const req = request(2);
    await route(req, res); // under cap => not marked

    await callOnError(req, capRejection());
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
  });

  it('still ingests a non-BAD_REQUEST error on a marked request (the skip stays narrow)', async () => {
    const req = request(TRPC_MAX_BATCH_SIZE + 1);
    await route(req, res);
    vi.mocked(logToAxiom).mockClear();

    await callOnError(req, new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' }));
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Allowlisted-404 skip: image.getGenerationData NOT_FOUND is counted, not logged
  // -------------------------------------------------------------------------

  const GEN_DATA = 'image.getGenerationData';

  const callOnErrorAt = (path: string, error: TRPCError) =>
    h.options?.onError?.({
      error,
      type: 'query',
      path,
      input: { id: 1 },
      ctx: {},
      req: request(2),
    });

  /** The skipped case's counter value, read off the real module (http-errors is not mocked). */
  const unloggedCount = async (path: string, code: string) => {
    // Absent counter reads as 0 so the [invariant] controls below fail only on their own
    // assertions; the skip case still needs a real +1, so a missing counter cannot pass it.
    const counter = httpErrors.trpcUnloggedClientErrorCounter as
      | typeof httpErrors.trpcUnloggedClientErrorCounter
      | undefined;
    if (!counter) return 0;
    const metric = await counter.get();
    const values = metric.values as { value: number; labels: Record<string, string | number> }[];
    return values.find((v) => v.labels.path === path && v.labels.code === code)?.value ?? 0;
  };

  it('does NOT ingest a NOT_FOUND from image.getGenerationData, and counts it instead', async () => {
    const before = await unloggedCount(GEN_DATA, 'NOT_FOUND');

    await callOnErrorAt(GEN_DATA, new TRPCError({ code: 'NOT_FOUND', message: 'none' }));

    expect(vi.mocked(logToAxiom)).not.toHaveBeenCalled();
    expect(await unloggedCount(GEN_DATA, 'NOT_FOUND')).toBe(before + 1);
  });

  it('[invariant] POSITIVE CONTROL: a NOT_FOUND from any other procedure IS still ingested', async () => {
    // Same code, same input shape, one variable changed (the path). Without this, "not called"
    // above is indistinguishable from an onError that never reaches the ingest at all.
    const before = await unloggedCount(GEN_DATA, 'NOT_FOUND');

    await callOnErrorAt('image.get', new TRPCError({ code: 'NOT_FOUND', message: 'none' }));

    expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'image.get' }),
      'civitai-prod'
    );
    expect(await unloggedCount(GEN_DATA, 'NOT_FOUND')).toBe(before);
  });

  it.each(['INTERNAL_SERVER_ERROR', 'BAD_REQUEST'] as const)(
    '[invariant] still ingests %s from image.getGenerationData (the skip is NOT_FOUND only)',
    async (code) => {
      await callOnErrorAt(GEN_DATA, new TRPCError({ code, message: 'boom' }));
      expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
        expect.objectContaining({ path: GEN_DATA }),
        'civitai-prod'
      );
    }
  );

  // -------------------------------------------------------------------------
  // A masked error's ref reaches the log line
  // -------------------------------------------------------------------------

  const driverError = () =>
    new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      cause: new Prisma.PrismaClientUnknownRequestError(
        'Invalid `prisma.apiKey.create()` invocation: cannot execute INSERT in a read-only transaction',
        { clientVersion: '6.13.0' }
      ),
    });

  it('logs a masked error with the errorRef the user was shown', async () => {
    const error = driverError();
    await callOnError(request(2), error);

    const errorRef = getClientSafeError(error)?.errorRef;
    expect(errorRef).toMatch(/^[0-9a-f]{12}$/);
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ errorRef }),
      'civitai-prod'
    );
  });

  it('logs a masked error even when a router already logged it, since that line has no ref', async () => {
    const error = driverError();
    markServerFaultLogged(error);
    await callOnError(request(2), error);

    expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: an unmasked error a router already logged is not logged again', async () => {
    const error = new TRPCError({ code: 'CONFLICT', message: 'boom' });
    markServerFaultLogged(error);
    await callOnError(request(2), error);

    expect(vi.mocked(logToAxiom)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Block-token queries: never publicly cacheable, token redacted from logs, GETs counted
  // -------------------------------------------------------------------------
  //
  // The paths are spelled out here rather than imported from the shared constant, so these
  // assertions do not depend on that module existing (they must FAIL, not fail to collect, on a
  // tree without the fix) and so a path silently dropped from the constant reads as a failure.

  const BLOCK_TOKEN_QUERIES = [
    'apps.shared.get',
    'apps.shared.getCount',
    'apps.shared.getCounts',
    'apps.shared.list',
    'apps.storage.get',
    'apps.storage.getQuota',
    'apps.storage.list',
    'blocks.listMyWorkflows',
  ] as const;

  const TOKEN = 'header.payload.signature-test-token';

  /** The cache `createContext` seeds for a SESSIONLESS caller — the publicly cacheable case. */
  const sessionlessCache = () => ({
    browserTTL: 60,
    edgeTTL: 60,
    staleWhileRevalidate: 30,
    canCache: true,
    skip: false,
  });

  const callResponseMeta = (paths: string[], errors: unknown[] = []) => {
    const removeHeader = vi.fn();
    const meta = h.options?.responseMeta?.({
      ctx: { cache: sessionlessCache(), res: { removeHeader } },
      type: 'query',
      errors,
      paths,
      info: { calls: paths.map((path) => ({ path })) },
      data: [],
      eagerGeneration: false,
    });
    return { headers: meta?.headers ?? {}, removeHeader };
  };

  it.each(BLOCK_TOKEN_QUERIES)(
    'responseMeta: a sessionless error-free %s gets no-store, never a public header',
    (path) => {
      const { headers, removeHeader } = callResponseMeta([path]);
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['Cache-Tag']).toBeUndefined();
      expect(removeHeader).not.toHaveBeenCalled();
    }
  );

  it('responseMeta: a block-token query that errored still gets no-store', () => {
    const { headers } = callResponseMeta(
      ['apps.storage.get'],
      [new TRPCError({ code: 'NOT_FOUND', message: 'none' })]
    );
    expect(headers['Cache-Control']).toBe('no-store');
  });

  it('responseMeta: a batch mixing a block-token query with a public one is no-store', () => {
    const { headers } = callResponseMeta(['model.getAll', 'apps.shared.list']);
    expect(headers['Cache-Control']).toBe('no-store');
  });

  it('POSITIVE CONTROL: responseMeta keeps the public header for an ordinary sessionless query', () => {
    // Same cache, same shape, one variable changed (the path). Without this, "no-store" above is
    // indistinguishable from a responseMeta that stopped emitting public headers altogether.
    const { headers, removeHeader } = callResponseMeta(['model.getAll']);
    expect(headers['Cache-Control']).toBe(
      'public, max-age=60, s-maxage=60, stale-while-revalidate=30'
    );
    expect(removeHeader).toHaveBeenCalledWith('Set-Cookie');
  });

  /** The single `input` string the route handed `logToAxiom`. */
  const loggedInput = () => {
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(logToAxiom).mock.calls[0] as [Record<string, unknown>];
    return payload.input as string | undefined;
  };

  it.each(['NOT_FOUND', 'BAD_REQUEST', 'INTERNAL_SERVER_ERROR'] as const)(
    'onError: a %s on a token-bearing input logs blockToken redacted, key kept',
    async (code) => {
      await h.options?.onError?.({
        error: new TRPCError({ code, message: 'boom' }),
        type: 'query',
        path: 'apps.storage.get',
        input: { blockToken: TOKEN, key: 'k' },
        ctx: {},
        req: request(2),
      });
      const input = loggedInput();
      expect(input).toBeDefined();
      expect(input).not.toContain(TOKEN);
      expect(JSON.parse(input as string)).toEqual({ blockToken: '[redacted]', key: 'k' });
    }
  );

  it('onError: a token nested in a mutation input is redacted too', async () => {
    await h.options?.onError?.({
      error: new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' }),
      type: 'mutation',
      path: 'blocks.submitWorkflow',
      input: { blockToken: TOKEN, steps: [{ inner: { blockToken: TOKEN } }] },
      ctx: {},
      req: request(2),
    });
    const input = loggedInput();
    expect(input).not.toContain(TOKEN);
    expect(JSON.parse(input as string)).toEqual({
      blockToken: '[redacted]',
      steps: [{ inner: { blockToken: '[redacted]' } }],
    });
  });

  it('POSITIVE CONTROL: onError logs an input without a token verbatim', async () => {
    await h.options?.onError?.({
      error: new TRPCError({ code: 'NOT_FOUND', message: 'none' }),
      type: 'query',
      path: 'image.get',
      input: { id: 1, note: TOKEN },
      ctx: {},
      req: request(2),
    });
    // A field that merely CONTAINS token-like text is not a `blockToken` field: left as-is, so
    // the redaction is keyed on the field, not on a pattern that could eat unrelated input.
    expect(JSON.parse(loggedInput() as string)).toEqual({ id: 1, note: TOKEN });
  });

  /** Read the GET counter off the default registry by NAME (absent on a tree without it ⇒ 0). */
  const getCount = async (path: string) => {
    const metric = client.register.getSingleMetric('civitai_app_block_token_get_requests_total');
    if (!metric) return 0;
    const { values } = await metric.get();
    return values.find((v) => v.labels.path === path)?.value ?? 0;
  };

  const tokenRequest = (method: string, trpc: string, input?: string) =>
    ({
      method,
      headers: {},
      query: { trpc, ...(input === undefined ? {} : { input }) },
    } as unknown as NextApiRequest);

  const TOKEN_INPUT = JSON.stringify({ json: { blockToken: TOKEN, key: 'k' } });

  it('counter: a GET carrying a block token increments its procedure', async () => {
    const before = await getCount('apps.storage.get');
    await route(tokenRequest('GET', 'apps.storage.get', TOKEN_INPUT), res);
    expect(await getCount('apps.storage.get')).toBe(before + 1);
  });

  it('counter: a POST to the same procedure does not increment', async () => {
    // The current client sends these as POST (input in the body, so `req.query.input` is absent
    // in production). The query input is set here anyway, so this case varies ONLY the method.
    const before = await getCount('apps.storage.get');
    await route(tokenRequest('POST', 'apps.storage.get', TOKEN_INPUT), res);
    expect(await getCount('apps.storage.get')).toBe(before);
  });

  it('counter: a batched GET counts only its block-token calls', async () => {
    const beforeList = await getCount('apps.shared.list');
    const beforeWorkflows = await getCount('blocks.listMyWorkflows');
    const input = JSON.stringify({
      0: { json: { limit: 1 } },
      1: { json: { blockToken: TOKEN } },
      2: { json: { blockToken: TOKEN } },
    });
    await route(
      tokenRequest('GET', 'model.getAll,apps.shared.list,blocks.listMyWorkflows', input),
      res
    );
    expect(await getCount('apps.shared.list')).toBe(beforeList + 1);
    expect(await getCount('blocks.listMyWorkflows')).toBe(beforeWorkflows + 1);
    expect(await getCount('model.getAll')).toBe(0);
  });

  it('counter: a GET to a block-token procedure with no token in the URL does not increment', async () => {
    const before = await getCount('apps.storage.getQuota');
    await route(tokenRequest('GET', 'apps.storage.getQuota', JSON.stringify({ json: {} })), res);
    expect(await getCount('apps.storage.getQuota')).toBe(before);
  });
});
