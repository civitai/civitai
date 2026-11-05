import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

type Item = { id: string; status: string; tags: string[]; createdAt: string; steps: [] };
type Price = { cost: number; ready: boolean } | { refusal: string };
type State = Record<string, unknown> & { status: string; runId: string };

const h = vi.hoisted(() => ({
  items: [] as Item[],
  /** `undefined` = the quote is still loading. */
  price: undefined as Price | undefined,
  start: vi.fn<(input: Record<string, unknown>) => Promise<State>>(),
  run: vi.fn<(input: Record<string, unknown>) => Promise<{ workflowId: string }>>(),
  advance: vi.fn<(input: Record<string, unknown>) => Promise<State>>(),
  patch: vi.fn<(input: unknown) => Promise<void>>(async () => undefined),
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
  useFeatureFlags: () => ({ remixApps: true }),
}));
vi.mock('~/components/Signals/SignalsProvider', async (orig) => ({
  ...(await orig<object>()),
  useSignalConnection: () => undefined,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useInfiniteQuery, useMutation } = await import('@tanstack/react-query');
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const original = await importOriginal<typeof Trpc>();
  const realOrchestrator = original.trpc.orchestrator as unknown as Record<string, object>;
  const mutation = (fn: (input: never) => Promise<unknown>) => ({
    useMutation: () =>
      useMutation({ mutationFn: (input: never) => fn(input) }, original.queryClient),
  });
  // The real router, so the queue query and its invalidations use the generator's own keys.
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
                      queryFn: async () => ({ items: h.items, nextCursor: undefined }),
                      initialPageParam: undefined,
                      getNextPageParam: () => undefined,
                      ...options,
                    },
                    original.queryClient
                  )
              : (proc as Record<string | symbol, unknown>)[name],
        });
      if (key === 'patch') return mutation(h.patch);
      return target[key];
    },
  });
  const quoted = () =>
    h.price
      ? { isLoading: false, isError: false, isSuccess: true }
      : { isLoading: true, isError: false, isSuccess: false };
  return {
    ...original,
    trpc: makeTrpcProxy(
      {
        'remixApp.quote': {
          useQuery: (_input: unknown, opts: { enabled: boolean }) => ({
            ...quoted(),
            data:
              opts.enabled && h.price ? { prices: [{ slug: 'anime-it', ...h.price }] } : undefined,
          }),
        },
        'remixApp.teamQuote': {
          useQuery: (_input: unknown, opts: { enabled: boolean }) => ({
            ...quoted(),
            data: opts.enabled && h.price ? { team: 'Pink', price: h.price } : undefined,
          }),
        },
        'remixApp.start': mutation(h.start),
        'remixApp.run': mutation(h.run),
        'remixApp.advance': mutation(h.advance),
      },
      { orchestrator }
    ),
    trpcVanilla: { orchestrator: { getWorkflow: { query: vi.fn() } } },
  };
});

import { getQueryKey } from '@trpc/react-query';
import { RemixAppModalContent } from '~/components/Image/Remix/RemixAppModal';
import { TEAM_REMIX_SLUG } from '~/shared/constants/remix-apps.constants';
import { queryClient, trpc } from '~/utils/trpc';

const RUN = 'r00000000000000000001';
const animeIt = { slug: 'anime-it', name: 'Anime it', runtime: true };
const team = { slug: TEAM_REMIX_SLUG, name: 'Remix for Team Pink', runtime: false };

function workflow(id: string, status: string): Item {
  return {
    id,
    status,
    tags: ['gen', 'remix-app', 'remix-app:anime-it', `remix-run:${RUN}`, 'remix-seg:0'],
    createdAt: new Date(2026, 10, 5).toISOString(),
    steps: [],
  };
}

/** The queue learns a workflow's new status, as its signals would tell it. */
async function setStatus(id: string, status: string) {
  h.items = h.items.map((item) => (item.id === id ? { ...item, status } : item));
  await queryClient.invalidateQueries({
    queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
  });
}

const runButton = () => page.getByRole('button', { name: /^Run/ });
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  h.items = [];
  h.price = { cost: 25, ready: true };
  h.start.mockImplementation(async () => {
    h.items = [workflow('wf-0', 'processing')];
    return { status: 'running', runId: RUN, workflowId: 'wf-0' };
  });
  h.run.mockImplementation(async () => ({ workflowId: 'wf-team' }));
});

describe('RemixAppModal', () => {
  test('Run is held while the price loads, then starts the run capped at the price shown', async () => {
    h.price = undefined;
    const screen = await renderWithProviders(
      <RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />
    );
    await expect.element(runButton()).toBeDisabled();
    (runButton().element() as HTMLElement).click();
    expect(h.start).not.toHaveBeenCalled();

    // POSITIVE CONTROL: the same button, priced, runs.
    h.price = { cost: 25, ready: true };
    await screen.rerender(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
    await runButton().click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
    expect(h.start.mock.calls[0][0]).toMatchObject({ slug: 'anime-it', imageId: 5, quote: 25 });
    await expect.element(page.getByTestId('remix-running')).toBeVisible();
  });

  test('a team remix is held while it is quoting, and its run sends no team', async () => {
    h.price = undefined;
    const screen = await renderWithProviders(
      <RemixAppModalContent app={team} imageId={5} onClose={onClose} />
    );
    await expect.element(runButton()).toBeDisabled();
    (runButton().element() as HTMLElement).click();
    expect(h.run).not.toHaveBeenCalled();

    h.price = { cost: 44, ready: true };
    await screen.rerender(<RemixAppModalContent app={team} imageId={5} onClose={onClose} />);
    await expect.element(runButton()).toBeEnabled();
    await runButton().click();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(Object.keys(h.run.mock.calls[0][0]).sort()).toEqual(['imageId', 'nonce', 'slug']);
    expect(h.run.mock.calls[0][0]).toMatchObject({ slug: TEAM_REMIX_SLUG, imageId: 5 });
  });

  test('a started run refetches the queue, so the tray and the queue list it', async () => {
    const queueKey = getQueryKey(
      trpc.orchestrator.queryGeneratedImages,
      { tags: ['x'] },
      'infinite'
    );
    queryClient.setQueryData(queueKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [],
    });
    const invalidated = () => queryClient.getQueryState(queueKey)?.isInvalidated;
    // POSITIVE CONTROL: the seeded list is live, so a refetch mark can only come from the run.
    expect(invalidated()).toBe(false);

    await renderWithProviders(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
    await runButton().click();
    await vi.waitFor(() => expect(invalidated()).toBe(true));
  });

  test('a finished segment asks the server what is next, then shows the result line', async () => {
    h.advance.mockResolvedValue({
      status: 'done',
      runId: RUN,
      workflowId: 'wf-0',
      outputs: [{ url: 'https://example.com/out.png' }],
    });
    await renderWithProviders(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
    await runButton().click();
    await expect.element(page.getByTestId('remix-running')).toBeVisible();
    // Still running: nothing is asked yet.
    expect(h.advance).not.toHaveBeenCalled();

    await setStatus('wf-0', 'succeeded');
    await vi.waitFor(() => expect(h.advance).toHaveBeenCalledWith({ runId: RUN }));
    await expect.element(page.getByTestId('remix-result-line')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Post' })).toBeEnabled();
  });

  test('Remix again offers a new run, with a new nonce', async () => {
    h.advance.mockResolvedValue({
      status: 'failed',
      runId: RUN,
      workflowId: 'wf-0',
      reason: 'This step failed.',
    });
    await renderWithProviders(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
    await runButton().click();
    await setStatus('wf-0', 'failed');
    await expect.element(page.getByText('This step failed.')).toBeVisible();
    // A failed run can't be posted.
    await expect.element(page.getByRole('button', { name: 'Post' })).toBeDisabled();

    await page.getByRole('button', { name: 'Remix again' }).click();
    await runButton().click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
    const [first, second] = h.start.mock.calls.map(([input]) => input.nonce);
    expect(second).not.toBe(first);
  });

  test('a retry after a failed Run repeats the same tap, so it can only make one run', async () => {
    h.start.mockRejectedValueOnce(new Error('network'));
    await renderWithProviders(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
    await runButton().click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
    // POSITIVE CONTROL: the failure left the offer on screen, ready to retry.
    await expect.element(runButton()).toBeEnabled();

    await runButton().click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
    const [first, second] = h.start.mock.calls.map(([input]) => input.nonce);
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });

  test('a second tap while the first is starting sends nothing', async () => {
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.start.mockImplementationOnce(async () => {
      await held;
      h.items = [workflow('wf-0', 'processing')];
      return { status: 'running', runId: RUN, workflowId: 'wf-0' };
    });
    await renderWithProviders(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
    await runButton().click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
    (runButton().element() as HTMLElement).click();
    release();
    await expect.element(page.getByTestId('remix-running')).toBeVisible();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  test('each opening of the modal is a new tap', async () => {
    const first = await renderWithProviders(
      <RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />
    );
    await runButton().click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
    await first.unmount();

    await renderWithProviders(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
    await runButton().click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
    const [a, b] = h.start.mock.calls.map(([input]) => input.nonce);
    expect(b).not.toBe(a);
  });

  test('an ask is answered without spending, then the next step runs at the price shown', async () => {
    h.items = [workflow('wf-0', 'succeeded')];
    h.advance
      .mockResolvedValueOnce({
        status: 'ask',
        runId: RUN,
        ask: {
          kind: 'choice',
          prompt: 'Which style?',
          options: [
            { value: 'warm', label: 'Warm' },
            { value: 'cool', label: 'Cool' },
          ],
        },
      })
      .mockResolvedValueOnce({ status: 'priced', runId: RUN, cost: 30, ready: true })
      .mockResolvedValueOnce({ status: 'running', runId: RUN, workflowId: 'wf-1' });
    await renderWithProviders(
      <RemixAppModalContent
        app={animeIt}
        run={{ runId: RUN, workflowId: 'wf-0' }}
        onClose={onClose}
      />
    );

    await page.getByRole('button', { name: 'Cool' }).click();
    await vi.waitFor(() => expect(h.advance).toHaveBeenCalledTimes(2));
    expect(h.advance.mock.calls[1][0]).toEqual({ runId: RUN, answers: ['cool'] });

    await page.getByRole('button', { name: /^Continue/ }).click();
    await vi.waitFor(() => expect(h.advance).toHaveBeenCalledTimes(3));
    expect(h.advance.mock.calls[2][0]).toEqual({ runId: RUN, answers: ['cool'], quote: 30 });
    await expect.element(page.getByTestId('remix-running')).toBeVisible();
  });

  test('⋯ Dismiss adds remix:dismissed to the run and closes', async () => {
    h.items = [workflow('wf-0', 'processing')];
    await renderWithProviders(
      <RemixAppModalContent
        app={animeIt}
        run={{ runId: RUN, workflowId: 'wf-0' }}
        onClose={onClose}
      />
    );
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Dismiss' }).click();

    await vi.waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith({
        tags: [{ workflowId: 'wf-0', tag: 'remix:dismissed', op: 'add' }],
      })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('✕ closes to the tray and leaves the run alone', async () => {
    h.items = [workflow('wf-0', 'processing')];
    await renderWithProviders(
      <RemixAppModalContent
        app={animeIt}
        run={{ runId: RUN, workflowId: 'wf-0' }}
        onClose={onClose}
      />
    );
    // POSITIVE CONTROL: the run is live, so its ⋯ menu is on screen.
    await expect.element(page.getByRole('button', { name: 'More' })).toBeVisible();
    await page.getByRole('button', { name: 'Close to tray' }).click();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.patch).not.toHaveBeenCalled();
  });
});
