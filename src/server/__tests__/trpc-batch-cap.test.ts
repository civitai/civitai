import { readFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import type { AddressInfo } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTRPC } from '@trpc/server';
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { z } from 'zod';

import {
  TRPC_MAX_BATCH_SIZE,
  OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH,
} from '~/shared/constants/trpc.constants';
import {
  __resetTrpcBatchMetricsForTest,
  boundedClientLabel,
  computeBatchWidth,
  instrumentTrpcBatchRequest,
  isTrpcBatchOverCap,
  markTrpcBatchOverCap,
  observeTrpcBatchWidth,
  shouldSkipBatchCapLog,
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
 * the single `[trpc]` segment (decoded) plus the search params. Nothing else about the request
 * is synthesised — it is a real `IncomingMessage` off a real socket.
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
    void (handler as (r: unknown, s: unknown) => unknown)(req, res);
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

  it('is the call the route makes, before it delegates to the tRPC handler', () => {
    const src = readFileSync(join(process.cwd(), 'src/pages/api/trpc/[trpc].ts'), 'utf8');
    expect(src).toMatch(/^\s*instrumentTrpcBatchRequest\(req\);$/m);
    expect(src.indexOf('instrumentTrpcBatchRequest(req);')).toBeLessThan(
      src.indexOf('runWithSerializeCtx(')
    );
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

  /**
   * Structural pin on the wiring: the predicate must be consulted in `onError` and must return
   * BEFORE the Axiom ingest, or the log storm it exists to prevent is still paid. Source-level
   * because the ORDER of two statements is the property under test, and the route's own module
   * graph (appRouter, createContext) is not loadable in a unit test.
   */
  it('is wired into the route onError ahead of the Axiom ingest', () => {
    const src = readFileSync(join(process.cwd(), 'src/pages/api/trpc/[trpc].ts'), 'utf8');
    const skipAt = src.indexOf('shouldSkipBatchCapLog(req, error)');
    const ingestAt = src.indexOf('await logToAxiom(');
    expect(skipAt).toBeGreaterThan(-1);
    expect(ingestAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(ingestAt);
    // …and it must be an early return, not a bare call whose result is dropped.
    expect(src).toMatch(/if \(shouldSkipBatchCapLog\(req, error\)\) return error;/);
  });
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
 * The client limit must be <= the server's or the browser 400s itself, and a duplicated literal
 * is exactly how that invariant rots. Asserting `TRPC_MAX_BATCH_SIZE === TRPC_MAX_BATCH_SIZE`
 * would be vacuous, so this reads the two call sites and asserts each passes the SHARED
 * IDENTIFIER — a hardcoded number on either side fails here.
 */
describe('client and server caps come from one shared constant', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  const SERVER = 'src/pages/api/trpc/[trpc].ts';
  const CLIENT = 'src/utils/trpc.ts';

  it('the server adapter passes maxBatchSize: TRPC_MAX_BATCH_SIZE', () => {
    const src = read(SERVER);
    expect(src).toMatch(/maxBatchSize:\s*TRPC_MAX_BATCH_SIZE\s*,/);
    expect(src).toMatch(
      /import\s*\{[^}]*TRPC_MAX_BATCH_SIZE[^}]*\}\s*from\s*'~\/shared\/constants\/trpc\.constants'/
    );
    // No numeric literal smuggled in beside it.
    expect(src).not.toMatch(/maxBatchSize:\s*\d/);
  });

  it('the client batch link passes maxItems: TRPC_MAX_BATCH_SIZE', () => {
    const src = read(CLIENT);
    expect(src).toMatch(/maxItems:\s*TRPC_MAX_BATCH_SIZE\s*,/);
    expect(src).toMatch(
      /import\s*\{[^}]*TRPC_MAX_BATCH_SIZE[^}]*\}\s*from\s*'~\/shared\/constants\/trpc\.constants'/
    );
    expect(src).not.toMatch(/maxItems:\s*\d/);
  });

  it('the shared module is the only place the number is written', () => {
    const constants = read('src/shared/constants/trpc.constants.ts');
    expect(constants).toMatch(
      new RegExp(`export const TRPC_MAX_BATCH_SIZE = ${TRPC_MAX_BATCH_SIZE};`)
    );
  });
});
