// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The procedure is answered by real React Query with the hook's own options, so the test measures
 * when a refetch actually happens.
 */
const server = vi.hoisted(() => ({
  calls: 0,
  respond: (): unknown => ({}),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: makeTrpcProxy({
      'generation.getGenerationConfig': {
        useQuery: (_input: unknown, { trpc: _trpc, ...options }: Record<string, unknown>) =>
          useQuery({
            ...options,
            queryKey: ['generation.getGenerationConfig'],
            queryFn: async () => {
              server.calls++;
              return server.respond();
            },
          }),
      },
    }),
  };
});

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wanGate = {
  availableTo: 'moderators' as const,
  presentation: 'hidden' as const,
  ecosystems: ['WanVideo22'],
  workflows: [],
  modelVersionIds: [],
};

function mount() {
  // The app's QueryClient defaults (src/utils/trpc.ts), so the hook has to opt in to refreshing.
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false } },
  });
  const result = { current: undefined as unknown as ReturnType<typeof useGenerationConfig> };
  function Probe() {
    result.current = useGenerationConfig();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  return { result, unmount: () => act(() => root.unmount()) };
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const refocus = () =>
  act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });

describe('useGenerationConfig refresh', () => {
  let view: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    server.calls = 0;
    server.respond = () => ({ gateRules: [wanGate] });
  });
  afterEach(() => {
    view?.unmount();
    view = undefined;
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('picks up a lifted gate within five minutes while the generator stays open', async () => {
    view = mount();
    await flush();
    expect(server.calls).toBe(1);
    expect(view.result.current.gateRules).toEqual([wanGate]);

    server.respond = () => ({ gateRules: [] });
    await advance(5 * 60_000 + 1_000);

    expect(server.calls).toBe(2);
    expect(view.result.current.gateRules).toEqual([]);
  });

  it('refetches on returning to the tab once the config is a minute old', async () => {
    view = mount();
    await flush();
    server.respond = () => ({ gateRules: [] });

    await advance(30_000);
    await refocus();
    await flush();
    expect(server.calls).toBe(1);

    await advance(31_000);
    await refocus();
    await flush();
    expect(server.calls).toBe(2);
    expect(view.result.current.gateRules).toEqual([]);
  });

  it('keeps the same config object when a refetch returns the same rules', async () => {
    view = mount();
    await flush();
    const before = view.result.current;

    await advance(5 * 60_000 + 1_000);

    expect(server.calls).toBe(2);
    expect(view.result.current).toBe(before);
  });
});
