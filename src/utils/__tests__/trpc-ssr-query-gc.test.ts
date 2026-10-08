import React from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as ReactQuery from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 WHY THIS FILE EXISTS. On the server, `@trpc/next`'s `withTRPC` builds a fresh QueryClient
 * per SSR render. query-core never schedules GC for a server query by DEFAULT (`gcTime`
 * defaults to Infinity there) — but an explicit per-query `gcTime` overrides that default, and
 * the `Query` constructor calls `scheduleGc()` even for a disabled query. That timer's closure
 * holds the Query, which holds the per-request client and its whole cache, so every render of a
 * component with a finite `gcTime` (e.g. `ModelTensorMetadata`, 30 min) pinned that render's
 * entire QueryCache for 30 minutes. A production SSR heap snapshot held ~700 such caches.
 *
 * This renders through the REAL `trpc.withTRPC` seam in `~/utils/trpc` (the unit project runs
 * in node, so `typeof window === 'undefined'` and the server branch is taken) and asserts that a
 * finite per-query `gcTime` leaves NO pending timer behind. (`.test.ts`, not `.tsx`: the `unit`
 * project only collects `.test.ts` files under `src/`, so elements are built with `createElement`.)
 */

const THIRTY_MINUTES = 30 * 60 * 1000;

/**
 * The `@tanstack/react-query` instance `@trpc/next` itself renders with.
 *
 * Harness detail, not app behaviour: this config pre-bundles `@tanstack/react-query` through the
 * Vite optimizer (`deps.optimizer` in vitest.config.mts) while `@trpc/next`/`@trpc/react-query`
 * stay externalised and import the package natively — two module instances, two React contexts.
 * A bare `import { useQuery } from '@tanstack/react-query'` in this file would therefore throw
 * "No QueryClient set" under `withTRPC`'s provider. Importing the same ESM entry file natively
 * (resolved from `@trpc/react-query`'s own location) yields the instance the provider uses, as a
 * Next bundle does in production.
 */
async function loadTrpcSideReactQuery(): Promise<typeof ReactQuery> {
  const fromTrpc = createRequire(createRequire(import.meta.url).resolve('@trpc/react-query'));
  const pkgDir = path.dirname(fromTrpc.resolve('@tanstack/react-query/package.json'));
  const entry = pathToFileURL(path.join(pkgDir, 'build/modern/index.js')).href;
  return import(/* @vite-ignore */ entry);
}

// Mirrors `ModelTensorMetadata`'s query options: a finite gcTime on a disabled query and on an
// enabled-but-never-fetched-on-the-server one. Both are BUILT during SSR.
function makeProbe(rq: typeof ReactQuery, capture: { client?: QueryClient }) {
  const { useQuery, useQueryClient } = rq;
  return function Probe() {
    capture.client = useQueryClient();
    useQuery({
      queryKey: ['ssr-gc-probe', 'summary'],
      queryFn: () => Promise.resolve(1),
      enabled: false,
      staleTime: Infinity,
      gcTime: THIRTY_MINUTES,
    });
    useQuery({
      queryKey: ['ssr-gc-probe', 'full'],
      queryFn: () => Promise.resolve(2),
      staleTime: Infinity,
      gcTime: THIRTY_MINUTES,
    });
    return React.createElement('span', null, 'probe');
  };
}

describe('SSR per-request QueryClient never schedules query GC', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('a finite per-query gcTime leaves no pending timer pinning the request client', async () => {
    const { trpc } = await import('~/utils/trpc');
    const capture: { client?: QueryClient } = {};
    const Wrapped = trpc.withTRPC(
      makeProbe(await loadTrpcSideReactQuery(), capture)
    ) as React.ComponentType<{ pageProps: object }>;

    // Only timers created by THIS render count.
    vi.clearAllTimers();
    const html = renderToString(React.createElement(Wrapped, { pageProps: {} }));

    // POSITIVE CONTROL: the probe actually rendered under the withTRPC client and BUILT both
    // queries. Without this, "0 timers" is indistinguishable from "nothing ran".
    expect(html).toContain('probe');
    expect(capture.client).toBeDefined();
    const queries = capture.client!.getQueryCache().getAll();
    expect(queries.map((q) => q.queryKey[1]).sort()).toEqual(['full', 'summary']);

    // The property under test: no GC timer is pending, so nothing outlives the request.
    expect(vi.getTimerCount()).toBe(0);
    for (const q of queries) expect(q.gcTime).toBe(Infinity);

    // And nothing fires later either: after the per-query gcTime elapses the queries are still
    // there — no timer ran `optionalRemove()`, because none was ever scheduled.
    vi.advanceTimersByTime(THIRTY_MINUTES + 1000);
    expect(capture.client!.getQueryCache().getAll()).toHaveLength(2);
  });
});

// INVARIANT guard (green before and after the fix): in the browser a per-query gcTime is the real
// eviction policy, so the server-only override must never reach the browser singleton. This reads
// the real `queryClient` export with `window` stubbed, which takes the browser branch.
describe('the BROWSER QueryClient still honours a per-query gcTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the explicit gcTime and schedules its GC timer', async () => {
    const { queryClient } = await import('~/utils/trpc');
    const defaulted = queryClient.defaultQueryOptions({
      queryKey: ['browser-gc-probe'],
      gcTime: THIRTY_MINUTES,
    });
    expect(defaulted.gcTime).toBe(THIRTY_MINUTES);

    vi.clearAllTimers();
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: ['browser-gc-probe'],
      gcTime: THIRTY_MINUTES,
    });
    expect(query.gcTime).toBe(THIRTY_MINUTES);
    expect(vi.getTimerCount()).toBe(1);

    // The scheduled GC really collects it once the gcTime elapses.
    vi.advanceTimersByTime(THIRTY_MINUTES + 1000);
    expect(queryClient.getQueryCache().find({ queryKey: ['browser-gc-probe'] })).toBeUndefined();
  });
});
