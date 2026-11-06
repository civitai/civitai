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
  post: vi.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
  /** The source's Remix gallery, as `getRemixGalleryVisibility` returns it. */
  gallery: { open: true, price: 50, ownerId: 3, freeSlots: 2, freeSlotsRemaining: 2 },
  allowance: 1,
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
  useOptionalFeatureFlags: () => ({ remixApps: true, remixGallery: true }),
  useFeatureFlags: () => ({ remixApps: true, remixGallery: true }),
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
              opts.enabled && h.price
                ? { prices: ['anime-it', 'restyle'].map((slug) => ({ slug, ...h.price })) }
                : undefined,
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
        'remixApp.post': mutation(h.post),
        'placement.getRemixGalleryVisibility': {
          useQuery: (input: { imageId: number }, opts: { enabled: boolean }) => ({
            data: opts.enabled && input.imageId === 5 ? h.gallery : undefined,
          }),
        },
        'placement.getRemixGalleryFreeEligibility': {
          useQuery: (input: { hostImageId: number }, opts: { enabled: boolean }) => ({
            data:
              opts.enabled && input.hostImageId === 5
                ? {
                    allowance: { remaining: h.allowance, resetsAt: new Date() },
                    usedHere: false,
                    verifiedImageIds: [],
                    teamWaiver: null,
                  }
                : undefined,
          }),
        },
      },
      { orchestrator }
    ),
    trpcVanilla: { orchestrator: { getWorkflow: { query: vi.fn() } } },
  };
});

import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { RemixAppModalContent } from '~/components/Image/Remix/RemixAppModal';
import { RemixTray } from '~/components/Image/Remix/RemixTray';
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
const closeToTray = () => page.getByRole('button', { name: 'Close to tray' });

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  h.items = [];
  h.price = { cost: 25, ready: true };
  // A test that fails before taking its queued answers must not hand them to the next.
  h.start.mockReset();
  h.start.mockImplementation(async () => {
    h.items = [workflow('wf-0', 'processing')];
    return { status: 'running', runId: RUN, workflowId: 'wf-0' };
  });
  h.run.mockImplementation(async () => ({ workflowId: 'wf-team' }));
  h.post.mockResolvedValue({ postId: 77, imageIds: [1], gallery: { submitted: true } });
  h.gallery = { open: true, price: 50, ownerId: 3, freeSlots: 2, freeSlotsRemaining: 2 };
  h.allowance = 1;
});

/** Runs Anime it on image 5 through to its result line. */
async function finishedRun() {
  h.advance.mockResolvedValue({
    status: 'done',
    runId: RUN,
    workflowId: 'wf-0',
    outputs: [{ url: 'https://example.com/out.png' }],
  });
  const screen = await renderWithProviders(
    <RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />
  );
  await runButton().click();
  // Run closed it to the tray; from here it plays as the modal reopened from there.
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  onClose.mockClear();
  await setStatus('wf-0', 'succeeded');
  await expect.element(page.getByTestId('remix-result-line')).toBeVisible();
  return screen;
}

const gallerySwitch = () => page.getByRole('switch', { name: /Remix gallery/ });

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

  test('Run collapses the modal into the tray, which shows the run in progress', async () => {
    function ModalOverTray() {
      const [open, setOpen] = useState(true);
      return (
        <>
          {open && (
            <RemixAppModalContent app={animeIt} imageId={5} onClose={() => setOpen(false)} />
          )}
          <RemixTray />
        </>
      );
    }
    await renderWithProviders(<ModalOverTray />);
    // POSITIVE CONTROL: before Run, the modal is up and the tray has nothing to show.
    await expect.element(closeToTray()).toBeVisible();
    expect(document.querySelector('[data-testid="remix-tray-in-progress"]')).toBeNull();

    await runButton().click();

    await expect.element(page.getByTestId('remix-tray-in-progress')).toHaveTextContent('1');
    // The modal is gone, not left showing its running step.
    await expect.element(closeToTray()).not.toBeInTheDocument();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  test('a team remix is held while it is quoting, and its run sends no team, capped at the price shown', async () => {
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
    // No team (the server reads it from the joins); the price shown is the cap.
    expect(Object.keys(h.run.mock.calls[0][0]).sort()).toEqual([
      'imageId',
      'nonce',
      'quote',
      'slug',
    ]);
    expect(h.run.mock.calls[0][0]).toMatchObject({ slug: TEAM_REMIX_SLUG, imageId: 5, quote: 44 });
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
    // A free answer stays in the modal to show the next step's price.
    expect(onClose).not.toHaveBeenCalled();

    await page.getByRole('button', { name: /^Continue/ }).click();
    await vi.waitFor(() => expect(h.advance).toHaveBeenCalledTimes(3));
    expect(h.advance.mock.calls[2][0]).toEqual({ runId: RUN, answers: ['cool'], quote: 30 });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test('a pick leaves out a take the viewer may not see, and the rest keep their index', async () => {
    h.items = [workflow('wf-0', 'succeeded')];
    const take = (n: number) => ({ url: `https://example.com/take-${n}.png` });
    h.advance
      .mockResolvedValueOnce({
        status: 'ask',
        runId: RUN,
        ask: { kind: 'pick', prompt: 'Pick your favourite', images: [take(1), null, take(3)] },
      })
      .mockResolvedValueOnce({ status: 'running', runId: RUN, workflowId: 'wf-1' });
    await renderWithProviders(
      <RemixAppModalContent
        app={animeIt}
        run={{ runId: RUN, workflowId: 'wf-0' }}
        onClose={onClose}
      />
    );

    await expect.element(page.getByRole('button', { name: 'Pick image 3' })).toBeVisible();
    expect(page.getByRole('button', { name: /^Pick image/ }).elements()).toHaveLength(2);

    await page.getByRole('button', { name: 'Pick image 3' }).click();
    await vi.waitFor(() => expect(h.advance).toHaveBeenCalledTimes(2));
    expect(h.advance.mock.calls[1][0]).toMatchObject({ runId: RUN, answers: [2] });
  });

  test('Finish it shows the picked take, a priced option its price, and a tap runs the step at that price', async () => {
    h.items = [workflow('wf-0', 'succeeded')];
    h.advance
      .mockResolvedValueOnce({
        status: 'ask',
        runId: RUN,
        ask: {
          kind: 'choice',
          prompt: 'Finish it',
          image: { url: 'https://example.com/picked-take.png' },
          options: [
            { value: 'upscale', label: 'Upscale 2×' },
            { value: 'keep', label: 'Keep it' },
          ],
        },
        prices: { upscale: 12, keep: 0 },
      })
      .mockResolvedValueOnce({ status: 'running', runId: RUN, workflowId: 'wf-1' });
    await renderWithProviders(
      <RemixAppModalContent
        app={animeIt}
        run={{ runId: RUN, workflowId: 'wf-0' }}
        onClose={onClose}
      />
    );

    const upscale = page.getByRole('button', { name: /^Upscale 2×/ });
    await expect.element(upscale).toHaveTextContent('12');
    // The picked take, above the options.
    expect(document.querySelector('img[src*="picked-take"]')).not.toBeNull();
    // Free to keep: no price on its button.
    await expect
      .element(page.getByRole('button', { name: 'Keep it' }))
      .toHaveTextContent(/^Keep it$/);

    await upscale.click();
    await vi.waitFor(() => expect(h.advance).toHaveBeenCalledTimes(2));
    expect(h.advance.mock.calls[1][0]).toEqual({ runId: RUN, answers: ['upscale'], quote: 12 });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test('asks before the first step: a skip and a priced style go through start, then it collapses to the tray', async () => {
    const restyle = { slug: 'restyle', name: 'Restyle', runtime: true };
    const text = {
      kind: 'text',
      prompt: 'Add something to the scene (optional)',
      maxLength: 120,
      optional: true,
    };
    const choice = {
      kind: 'choice',
      prompt: 'Pick a style',
      options: [
        { value: 'watercolor', label: 'Watercolor' },
        { value: 'ukiyo-e', label: 'Ukiyo-e' },
      ],
    };
    h.start
      .mockResolvedValueOnce({ status: 'ask', runId: RUN, ask: text })
      .mockResolvedValueOnce({
        status: 'ask',
        runId: RUN,
        ask: choice,
        prices: { watercolor: 25, 'ukiyo-e': 25 },
      })
      .mockResolvedValueOnce({ status: 'running', runId: RUN, workflowId: 'wf-0' });
    await renderWithProviders(<RemixAppModalContent app={restyle} imageId={5} onClose={onClose} />);

    await runButton().click();
    await page.getByRole('button', { name: 'Skip' }).click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
    expect(h.start.mock.calls[1][0]).toMatchObject({ slug: 'restyle', imageId: 5, answers: [''] });
    // A free answer stays in the modal; the style's price is on its button.
    expect(onClose).not.toHaveBeenCalled();
    const ukiyoE = page.getByRole('button', { name: /^Ukiyo-e/ });
    await expect.element(ukiyoE).toHaveTextContent('25');

    await ukiyoE.click();
    await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(3));
    expect(h.start.mock.calls[2][0]).toMatchObject({ answers: ['', 'ukiyo-e'], quote: 25 });
    // The same tap each time: one nonce names one run.
    expect(new Set(h.start.mock.calls.map(([input]) => input.nonce)).size).toBe(1);
    expect(h.advance).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
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

  describe('Post', () => {
    test('posts the run with the free gallery submit on, then takes it off the tray', async () => {
      await finishedRun();
      await expect
        .element(page.getByRole('switch', { name: /^Remix gallery\W+free$/ }))
        .toBeChecked();

      await page.getByRole('button', { name: 'Post' }).click();

      await vi.waitFor(() =>
        expect(h.post).toHaveBeenCalledWith({
          runId: RUN,
          gallery: { hostImageId: 5, method: 'free', expectedPrice: undefined },
        })
      );
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      const queue = queryClient.getQueriesData<{ pages: { items: Item[] }[] }>({
        queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
      });
      const tags = queue.flatMap(([, data]) => data?.pages[0].items[0]?.tags ?? []);
      expect(tags).toContain('remix:done');
    });

    test('a paid gallery is off by default, and turning it on agrees to the price shown', async () => {
      h.allowance = 0;
      await finishedRun();
      await expect.element(gallerySwitch()).not.toBeChecked();

      await page.getByRole('button', { name: 'Post' }).click();
      await vi.waitFor(() =>
        expect(h.post).toHaveBeenLastCalledWith({ runId: RUN, gallery: undefined })
      );

      await gallerySwitch().click();
      await page.getByRole('button', { name: 'Post' }).click();
      await vi.waitFor(() =>
        expect(h.post).toHaveBeenLastCalledWith({
          runId: RUN,
          gallery: { hostImageId: 5, method: 'paid', expectedPrice: 50 },
        })
      );
    });

    test('a switch turned on while free is off again once it would cost Buzz', async () => {
      const screen = await finishedRun();
      await gallerySwitch().click();
      await gallerySwitch().click();
      await expect.element(gallerySwitch()).toBeChecked();

      // Today's free placement is spent elsewhere: the offer becomes the paid one.
      h.allowance = 0;
      await screen.rerender(<RemixAppModalContent app={animeIt} imageId={5} onClose={onClose} />);
      await expect.element(gallerySwitch()).not.toBeChecked();
      await page.getByRole('button', { name: 'Post' }).click();
      await vi.waitFor(() =>
        expect(h.post).toHaveBeenCalledWith({ runId: RUN, gallery: undefined })
      );
    });

    test('no switch on your own image, and Post still posts', async () => {
      h.gallery = { ...h.gallery, ownerId: 9 };
      await finishedRun();
      expect(gallerySwitch().query()).toBeNull();

      await page.getByRole('button', { name: 'Post' }).click();
      await vi.waitFor(() =>
        expect(h.post).toHaveBeenCalledWith({ runId: RUN, gallery: undefined })
      );
    });
  });
});
