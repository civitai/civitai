// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The reported bug: the app's QueryClient defaults to `staleTime: Infinity` and no refetch on
 * focus, so a deal page that was already cached kept its old round (and a seller's list its old
 * requests) until a hard reload. These drive the real hooks through a client built with those
 * production defaults; only the tRPC transport is replaced.
 */
const server = vi.hoisted(() => ({ deal: 'round-1', requests: ['req-1'], fetches: 0 }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useQuery, useInfiniteQuery } = await import('@tanstack/react-query');
  const { makeTrpcProxy } = await import('../../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'creatorServiceDeal.get': {
        useQuery: (input: { id: number }, opts: object) =>
          useQuery({
            queryKey: ['deal.get', input],
            queryFn: async () => {
              server.fetches++;
              return { round: server.deal };
            },
            ...opts,
          }),
      },
      'creatorServiceDeal.listMine': {
        useInfiniteQuery: (input: object, opts: object) =>
          useInfiniteQuery({
            queryKey: ['deal.listMine', input],
            queryFn: async () => ({ items: [...server.requests], nextCursor: undefined }),
            initialPageParam: undefined,
            ...opts,
          } as never),
      },
    }),
  };
});

import {
  useMyServiceDeals,
  useServiceDeal,
} from '~/components/CreatorShop/Services/deals/deal.util';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same defaults as `queryClientConfig` in src/utils/trpc.ts.
const prodClient = () =>
  new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } },
  });

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

function mount<T>(client: QueryClient, useHook: () => T) {
  const result = { current: undefined as T };
  const Probe = () => {
    result.current = useHook();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
  return { result, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  server.deal = 'round-1';
  server.requests = ['req-1'];
  server.fetches = 0;
  focusManager.setFocused(undefined);
});

describe('deal queries do not serve a stale read', () => {
  it('deal page shows the new round when reopened', async () => {
    const client = prodClient();
    const first = mount(client, () => useServiceDeal(1));
    await flush();
    expect((first.result.current.deal as { round: string }).round).toBe('round-1');
    first.unmount();

    server.deal = 'round-2'; // the seller delivers while the buyer is away
    const second = mount(client, () => useServiceDeal(1));
    await flush();
    expect((second.result.current.deal as { round: string }).round).toBe('round-2');
    second.unmount();
  });

  it('deal page shows the new round on tab refocus', async () => {
    const client = prodClient();
    const page = mount(client, () => useServiceDeal(1));
    await flush();
    server.deal = 'round-2';
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((page.result.current.deal as { round: string }).round).toBe('round-2');
    page.unmount();
  });

  it("seller's list shows a new request when reopened", async () => {
    const client = prodClient();
    const args = { role: 'seller', status: 'open', enabled: true } as const;
    const first = mount(client, () => useMyServiceDeals(args));
    await flush();
    expect(first.result.current.deals).toEqual(['req-1']);
    first.unmount();

    server.requests = ['req-2', 'req-1'];
    const second = mount(client, () => useMyServiceDeals(args));
    await flush();
    expect(second.result.current.deals).toEqual(['req-2', 'req-1']);
    second.unmount();
  });
});
