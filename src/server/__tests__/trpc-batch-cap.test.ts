import { readFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import type { AddressInfo } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTRPC } from '@trpc/server';
import { createNextApiHandler } from '@trpc/server/adapters/next';
import client from 'prom-client';
import { z } from 'zod';

import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import {
  TRPC_MAX_BATCH_SIZE,
  OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH,
} from '~/shared/constants/trpc.constants';
import { getTrpcMaxBatchSize } from '~/server/trpc/batch-cap';
import {
  __resetTrpcBatchMetricsForTest,
  boundedClientLabel,
  computeBatchWidth,
  instrumentTrpcBatchRequest,
  isTrpcBatchOverCap,
  markTrpcBatchOverCap,
  observeTrpcBatchWidth,
  shouldSkipBatchCapLog,
  TRPC_BATCH_WIDTH_BUCKETS,
  trpcBatchWidthHistogram,
} from '~/server/prom/trpc-batch.metrics';

/**
 * Coverage for the tRPC BATCH-WIDTH CAP.
 *
 * tRPC batching lets one HTTP request carry N procedure calls, so request rate stops being a
 * proxy for work: rate limits, connection caps and per-request timeouts all see 1 where the
 * server does N, and N is chosen by whoever builds the URL. `TRPC_MAX_BATCH_SIZE` bounds N.
 *
 * The cap is only worth having if rejection is CHEAP, which requires it to happen before any
 * per-request setup. tRPC rejects inside `getRequestInfo`, before `ctxManager.create()` — so
 * the tests below assert not just the 400 but that ZERO procedures resolved and NO context was
 * created. A status-code assertion alone would pass just as happily if the server had built a
 * session, hit the DB for every one of 200 calls, and then returned 400.
 *
 * Lives in `src/server/__tests__/` rather than beside the route: `next build` fails on test
 * files under `src/pages` (see `by-hash-ids-endpoint.test.ts`).
 */

// ---------------------------------------------------------------------------
// Harness: a real node:http server, so `req`/`res` are genuine Node objects and
// the adapter's stream handling, status writing and error envelope are all real.
// ---------------------------------------------------------------------------

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

/**
 * Populate `req.query` the way Next populates it for the dynamic route `pages/api/trpc/[trpc]`:
 * the single `[trpc]` segment (decoded) plus the search params. For a POST it also drains and
 * JSON-parses the body onto `req.body`, which is what Next's `bodyParser` does before the route
 * runs — and which puts the adapter on its `"body" in req` path (`JSON.stringify(req.body)`),
 * i.e. the same parse-then-re-stringify production pays. Nothing else about the request is
 * synthesised: it is a real `IncomingMessage` off a real socket.
 */
function serveHandler(handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const trpc = decodeURIComponent(url.pathname.replace(/^\/api\/trpc\//, ''));
    const query: Record<string, string | string[]> = { trpc };
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      query[key] = all.length > 1 ? all : all[0];
    }
    (req as unknown as NextApiRequest).query = query;

    if (req.method === 'GET' || req.method === 'HEAD') {
      void (handler as (r: unknown, s: unknown) => unknown)(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        (req as unknown as NextApiRequest).body = raw ? JSON.parse(raw) : undefined;
      } catch {
        (req as unknown as NextApiRequest).body = raw;
      }
      void (handler as (r: unknown, s: unknown) => unknown)(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

/** Build a batched tRPC GET URL of exactly `width` calls to `path`. */
function batchUrl(base: string, path: string, width: number) {
  const paths = Array.from({ length: width }, () => path).join(',');
  const input = JSON.stringify(
    Object.fromEntries(Array.from({ length: width }, (_, i) => [i, { n: i }]))
  );
  return `${base}/api/trpc/${paths}?batch=1&input=${encodeURIComponent(input)}`;
}

/**
 * The same batch as a POST, which `allowMethodOverride: true` makes a legitimate shape for a
 * QUERY: the path list stays in the URL, the inputs move into the body. Worth covering
 * separately because the two methods do not cost the same — the body is parsed (and
 * re-stringified by the adapter) before tRPC ever looks at the batch width.
 */
function postBatch(base: string, path: string, width: number) {
  const paths = Array.from({ length: width }, () => path).join(',');
  const body = Object.fromEntries(Array.from({ length: width }, (_, i) => [i, { n: i }]));
  return fetch(`${base}/api/trpc/${paths}?batch=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// A: the cap, on a router whose resolver calls we can count exactly
// ---------------------------------------------------------------------------

describe('maxBatchSize enforcement', () => {
  const resolver = vi.fn(({ input }: { input: { n: number } }) => ({ echoed: input.n }));
  const createContext = vi.fn(() => ({ hello: 'world' }));

  const t = initTRPC.create();
  const router = t.router({
    echo: t.procedure.input(z.object({ n: z.number() })).query(resolver as never),
  });

  let server: Server;
  let base: string;

  beforeAll(async () => {
    const handler = createNextApiHandler({
      router,
      createContext: createContext as never,
      // The value under test, read from the same module production reads.
      maxBatchSize: TRPC_MAX_BATCH_SIZE,
      // Mirrors production (`src/pages/api/trpc/[trpc].ts`), and is what makes a POST QUERY a
      // legitimate shape here rather than a 405 — i.e. what makes the GET/POST symmetry cases
      // below test the cap instead of the method map.
      allowMethodOverride: true,
      onError: () => undefined,
    });
    const started = await serveHandler(handler as Handler);
    server = started.server;
    base = started.url;
  });

  afterAll(async () => {
    await closeServer(server);
  });

  beforeEach(() => {
    resolver.mockClear();
    createContext.mockClear();
  });

  it(`rejects a batch of ${
    TRPC_MAX_BATCH_SIZE + 1
  } with 400 and resolves ZERO procedures`, async () => {
    const res = await fetch(batchUrl(base, 'echo', TRPC_MAX_BATCH_SIZE + 1));
    const body = await res.json();

    expect(res.status).toBe(400);
    // A well-formed tRPC error envelope, not an unshaped crash — the client can surface this.
    // (This router declares no transformer, so the envelope is untransformed; production's
    // transformer wraps the same object one level deeper, under `error.json`.)
    expect(body).toMatchObject({
      error: { message: expect.any(String), data: { code: 'BAD_REQUEST', httpStatus: 400 } },
    });

    // 🔴 The load-bearing half. A 400 alone is compatible with the server having done all the
    // work first; these two are what prove the rejection is free.
    expect(resolver).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
  });

  it(`accepts a batch of exactly ${TRPC_MAX_BATCH_SIZE} and resolves every call`, async () => {
    const res = await fetch(batchUrl(base, 'echo', TRPC_MAX_BATCH_SIZE));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(TRPC_MAX_BATCH_SIZE);
    expect(body[0]).toMatchObject({ result: { data: { echoed: 0 } } });
    expect(resolver).toHaveBeenCalledTimes(TRPC_MAX_BATCH_SIZE);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('accepts the widest batch first-party traffic actually emits', async () => {
    const res = await fetch(batchUrl(base, 'echo', OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH));
    expect(res.status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH);
  });

  it('rejects a very wide batch (the abuse shape) just as cheaply', async () => {
    const res = await fetch(batchUrl(base, 'echo', 200));
    expect(res.status).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
  });

  // 🔴 GET/POST SYMMETRY. `allowMethodOverride: true` makes a POST query batch legitimate, so a
  // cap enforced only on GET would leave the amplification reachable by changing one verb. It
  // is NOT the same cost profile — Next parses the body before the handler and the adapter
  // re-stringifies it, both before the width is checked — but the property that matters (zero
  // procedures resolved, zero contexts created) must hold on both.
  it(`rejects an over-cap POST batch too, resolving ZERO procedures`, async () => {
    const res = await postBatch(base, 'echo', TRPC_MAX_BATCH_SIZE + 1);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: { data: { code: 'BAD_REQUEST', httpStatus: 400 } } });
    expect(resolver).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
  });

  it('accepts an at-cap POST batch and resolves every call (the cap is not method-dependent)', async () => {
    // The control for the case above: same verb, same body shape, width one lower. Without it a
    // POST rejection could just as well mean "POST queries do not work here at all".
    const res = await postBatch(base, 'echo', TRPC_MAX_BATCH_SIZE);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(TRPC_MAX_BATCH_SIZE);
    expect(resolver).toHaveBeenCalledTimes(TRPC_MAX_BATCH_SIZE);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('leaves an UNBATCHED request untouched however long the path is', async () => {
    // No `?batch=1` => not a batch call => the cap does not apply, and the comma-bearing path
    // is one procedure name (which does not exist). Confirms the cap keys on `batch`, not on
    // commas — otherwise a non-batched request could be rejected by counting separators.
    const res = await fetch(`${base}/api/trpc/echo?input=${encodeURIComponent('{"n":1}')}`);
    expect(res.status).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// B: batch-width measurement + the over-cap marker
// ---------------------------------------------------------------------------

const req = (query: Record<string, unknown>, headers: Record<string, unknown> = {}) =>
  ({ query, headers } as unknown as NextApiRequest);

describe('computeBatchWidth', () => {
  it('counts comma-separated calls when batch=1', () => {
    expect(computeBatchWidth(req({ trpc: 'a', batch: '1' }))).toBe(1);
    expect(computeBatchWidth(req({ trpc: 'a,b', batch: '1' }))).toBe(2);
    expect(computeBatchWidth(req({ trpc: 'a,b,c', batch: '1' }))).toBe(3);
  });

  it('agrees with tRPC: no batch=1 means width 1, whatever the path contains', () => {
    expect(computeBatchWidth(req({ trpc: 'a,b,c,d' }))).toBe(1);
    expect(computeBatchWidth(req({ trpc: 'a,b,c,d', batch: '0' }))).toBe(1);
  });

  it('reads the FIRST value of a repeated batch param, as URLSearchParams.get does', () => {
    expect(computeBatchWidth(req({ trpc: 'a,b', batch: ['1', '0'] }))).toBe(2);
    expect(computeBatchWidth(req({ trpc: 'a,b', batch: ['0', '1'] }))).toBe(1);
  });

  it('sums separators across a multi-segment path array', () => {
    // Verified against the adapter rather than assumed: `createNextApiHandler` joins an array
    // `req.query.trpc` with '/', NOT with ',', and tRPC then splits the joined string on ','.
    // So ['a,b','c,d'] -> 'a,b/c,d' -> ['a','b/c','d'] = 3 calls, not 4. Counting separators
    // across the elements reproduces that exactly; treating each element as its own call would
    // over-report by one per extra segment.
    expect(computeBatchWidth(req({ trpc: ['a,b', 'c,d'], batch: '1' }))).toBe(3);
    expect(['a,b', 'c,d'].join('/').split(',').length).toBe(3); // the derivation, pinned
  });

  it('is total on malformed input rather than throwing', () => {
    expect(computeBatchWidth(req({ batch: '1' }))).toBe(1);
    expect(computeBatchWidth({} as NextApiRequest)).toBe(1);
  });

  it('measures the abusive widths the cap exists to reject', () => {
    expect(computeBatchWidth(req({ trpc: Array(150).fill('a').join(','), batch: '1' }))).toBe(150);
    expect(computeBatchWidth(req({ trpc: Array(200).fill('a').join(','), batch: '1' }))).toBe(200);
  });
});

describe('boundedClientLabel', () => {
  it('collapses to exactly three values so a crafted header cannot blow up cardinality', () => {
    expect(boundedClientLabel('web')).toBe('web');
    expect(boundedClientLabel(undefined)).toBe('none');
    const crafted = ['a', 'b', 'c'].map((s) => boundedClientLabel(s.repeat(50)));
    expect(new Set(crafted)).toEqual(new Set(['other']));
    expect(boundedClientLabel(['web', 'spoof'])).toBe('web'); // first value, like a header read
  });
});

describe('over-cap marker', () => {
  it('is false by default and true once marked', () => {
    const r = req({});
    expect(isTrpcBatchOverCap(r)).toBe(false);
    markTrpcBatchOverCap(r);
    expect(isTrpcBatchOverCap(r)).toBe(true);
  });

  it('is per-request: marking one does not mark another', () => {
    const a = req({});
    const b = req({});
    markTrpcBatchOverCap(a);
    expect(isTrpcBatchOverCap(b)).toBe(false);
  });

  it('never throws on a non-object', () => {
    expect(isTrpcBatchOverCap(undefined)).toBe(false);
    expect(isTrpcBatchOverCap(null)).toBe(false);
    expect(() => markTrpcBatchOverCap(null)).not.toThrow();
  });
});

/**
 * 🔴 This block exists because a mutation that DELETED the marking survived a fully green
 * suite. Marking is what arms the log-storm skip, and losing it fails silently — the cap still
 * rejects, the histogram still moves, and every rejected batch quietly resumes paying a stack
 * capture + Axiom ingest. Nothing observable changes except the cost the cap exists to avoid.
 * These are the behavioural pins that now kill that mutant.
 */
describe('instrumentTrpcBatchRequest (observe + mark, in one call)', () => {
  const wide = (width: number) => req({ trpc: Array(width).fill('a').join(','), batch: '1' });

  beforeEach(() => {
    __resetTrpcBatchMetricsForTest();
  });

  it('marks a request ABOVE the cap', () => {
    const r = wide(TRPC_MAX_BATCH_SIZE + 1);
    expect(instrumentTrpcBatchRequest(r)).toBe(TRPC_MAX_BATCH_SIZE + 1);
    expect(isTrpcBatchOverCap(r)).toBe(true);
  });

  it('does NOT mark a request exactly AT the cap', () => {
    const r = wide(TRPC_MAX_BATCH_SIZE);
    expect(instrumentTrpcBatchRequest(r)).toBe(TRPC_MAX_BATCH_SIZE);
    expect(isTrpcBatchOverCap(r)).toBe(false);
  });

  it('does NOT mark an ordinary narrow request', () => {
    const r = req({ trpc: 'a,b,c', batch: '1' });
    instrumentTrpcBatchRequest(r);
    expect(isTrpcBatchOverCap(r)).toBe(false);
  });

  it('observes the width as well as marking (one call does both)', async () => {
    instrumentTrpcBatchRequest(wide(TRPC_MAX_BATCH_SIZE + 1));
    expect(await bucketCount('true', 'none')).toBe(1);
  });

  it('makes the log-skip fire end to end for an over-cap request', () => {
    // The chain the route depends on: instrument -> marker -> skip predicate. Asserting it
    // here means deleting any link fails a test instead of silently reopening the log storm.
    const over = wide(TRPC_MAX_BATCH_SIZE + 1);
    const under = wide(TRPC_MAX_BATCH_SIZE);
    instrumentTrpcBatchRequest(over);
    instrumentTrpcBatchRequest(under);
    expect(shouldSkipBatchCapLog(over, { code: 'BAD_REQUEST' })).toBe(true);
    expect(shouldSkipBatchCapLog(under, { code: 'BAD_REQUEST' })).toBe(false);
  });

  // NOTE: that the ROUTE makes this call, before delegating, is pinned behaviourally in
  // `trpc-handler-wiring.test.ts` — it loads the real route with the adapter mocked and reads
  // the marker from inside the delegate. It used to be a `^\s*…$` source-text match here, which
  // a block comment walked straight through.

  /**
   * 🔴 The catch in `observeTrpcBatchWidth` returns 1, and the DIRECTION of that fallback is a
   * safety property. A telemetry failure that returned a value ABOVE the cap would mark every
   * such request over-cap, arming the `onError` skip and silently suppressing the Axiom ingest
   * for every `BAD_REQUEST` in the process. Forcing the throw is the only way to reach it.
   */
  it('fails SAFE when measurement throws: width <= cap, and the request is not marked', () => {
    const exploding = {
      headers: {},
      get query(): never {
        throw new Error('measurement blew up');
      },
    } as unknown as NextApiRequest;

    expect(() => observeTrpcBatchWidth(exploding)).not.toThrow();
    expect(observeTrpcBatchWidth(exploding)).toBe(1);
    expect(observeTrpcBatchWidth(exploding)).toBeLessThanOrEqual(TRPC_MAX_BATCH_SIZE);

    expect(instrumentTrpcBatchRequest(exploding)).toBeLessThanOrEqual(TRPC_MAX_BATCH_SIZE);
    expect(isTrpcBatchOverCap(exploding)).toBe(false);
    expect(shouldSkipBatchCapLog(exploding, { code: 'BAD_REQUEST' })).toBe(false);
  });
});

describe('shouldSkipBatchCapLog (log-storm guard)', () => {
  const capError = { code: 'BAD_REQUEST' as const };

  it('skips the cap rejection', () => {
    const r = req({});
    markTrpcBatchOverCap(r);
    expect(shouldSkipBatchCapLog(r, capError)).toBe(true);
  });

  // 🔴 NARROWNESS CONTROLS. Each isolates ONE conjunct, so a mutation that drops either is
  // caught here rather than showing up as a silently-swallowed error class in production.
  it('does NOT skip an ordinary BAD_REQUEST on an unmarked request', () => {
    // The blanket-skip mutation ("skip every BAD_REQUEST") fails exactly here — this is a real
    // failed-validation error and it must keep its Axiom ingest.
    expect(shouldSkipBatchCapLog(req({}), capError)).toBe(false);
  });

  it('does NOT skip a non-BAD_REQUEST error on a marked request', () => {
    const r = req({});
    markTrpcBatchOverCap(r);
    for (const code of ['INTERNAL_SERVER_ERROR', 'NOT_FOUND', 'TIMEOUT', 'FORBIDDEN']) {
      expect(shouldSkipBatchCapLog(r, { code })).toBe(false);
    }
  });

  it('does not skip when there is no error or no request', () => {
    expect(shouldSkipBatchCapLog(req({}), undefined)).toBe(false);
    expect(shouldSkipBatchCapLog(undefined, capError)).toBe(false);
  });

  // NOTE: that the route's `onError` actually CONSULTS this predicate — and returns before the
  // Axiom ingest — is pinned behaviourally in `trpc-handler-wiring.test.ts`, by driving the real
  // `onError` and asserting on the canonical `logToAxiom` spy (with the unmarked-request
  // positive control beside it). The source-text version that lived here asserted the statement
  // was SPELLED in the file, which a block comment satisfies with the code deleted.
});

// ---------------------------------------------------------------------------
// C: the metric, with a positive control
// ---------------------------------------------------------------------------

/** Read `civitai_app_trpc_batch_width_count` for one label set (0 when the series is absent). */
async function bucketCount(overLimit: 'true' | 'false', client = 'web'): Promise<number> {
  const metric = await trpcBatchWidthHistogram.get();
  const row = metric.values.find(
    (v) =>
      v.metricName === 'civitai_app_trpc_batch_width_count' &&
      v.labels.over_limit === overLimit &&
      v.labels.client === client
  );
  return typeof row?.value === 'number' ? row.value : 0;
}

/** Whether a series EXISTS for a label set, independent of its value. */
async function seriesExists(overLimit: 'true' | 'false', client: string): Promise<boolean> {
  const metric = await trpcBatchWidthHistogram.get();
  return metric.values.some(
    (v) =>
      v.metricName === 'civitai_app_trpc_batch_width_count' &&
      v.labels.over_limit === overLimit &&
      v.labels.client === client
  );
}

describe('civitai_app_trpc_batch_width histogram', () => {
  beforeEach(() => {
    __resetTrpcBatchMetricsForTest();
  });

  /**
   * 🔴 The module's own INVARIANT comment says this metric must land on prom-client's DEFAULT
   * registry, because `/api/metrics` scrapes that one. Nothing enforced it: adding
   * `registers: [new client.Registry()]` to the constructor left every assertion in this file
   * green while the series was never scraped by anything. Reading it back OFF the default
   * registry — and asserting it is the same object this module exports — is what makes that
   * mutant die.
   */
  it('is registered on the DEFAULT registry, which is the one /api/metrics scrapes', () => {
    expect(client.register.getSingleMetric('civitai_app_trpc_batch_width')).toBe(
      trpcBatchWidthHistogram
    );
  });

  /**
   * The cap's own value must be a bucket EDGE, or `le="<cap>"` stops reading as "accepted" and
   * the histogram can no longer answer the question it exists for. Removing 30 from the list
   * previously survived the whole suite.
   */
  it('has a bucket edge exactly at the cap', () => {
    expect(TRPC_BATCH_WIDTH_BUCKETS).toContain(TRPC_MAX_BATCH_SIZE);
    // Ascending, or prom-client silently mis-cumulates the buckets.
    expect([...TRPC_BATCH_WIDTH_BUCKETS].sort((a, b) => a - b)).toEqual(TRPC_BATCH_WIDTH_BUCKETS);
  });

  /**
   * The seed is destructive by construction: `Histogram.zero(labels)` REPLACES that label set's
   * buckets/sum/count rather than no-op'ing on an existing series (unlike the
   * `counter.inc({...}, 0)` pattern it was modelled on). This module can be evaluated more than
   * once — that is why it is pinned on `globalThis` — so a module-scope seed that ran every time
   * would wipe accumulated counts. Re-running the seeding function on a live series is the
   * observable form of that bug.
   */
  it('does not lose accumulated counts when the module is evaluated a SECOND time', async () => {
    observeTrpcBatchWidth(req({ trpc: 'a,b,c', batch: '1' }, { 'x-client': 'web' }));
    expect(await bucketCount('false')).toBe(1); // positive control: the count is really there

    // `vi.resetModules()` drops the module registry, so the next import RE-EVALUATES the module
    // body — the second-evaluation case the `globalThis` pin exists for. A plain re-import would
    // hit vitest's module cache and prove nothing. The histogram itself survives on `globalThis`,
    // so `bucketCount` below still reads the same series.
    vi.resetModules();
    const reEvaluated = await import('~/server/prom/trpc-batch.metrics');
    expect(reEvaluated.trpcBatchWidthHistogram).toBe(trpcBatchWidthHistogram); // same instance

    expect(await bucketCount('false')).toBe(1); // an unconditional module-scope seed zeroes this
  });

  /**
   * Without seeding, `over_limit="true"` is ABSENT until the first over-cap request a pod ever
   * sees — so a dashboard reading "no data" cannot tell "zero rejections" from "the cap never
   * shipped". Asserting PRESENCE (not the value, which is 0 either way) is what makes a real
   * zero readable as a zero.
   */
  it('publishes every (over_limit, client) series at zero before any request', async () => {
    for (const client of ['web', 'other', 'none']) {
      expect({ client, over: await seriesExists('true', client) }).toEqual({ client, over: true });
      expect({ client, under: await seriesExists('false', client) }).toEqual({
        client,
        under: true,
      });
    }
    expect(await bucketCount('true')).toBe(0); // present AND zero
  });

  it('moves the over-cap series by exactly 1 for an over-cap request (positive control)', async () => {
    // POSITIVE CONTROL first: prove the instrument can move at all, and by how much. A bare
    // "the under-cap series stayed at 0" would be indistinguishable from a histogram wired to
    // nothing, so both numbers are reported together.
    const beforeOver = await bucketCount('true');
    const beforeUnder = await bucketCount('false');

    const width = observeTrpcBatchWidth(
      req(
        {
          trpc: Array(TRPC_MAX_BATCH_SIZE + 1)
            .fill('a')
            .join(','),
          batch: '1',
        },
        { 'x-client': 'web' }
      )
    );

    const afterOver = await bucketCount('true');
    const afterUnder = await bucketCount('false');

    expect(width).toBe(TRPC_MAX_BATCH_SIZE + 1);
    expect({ over: afterOver - beforeOver, under: afterUnder - beforeUnder }).toEqual({
      over: 1,
      under: 0,
    });
  });

  it('classifies exactly at the cap as UNDER the limit (the cap is inclusive)', async () => {
    observeTrpcBatchWidth(
      req(
        { trpc: Array(TRPC_MAX_BATCH_SIZE).fill('a').join(','), batch: '1' },
        { 'x-client': 'web' }
      )
    );
    expect({ over: await bucketCount('true'), under: await bucketCount('false') }).toEqual({
      over: 0,
      under: 1,
    });
  });

  it('observes the WIDTH, not just a count, so the cap can be re-derived from live data', async () => {
    observeTrpcBatchWidth(req({ trpc: 'a,b,c', batch: '1' }, { 'x-client': 'web' }));
    const metric = await trpcBatchWidthHistogram.get();
    // Select by LABELS, not just metric name: the series are pre-seeded, so a bare
    // `find(_sum)` returns whichever seeded zero happens to come first.
    const sum = metric.values.find(
      (v) =>
        v.metricName === 'civitai_app_trpc_batch_width_sum' &&
        v.labels.over_limit === 'false' &&
        v.labels.client === 'web'
    );
    expect(sum?.value).toBe(3);
    // …and every OTHER series stayed at zero, so the 3 is attributable to this observation.
    const otherSums = metric.values.filter(
      (v) =>
        v.metricName === 'civitai_app_trpc_batch_width_sum' &&
        !(v.labels.over_limit === 'false' && v.labels.client === 'web')
    );
    expect(otherSums.map((v) => v.value)).toEqual(otherSums.map(() => 0));
  });

  it('labels an unknown client as `other`, keeping first-party traffic separable', async () => {
    observeTrpcBatchWidth(req({ trpc: 'a,b', batch: '1' }, { 'x-client': 'definitely-not-web' }));
    expect(await bucketCount('false', 'other')).toBe(1);
    expect(await bucketCount('false', 'web')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D: the two ends of the wire read ONE constant
// ---------------------------------------------------------------------------

/**
 * 🔴 The two call sites are pinned BEHAVIOURALLY, in the files next door:
 *  - server → `src/server/__tests__/trpc-handler-wiring.test.ts` reads `options.maxBatchSize`
 *    off the object the real route hands the adapter;
 *  - client → `src/utils/__tests__/trpc-batch-link-wiring.test.ts` reads `maxItems` off the
 *    options `src/utils/trpc.ts` actually constructs, via a spy on `httpBatchStreamLink`.
 * They used to be regexes over those two files. Both were walked by a block comment, so the cap
 * could be deleted with this suite fully green.
 *
 * What remains here is the part that genuinely is a claim about the SOURCE — that the number is
 * written in exactly one place — plus the env-resolution contract that decides what the server
 * actually enforces.
 */
describe('the cap has one source, and the server resolves it through the env', () => {
  // Per-file overrides are cleared between FILES, not between cases — and these cases
  // deliberately move the cap, so leaving one set would silently retune every later assertion.
  afterEach(() => {
    resetEnv();
  });

  it('the shared module is the only place the number is written', () => {
    const constants = readFileSync(
      join(process.cwd(), 'src/shared/constants/trpc.constants.ts'),
      'utf8'
    );
    expect(constants).toMatch(
      new RegExp(`export const TRPC_MAX_BATCH_SIZE = ${TRPC_MAX_BATCH_SIZE};`)
    );
  });

  it('defaults to the compiled-in constant when the env var is unset', () => {
    // The production default path, and the one every other test in this file assumes.
    expect(getTrpcMaxBatchSize()).toBe(TRPC_MAX_BATCH_SIZE);
  });

  it('takes a valid env override — the point of the var (rollback without a build)', () => {
    setEnv({ TRPC_MAX_BATCH_SIZE: 7 });
    expect(getTrpcMaxBatchSize()).toBe(7);
    setEnv({ TRPC_MAX_BATCH_SIZE: 500 });
    expect(getTrpcMaxBatchSize()).toBe(500);
  });

  it.each([
    ['undefined', undefined],
    ['zero (would reject every batch)', 0],
    ['negative', -5],
    ['non-integer', 12.5],
    ['NaN', Number.NaN],
    ['a string that slipped past the schema', '40' as unknown as number],
  ])('falls back to the constant rather than uncapping on %s', (_label, value) => {
    // 🔴 The direction matters: an unusable value must NOT become `maxBatchSize: undefined`,
    // which is how tRPC spells "no cap". Every one of these fails toward "still capped".
    setEnv({ TRPC_MAX_BATCH_SIZE: value });
    expect(getTrpcMaxBatchSize()).toBe(TRPC_MAX_BATCH_SIZE);
  });

  it('the override reaches the over-cap classification, not just the adapter', async () => {
    // Otherwise the metric (and the `onError` skip it arms) would keep labelling against the
    // compiled-in constant while tRPC enforced something else — marking requests tRPC ACCEPTED
    // as over-cap, and suppressing genuine BAD_REQUEST logs from their procedures.
    __resetTrpcBatchMetricsForTest();
    setEnv({ TRPC_MAX_BATCH_SIZE: 3 });

    const r = req({ trpc: 'a,b,c,d', batch: '1' }, { 'x-client': 'web' }); // width 4 > 3
    expect(instrumentTrpcBatchRequest(r)).toBe(4);
    expect(isTrpcBatchOverCap(r)).toBe(true);
    expect(await bucketCount('true')).toBe(1);

    // …and the control: the same width is UNDER the compiled-in constant, so a classification
    // still reading `TRPC_MAX_BATCH_SIZE` would have left it unmarked.
    expect(4).toBeLessThan(TRPC_MAX_BATCH_SIZE);
  });
});
