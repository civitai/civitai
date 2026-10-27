// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelSaleBadge, __resetModelSaleBatcher } from '~/components/Cards/ModelCardContext';
import {
  __resetEngagedMembershipBatcher,
  requestEngagedMembership,
} from '~/hooks/useEngagedModelMembership';
import {
  batchWindowLink,
  queryClient,
  setTrpcBatchingEnabled,
  trpc,
  trpcVanilla,
} from '~/utils/trpc';
import {
  __resetTrpcBatchWindow,
  setTrpcUnifiedBatchWindowEnabled,
} from '~/utils/trpc-batch-window';

/**
 * What one signed-in page load sends, with the REAL tRPC clients and batchers (nothing in
 * `~/utils/trpc` is mocked; only `fetch` is stubbed and timers are fake). The page:
 *  - t=0: the React client asks `user.getSettings`; a provider-less card asks for its sale (the
 *    sale-badge batcher, vanilla client) and its engaged state (the engaged-models batcher);
 *  - t=5 ms: a later-mounting component asks `system.getBrowsingSettingAddons` (React client).
 *
 * OFF, every coalescer runs its own clock: two React-client requests at their own ticks, the sale
 * batcher at 50 ms and the engaged batcher at 80 ms, so four requests. ON, the two React-client
 * queries share one window (closing at 16 ms); each batcher still collects for its own window and
 * then sends with the next shared close, so three requests carrying the same four calls.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requests: string[] = [];

/** `/api/trpc/a,b?batch=1&input=…` → the procedures it carries, sorted. */
function procedures(url: string) {
  return url.split('?')[0].replace('/api/trpc/', '').split(',').sort().join(',');
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function Card({ id }: { id: number }) {
  trpc.user.getSettings.useQuery();
  useModelSaleBadge(id, false);
  useEffect(() => requestEngagedMembership([id]), [id]);
  return null;
}

function LateComponent() {
  trpc.system.getBrowsingSettingAddons.useQuery();
  return null;
}

async function loadPage(modelId: number) {
  const card = createRoot(document.createElement('div'));
  const late = createRoot(document.createElement('div'));
  const WrappedCard = trpc.withTRPC(Card as never) as unknown as ComponentType<{
    pageProps: object;
    id: number;
  }>;
  const WrappedLate = trpc.withTRPC(LateComponent as never) as unknown as ComponentType<{
    pageProps: object;
  }>;
  await act(async () => {
    card.render(createElement(WrappedCard, { pageProps: {}, id: modelId }));
  });
  await advance(5);
  await act(async () => {
    late.render(createElement(WrappedLate, { pageProps: {} }));
  });
  // Past both batchers' own windows, short of the engaged batcher's 3 s retry.
  await advance(200);
  card.unmount();
  late.unmount();
}

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(typeof input === 'string' ? input : input.toString());
      return new Response('', { status: 500 });
    })
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  queryClient.clear();
  __resetModelSaleBatcher();
  __resetEngagedMembershipBatcher();
  __resetTrpcBatchWindow();
  window.isAuthed = true;
  setTrpcBatchingEnabled(true);
});

afterEach(() => {
  setTrpcBatchingEnabled(false);
  setTrpcUnifiedBatchWindowEnabled(false);
  window.isAuthed = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('trpc-unified-batch-window OFF: each coalescer keeps its own clock', () => {
  it('sends four requests, one per clock', async () => {
    setTrpcUnifiedBatchWindowEnabled(false);
    await loadPage(11);
    expect(requests.map(procedures).sort()).toEqual([
      'model.getActiveSales',
      'system.getBrowsingSettingAddons',
      'user.getEngagedModelsByIds',
      'user.getSettings',
    ]);
  });
});

describe('trpc-unified-batch-window ON: one shared window', () => {
  it('sends the same four calls in three requests', async () => {
    setTrpcUnifiedBatchWindowEnabled(true);
    await loadPage(12);
    expect(requests.map(procedures)).toEqual([
      'system.getBrowsingSettingAddons,user.getSettings',
      'model.getActiveSales',
      'user.getEngagedModelsByIds',
    ]);
  });

  it('changes nothing for an anonymous browser, where nothing is batched', async () => {
    setTrpcUnifiedBatchWindowEnabled(true);
    window.isAuthed = false;
    await loadPage(13);
    // Anonymous: no batch link at all, so the window must not hold anything back. The engaged
    // batcher still runs on its own 80 ms clock (it is called directly here); the sale badge goes
    // out alone, unbatched, as it always has.
    expect(requests.map(procedures).sort()).toEqual([
      'model.getActiveSales',
      'system.getBrowsingSettingAddons',
      'user.getEngagedModelsByIds',
      'user.getSettings',
    ]);
  });
});

/**
 * The engaged batcher keeps its own 80 ms window with the flag on, so ids that arrive 30 ms apart
 * are still ONE call; the flag only moves that call into the request of whatever is pending in the
 * shared window when the batcher's window ends. Here a query starts at 75 ms, opening a shared
 * window that closes at 91 ms, and the batcher's window ends at 80 ms, inside it.
 */
describe('the engaged batcher keeps its own window', () => {
  async function idsThirtyMsApartThenAQuery() {
    requestEngagedMembership([21]);
    await advance(30);
    requestEngagedMembership([22]);
    await advance(45);
    trpcVanilla.system.getBrowsingSettingAddons.query().catch(() => undefined);
    await advance(100);
  }
  const engagedCalls = () =>
    requests
      .flatMap((url) => procedures(url).split(','))
      .filter((p) => p === 'user.getEngagedModelsByIds');
  const carriesBothIds = () =>
    requests.filter((url) => decodeURIComponent(url).includes('"modelIds":[21,22]')).length;

  it('OFF: one engaged call for both ids, in its own request', async () => {
    setTrpcUnifiedBatchWindowEnabled(false);
    await idsThirtyMsApartThenAQuery();
    expect(engagedCalls()).toHaveLength(1);
    expect(carriesBothIds()).toBe(1);
    expect(requests.map(procedures).sort()).toEqual([
      'system.getBrowsingSettingAddons',
      'user.getEngagedModelsByIds',
    ]);
  });

  it("ON: still one engaged call for both ids, sent in the pending query's request", async () => {
    setTrpcUnifiedBatchWindowEnabled(true);
    await idsThirtyMsApartThenAQuery();
    expect(engagedCalls()).toHaveLength(1);
    expect(carriesBothIds()).toBe(1);
    expect(requests.map(procedures)).toEqual([
      'system.getBrowsingSettingAddons,user.getEngagedModelsByIds',
    ]);
  });
});

describe('a held query whose transport throws synchronously', () => {
  it('rejects with that error when the window releases it, instead of never settling', async () => {
    setTrpcUnifiedBatchWindowEnabled(true);
    const next = vi.fn(() => ({
      subscribe: () => {
        throw new Error('sync transport failure');
      },
    }));
    const op = {
      id: 1,
      type: 'query' as const,
      path: 'user.getSettings',
      input: undefined,
      context: {},
      signal: null,
    };
    const result$ = batchWindowLink({} as never)({ op, next } as never);
    let settled: unknown = 'pending';
    result$.subscribe({
      next: () => (settled = 'value'),
      error: (error: unknown) => (settled = (error as Error).message),
    });

    // Held: nothing reached the transport before the window closed.
    await vi.advanceTimersByTimeAsync(15);
    expect(next).not.toHaveBeenCalled();
    expect(settled).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(settled).toBe('sync transport failure');
  });
});
