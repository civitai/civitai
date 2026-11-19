import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

type Item = { id: string; status: string; tags: string[]; createdAt: string; steps: [] };

const h = vi.hoisted(() => ({
  items: [] as Item[],
  fetches: 0,
  patch: vi.fn<(input: unknown) => Promise<void>>(async () => undefined),
  getWorkflow: vi.fn<(input: { workflowId: string }) => Promise<{ tags: string[] }>>(async () => ({
    tags: [],
  })),
  signals: new Map<string, (data: unknown) => void>(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 9 }) }));
vi.mock('~/providers/AppProvider', async (orig) => ({
  ...(await orig<object>()),
  useAppContext: () => ({ domain: 'blue' }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (orig) => ({
  ...(await orig<object>()),
  useBrowsingSettings: () => true,
}));
vi.mock('~/providers/FiltersProvider', async (orig) => ({
  ...(await orig<object>()),
  useFiltersContext: () => ({}),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsProvider>()),
  useOptionalFeatureFlags: () => ({ remixApps: true }),
}));
vi.mock('~/components/Signals/SignalsProvider', async (orig) => ({
  ...(await orig<object>()),
  useSignalConnection: (message: string, cb: (data: unknown) => void) => {
    h.signals.set(message, cb);
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useInfiniteQuery, useMutation } = await import('@tanstack/react-query');
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const original = await importOriginal<typeof Trpc>();
  const realOrchestrator = original.trpc.orchestrator as unknown as Record<string, object>;
  // The real router, so the hook's cache writes and invalidations use the generator's own keys;
  // only the network calls are replaced.
  const orchestrator = new Proxy(realOrchestrator, {
    get(target, key: string) {
      if (key === 'queryGeneratedImages')
        return new Proxy(target[key], {
          get: (proc, name) =>
            name === 'useInfiniteQuery'
              ? (input: unknown, options: Record<string, unknown>) =>
                  useInfiniteQuery(
                    {
                      queryKey: [
                        ['orchestrator', 'queryGeneratedImages'],
                        { input, type: 'infinite' },
                      ],
                      queryFn: async () => {
                        h.fetches++;
                        return { items: h.items, nextCursor: undefined };
                      },
                      initialPageParam: undefined,
                      getNextPageParam: () => undefined,
                      ...options,
                    },
                    original.queryClient
                  )
              : (proc as Record<string | symbol, unknown>)[name],
        });
      if (key === 'patch')
        return {
          useMutation: () =>
            useMutation({ mutationFn: (input) => h.patch(input) }, original.queryClient),
        };
      return target[key];
    },
  });
  return {
    ...original,
    trpc: makeTrpcProxy(
      // The tray names a run from the app list.
      { 'remixApp.list': { useQuery: () => ({ data: [{ slug: 'anime-it', name: 'Anime it' }] }) } },
      { orchestrator }
    ),
    trpcVanilla: { orchestrator: { getWorkflow: { query: h.getWorkflow } } },
  };
});

import { setCachedWorkflowTag } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { RemixTray } from '~/components/Image/Remix/RemixTray';
import { SignalMessages } from '~/server/common/enums';
import { queryClient } from '~/utils/trpc';

let seq = 0;
function workflow(run: string, seg: number, status: string, extra: string[] = []): Item {
  return {
    id: `${run}-${seg}`,
    status,
    tags: [
      'gen',
      'remix-app',
      'remix-app:anime-it',
      `remix-run:${run}`,
      `remix-seg:${seg}`,
      ...extra,
    ],
    createdAt: new Date(2026, 10, 5, 0, seq++).toISOString(),
    steps: [],
  };
}

const pill = () => page.getByRole('button', { name: /^Remix runs:/ });
const rows = () => page.getByRole('list', { name: 'Remix runs' }).getByRole('listitem');

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  h.signals.clear();
  h.items = [];
  h.fetches = 0;
});

describe('RemixTray', () => {
  test('splits runs into in progress and ready, one row per run', async () => {
    h.items = [
      workflow('a', 0, 'succeeded'),
      workflow('a', 1, 'processing'), // a multi-step run counts by its latest segment
      workflow('b', 0, 'succeeded'),
      workflow('c', 0, 'failed'),
      workflow('d', 0, 'scheduled'),
      workflow('e', 0, 'succeeded', ['remix:dismissed']),
    ];
    renderWithProviders(<RemixTray />);

    await expect.element(pill()).toHaveAccessibleName('Remix runs: 2 in progress, 2 ready');
    await pill().click();
    expect(rows().all()).toHaveLength(4);
    await expect.element(rows().getByText('Failed')).toBeVisible();
  });

  test('is hidden when nothing is in progress or ready', async () => {
    h.items = [
      workflow('a', 0, 'succeeded', ['remix:dismissed']),
      workflow('b', 0, 'succeeded', ['remix:done']),
    ];
    renderWithProviders(<RemixTray />);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await expect.element(pill()).not.toBeInTheDocument();
  });

  test('✕ adds remix:dismissed to the latest segment and removes the row', async () => {
    h.items = [
      workflow('a', 0, 'succeeded'),
      workflow('a', 1, 'succeeded'),
      workflow('b', 0, 'succeeded'),
    ];
    renderWithProviders(<RemixTray />);
    await pill().click();
    await expect.poll(() => rows().all()).toHaveLength(2);

    await page.getByRole('button', { name: 'Dismiss Anime it' }).first().click();

    expect(h.patch).toHaveBeenCalledWith({
      tags: [{ workflowId: 'a-1', tag: 'remix:dismissed', op: 'add' }],
    });
    await expect.poll(() => rows().all()).toHaveLength(1);
    await expect.element(pill()).toHaveAccessibleName('Remix runs: 0 in progress, 1 ready');
  });

  test('a generation signal costs nothing; a remix-app signal for an unseen run adds it once', async () => {
    h.items = [workflow('a', 0, 'succeeded')];
    renderWithProviders(<RemixTray />);
    await expect.element(pill()).toHaveAccessibleName('Remix runs: 0 in progress, 1 ready');
    const fetchesAtStart = h.fetches;

    // Every generation the viewer runs sends this; the tray must not look any of them up.
    h.signals.get(SignalMessages.TextToImageUpdate)?.({
      $type: 'step',
      workflowId: 'other-0',
      status: 'processing',
    });
    const fresh = workflow('z', 0, 'processing');
    h.items = [...h.items, fresh];
    const remixSignal = h.signals.get(SignalMessages.RemixAppUpdate)!;
    remixSignal({ $type: 'step', workflowId: fresh.id, status: 'processing' });
    remixSignal({ $type: 'step', workflowId: fresh.id, status: 'processing' });

    await expect.element(pill()).toHaveAccessibleName('Remix runs: 1 in progress, 1 ready');
    expect(h.fetches).toBe(fetchesAtStart + 1);
    expect(h.getWorkflow).not.toHaveBeenCalled();
  });

  test('a run tagged remix:done leaves the tray', async () => {
    h.items = [workflow('a', 0, 'succeeded'), workflow('b', 0, 'succeeded')];
    renderWithProviders(<RemixTray />);
    await expect.element(pill()).toHaveAccessibleName('Remix runs: 0 in progress, 2 ready');

    setCachedWorkflowTag('b-0', 'remix:done', 'add');

    await expect.element(pill()).toHaveAccessibleName('Remix runs: 0 in progress, 1 ready');
  });
});
