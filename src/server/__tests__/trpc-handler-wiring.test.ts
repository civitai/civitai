import { TRPCError } from '@trpc/server';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { logToAxiom } from '~/server/logging/client';
import {
  __resetTrpcBatchMetricsForTest,
  isTrpcBatchOverCap,
} from '~/server/prom/trpc-batch.metrics';
import { getTrpcMaxBatchSize } from '~/server/trpc/batch-cap';
import { TRPC_MAX_BATCH_SIZE } from '~/shared/constants/trpc.constants';

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
});
