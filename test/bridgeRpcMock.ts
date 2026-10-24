import { vi, type Mock } from 'vitest';
import { makeTrpcProxy } from './trpcProxyStub';

/**
 * A `~/utils/trpc` stub for the App Blocks HOST bridge, built so a test asserts on the
 * PROCEDURE, never on the call seam a host happens to reach it through.
 *
 * The two hosts (`PageBlockHost`, `IframeHost`) forward a block's postMessage request to a
 * tRPC procedure through one of three seams today:
 *   - `trpc.<proc>.useMutation().mutateAsync(input)`        (most forwards)
 *   - `trpc.useUtils().<proc>.fetch(input, opts)`            (storage / shared READS)
 *   - `trpc.useUtils().client.<proc>.mutate|query(input)`    (e.g. ESTIMATE_WORKFLOW_BATCH)
 *
 * Every seam for one procedure path resolves to the SAME `vi.fn`, so a refactor that moves a
 * handler from `useMutation` to `client.mutate` leaves every assertion here untouched. The
 * read seam is the one deliberate exception in what an assertion SEES: `fetch` carries a
 * second `opts` argument (the read-cache staleTime) and `client.query` does not, so a test
 * that pins `[input, opts]` WILL go red if a read moves off the cached seam. That is a real
 * behaviour change (the cache policy), not seam noise, so it is meant to.
 *
 * ── The event log ────────────────────────────────────────────────────────────────────────
 * `events` is an ordered log the ordering assertions read: `rpc:<path>` when a procedure is
 * called, `invalidate:<path>:start` / `invalidate:<path>:settled` around a `useUtils()`
 * `<namespace>.invalidate()`, and whatever the test itself pushes (the matrix pushes
 * `reply:<TYPE>` from its reply listener). `holdInvalidations()` keeps every invalidate
 * pending until released, which is what makes "invalidate BEFORE reply" observable: the
 * reply must not arrive while the invalidation is unsettled.
 *
 * 🔴 Everything not listed in `FORWARDED_PROCEDURES` falls through to `makeTrpcProxy`'s inert
 * defaults, which exist to stop a render crashing and must never be measured (see that file).
 */

/** The procedure paths the hosts forward to, i.e. the ones this stub gives a stable spy. */
export const FORWARDED_PROCEDURES = [
  'blocks.submitWorkflow',
  'blocks.estimateWorkflow',
  'blocks.pollWorkflow',
  'blocks.cancelWorkflow',
  'blocks.queryAppWorkflows',
  'blocks.cancelAppWorkflow',
  'blocks.getMyBuzzBalance',
  'blocks.getMyBuzzTransactions',
  'blocks.getMyBuzzAccounts',
  'blocks.getMyDailyCompensation',
  'blocks.getMyViewer',
  'blocks.getImagesByIds',
  'apps.storage.get',
  'apps.storage.set',
  'apps.storage.delete',
  'apps.storage.list',
  'apps.storage.getQuota',
  'apps.shared.list',
  'apps.shared.get',
  'apps.shared.getCount',
  'apps.shared.getCounts',
  'apps.shared.append',
  'apps.shared.update',
  'apps.shared.vote',
  'apps.shared.unvote',
  'apps.shared.withdraw',
  'apps.shared.report',
] as const;

export type ForwardedProcedure = (typeof FORWARDED_PROCEDURES)[number];

export interface BridgeRpcMock {
  /** The `~/utils/trpc` `trpc` export to install from a `vi.mock` factory. */
  trpc: unknown;
  /** The one spy for a procedure path, whichever seam the host calls it through. */
  fn: (path: string) => Mock;
  /** The spy behind `useUtils().<namespace>.invalidate()`, e.g. `invalidate('apps.shared')`. */
  invalidate: (namespace: string) => Mock;
  /** Ordered log; see the header. Mutate it only by pushing. */
  events: string[];
  /** Keep every invalidation pending until the returned `release()` is called. */
  holdInvalidations: () => () => void;
  /** Reset every spy (implementations included), the event log and any hold. */
  reset: () => void;
}

const INERT_LEAVES = ['setData', 'getData', 'prefetch', 'cancel', 'reset', 'refetch'] as const;

export function createBridgeRpcMock(extraProcedures: Record<string, unknown> = {}): BridgeRpcMock {
  const events: string[] = [];
  const spies = new Map<string, Mock>();
  const invalidateSpies = new Map<string, Mock>();
  const inertLeaves = new Map<string, Mock>();
  let hold: { promise: Promise<void>; release: () => void } | null = null;

  const fn = (path: string): Mock => {
    let spy = spies.get(path);
    if (!spy) {
      spy = vi.fn();
      spies.set(path, spy);
    }
    return spy;
  };

  // Every seam calls through here so the log records the call before the spy runs.
  const call = (path: string, args: unknown[]) => {
    events.push(`rpc:${path}`);
    return fn(path)(...args);
  };

  const invalidate = (namespace: string): Mock => {
    let spy = invalidateSpies.get(namespace);
    if (!spy) {
      spy = vi.fn();
      invalidateSpies.set(namespace, spy);
    }
    return spy;
  };

  // Bumped by `reset()`. An invalidation still held open when a test ends (it failed
  // mid-hold) settles during the NEXT test's reset; without this guard its `settled`
  // event would land in that test's log and fail it for the previous test's defect.
  let generation = 0;
  const runInvalidate = async (namespace: string, args: unknown[]) => {
    const started = generation;
    events.push(`invalidate:${namespace}:start`);
    try {
      await invalidate(namespace)(...args);
      if (hold) await hold.promise;
    } finally {
      if (started === generation) events.push(`invalidate:${namespace}:settled`);
    }
  };

  // Stable per-path mutation hook results: hosts list these in effect deps, and a fresh
  // object per render would re-subscribe every handler on every render.
  const mutationResults = new Map<string, unknown>();
  const mutationFor = (path: string) => {
    let m = mutationResults.get(path);
    if (!m) {
      m = {
        mutateAsync: (...args: unknown[]) => call(path, args),
        mutate: (...args: unknown[]) => void call(path, args),
        isPending: false,
        isError: false,
        reset: () => undefined,
      };
      mutationResults.set(path, m);
    }
    return m;
  };

  // `trpc.apps.storage.<x>` / `trpc.apps.shared.<x>` sit two levels deep, which
  // `makeTrpcProxy` resolves only through an explicit sub-router override.
  const subRouter = (prefix: string) =>
    new Proxy(
      {},
      {
        has: () => true,
        get: (_t, key) =>
          key === 'then' || typeof key !== 'string'
            ? undefined
            : { useMutation: () => mutationFor(`${prefix}.${key}`) },
      }
    );

  const procedureOverrides: Record<string, unknown> = {};
  for (const path of FORWARDED_PROCEDURES) {
    if (path.startsWith('blocks.')) {
      procedureOverrides[path] = { useMutation: () => mutationFor(path) };
    }
  }
  procedureOverrides['apps.storage'] = subRouter('apps.storage');
  procedureOverrides['apps.shared'] = subRouter('apps.shared');
  Object.assign(procedureOverrides, extraProcedures);

  // `useUtils()`: a STABLE root (hosts list it in effect deps). Any path answers `fetch`
  // (read seam), `invalidate` (logged), the inert leaves, and `client.<path>.mutate|query`.
  const nodeCache = new Map<string, unknown>();
  const utilsNode = (path: string[], isClient: boolean): unknown => {
    const cacheKey = `${isClient ? 'client:' : ''}${path.join('.')}`;
    const cached = nodeCache.get(cacheKey);
    if (cached) return cached;
    const node = new Proxy(
      {},
      {
        get: (_t, key) => {
          if (key === 'then' || typeof key !== 'string') return undefined;
          const joined = path.join('.');
          if (isClient && (key === 'mutate' || key === 'query')) {
            return (...args: unknown[]) => call(joined, args);
          }
          if (!isClient) {
            if (path.length === 0 && key === 'client') return utilsNode([], true);
            if (key === 'fetch') return (...args: unknown[]) => call(joined, args);
            if (key === 'invalidate') return (...args: unknown[]) => runInvalidate(joined, args);
            if ((INERT_LEAVES as readonly string[]).includes(key)) {
              const leafKey = `${joined}#${key}`;
              let leaf = inertLeaves.get(leafKey);
              if (!leaf) {
                leaf = vi.fn(async () => undefined);
                inertLeaves.set(leafKey, leaf);
              }
              return leaf;
            }
          }
          return utilsNode([...path, key], isClient);
        },
      }
    );
    nodeCache.set(cacheKey, node);
    return node;
  };
  const utilsRoot = utilsNode([], false);

  const trpc = makeTrpcProxy(procedureOverrides, {
    useUtils: () => utilsRoot,
    useContext: () => utilsRoot,
  });

  return {
    trpc,
    fn,
    invalidate,
    events,
    holdInvalidations: () => {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      hold = { promise, release };
      return () => {
        release();
        hold = null;
      };
    },
    reset: () => {
      generation += 1;
      for (const spy of spies.values()) spy.mockReset();
      for (const spy of invalidateSpies.values()) spy.mockReset();
      events.length = 0;
      if (hold) hold.release();
      hold = null;
    },
  };
}
