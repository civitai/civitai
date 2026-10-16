import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as AuthHelpers from '~/utils/auth-helpers';
import type * as BrowsingLevelProviderModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as GenerationRequestHooks from '~/components/ImageGeneration/utils/generationRequestHooks';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as Trpc from '~/utils/trpc';

/**
 * BlockImagePickerModal — the viewer's side of OPEN_IMAGE_PICKER: which images are listed, how many
 * can be selected, and exactly what `onResolved` is handed. The host's reply shapes are covered in
 * PageBlockHostImagePicker.browser.test.tsx.
 */

const mocks = vi.hoisted(() => ({
  postedQuery: vi.fn(),
  /** Re-renders the component reading the posted query, as a query observer would on new data. */
  postedSubscribers: new Set<() => void>(),
  generatedQuery: vi.fn(),
  openLoginPopup: vi.fn(),
  currentUser: { id: 1 } as { id: number } | null,
  /** PG + PG-13 unless a test widens it. */
  browsingLevel: 3,
  levelSubscribers: new Set<() => void>(),
}));

function setLevel(level: number) {
  mocks.browsingLevel = level;
  mocks.levelSubscribers.forEach((notify) => notify());
}

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

// Outside a provider useSession reports 'loading'; resolved here from the mocked user.
vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({
    data: undefined,
    status: mocks.currentUser ? 'authenticated' : 'unauthenticated',
    update: async () => null,
  }),
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (orig) => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    mocks.levelSubscribers.add(notify);
    return () => void mocks.levelSubscribers.delete(notify);
  };
  return {
    ...(await orig<typeof BrowsingLevelProviderModule>()),
    useViewerBrowsingLevelDebounced: () =>
      useSyncExternalStore(subscribe, () => mocks.browsingLevel),
  };
});

vi.mock('~/utils/auth-helpers', async (orig) => ({
  ...(await orig<typeof AuthHelpers>()),
  openLoginPopup: mocks.openLoginPopup,
}));

vi.mock('~/utils/trpc', async (orig) => {
  const { useEffect, useReducer } = await import('react');
  const usePostedQuery = (...args: unknown[]) => {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      mocks.postedSubscribers.add(rerender);
      return () => void mocks.postedSubscribers.delete(rerender);
    }, []);
    return mocks.postedQuery(...args);
  };
  return {
    ...(await orig<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'blockImagePicker.getPosted': { useInfiniteQuery: usePostedQuery },
    }),
  };
});

vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', async (orig) => ({
  ...(await orig<typeof GenerationRequestHooks>()),
  useGetTextToImageRequests: mocks.generatedQuery,
}));

// eslint-disable-next-line import/first
import BlockImagePickerModal from '~/components/AppBlocks/BlockImagePickerModal';
// eslint-disable-next-line import/first
import {
  PICKER_JUMP_DEBOUNCE_MS,
  type BlockImagePickerSource,
} from '~/components/AppBlocks/imagePickerLogic';
// eslint-disable-next-line import/first
import { DialogProvider } from '~/components/Dialog/DialogProvider';
// eslint-disable-next-line import/first
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';

const CDN = 'https://image.civitai.com/acct';

const postedItem = (n: number, over: Record<string, unknown> = {}) => ({
  imageId: 6000 + n,
  key: `key-${n}`,
  url: `${CDN}/key-${n}/width=1200/key-${n}.jpeg`,
  width: 1200,
  height: 600 + n,
  nsfwLevel: 1,
  ...over,
});

const postedPick = (n: number) => ({
  source: 'posted',
  url: `${CDN}/key-${n}/width=1200/key-${n}.jpeg`,
  width: 1200,
  height: 600 + n,
  nsfwLevel: 1,
  imageId: 6000 + n,
});

const blobUrl = (name: string) =>
  `https://orchestration.civitai.com/v2/consumer/blobs/${name}.jpeg?sig=x`;

const output = (name: string, over: Record<string, unknown> = {}) => ({
  type: 'image',
  url: blobUrl(name),
  width: 832,
  height: 1216,
  nsfwLevel: 'pg',
  ...over,
});

function setPosted(items: unknown[], over: Record<string, unknown> = {}) {
  const fetchNextPage = vi.fn(async (): Promise<unknown> => undefined);
  const refetch = vi.fn(async () => undefined);
  mocks.postedQuery.mockReturnValue({
    data: { pages: [{ items }] },
    isLoading: false,
    isError: false,
    isFetching: false,
    hasNextPage: false,
    fetchNextPage,
    refetch,
    ...over,
  });
  return Object.assign(fetchNextPage, { refetch });
}

function setGenerated(outputs: unknown[], over: Record<string, unknown> = {}) {
  mocks.generatedQuery.mockReturnValue({
    data: outputs.length ? [{ succeededOutput: outputs }] : [],
    isFetching: false,
    isFetchingNextPage: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(async () => undefined),
    refetch: vi.fn(async () => undefined),
    ...over,
  });
}

const LOAD_MORE_NOTE = 'No usable images found in the most recent pages.';

/**
 * Fill a date input, failing as "the harness was too slow" when the fill alone outlasted the
 * debounce: a test that relies on acting before a date is applied means nothing past that point.
 */
async function fillWithinDebounce(input: ReturnType<typeof page.getByLabelText>, value: string) {
  const started = performance.now();
  await userEvent.fill(input, value);
  expect(
    performance.now() - started,
    `the fill took longer than the ${PICKER_JUMP_DEBOUNCE_MS}ms debounce`
  ).toBeLessThan(PICKER_JUMP_DEBOUNCE_MS);
}
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openModal(
  props: { sources?: BlockImagePickerSource[]; max?: number | null; publicOnly?: boolean } = {}
) {
  const onResolved = vi.fn();
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({
    id: 'image-picker-test',
    component: BlockImagePickerModal,
    props: {
      sources: props.sources ?? ['posted', 'generated'],
      max: props.max ?? null,
      ...(props.publicOnly !== undefined ? { publicOnly: props.publicOnly } : {}),
      onResolved,
    },
  });
  return onResolved;
}

const tile = (name: string) => page.getByRole('button', { name, exact: true });
const confirmButton = () => page.getByRole('button', { name: /^Use / });
const dialogIsOpen = () => useDialogStore.getState().dialogs.length === 1;

describe('BlockImagePickerModal', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.currentUser = { id: 1 };
    mocks.browsingLevel = 3;
    mocks.openLoginPopup.mockReset();
    mocks.postedQuery.mockReset();
    mocks.generatedQuery.mockReset();
    setPosted([]);
    setGenerated([]);
  });

  test('offers a tab per source, opening on the first one asked for', async () => {
    setPosted([postedItem(1)]);
    setGenerated([output('gen-a')]);

    openModal({ sources: ['generated', 'posted'] });

    await expect.element(page.getByRole('tab', { name: 'Generated' })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: 'Posted' })).toBeInTheDocument();
    await expect.element(tile('Generated image 1')).toBeInTheDocument();
    expect(tile('Posted image 1').query()).toBeNull();

    await userEvent.click(page.getByRole('tab', { name: 'Posted' }));
    await expect.element(tile('Posted image 1')).toBeInTheDocument();
  });

  test('shows no tabs when one source is offered, and never queries the other', async () => {
    setPosted([postedItem(1)]);

    openModal({ sources: ['posted'] });

    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    expect(page.getByRole('tab').query()).toBeNull();
    expect(mocks.generatedQuery).not.toHaveBeenCalled();
  });

  test('single pick: confirm resolves the one selected image in the contract shape', async () => {
    setPosted([postedItem(1), postedItem(2)]);
    const onResolved = openModal({ sources: ['posted'] });

    await expect.element(confirmButton()).toBeDisabled();
    await userEvent.click(tile('Posted image 2'));
    await expect.element(tile('Posted image 2')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledTimes(1);
    // The storage key the grid renders from is not part of a pick.
    expect(onResolved).toHaveBeenCalledWith([postedPick(2)]);
    expect(dialogIsOpen()).toBe(false);
  });

  test('single pick: selecting another image replaces the selection', async () => {
    setPosted([postedItem(1), postedItem(2)]);
    const onResolved = openModal({ sources: ['posted'] });

    await userEvent.click(tile('Posted image 1'));
    await userEvent.click(tile('Posted image 2'));
    await expect.element(tile('Posted image 1')).toHaveAttribute('aria-pressed', 'false');
    await expect.element(tile('Posted image 2')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledWith([postedPick(2)]);
  });

  test('multi pick: shows the count, stops at max, and resolves in pick order', async () => {
    setPosted([postedItem(1), postedItem(2), postedItem(3)]);
    const onResolved = openModal({ sources: ['posted'], max: 2 });
    const count = page.getByTestId('block-image-picker-count');

    await expect.element(count).toHaveTextContent('0 of 2 selected');
    await userEvent.click(tile('Posted image 3'));
    await expect.element(count).toHaveTextContent('1 of 2 selected');
    await expect.element(tile('Posted image 2')).toBeEnabled();
    await userEvent.click(tile('Posted image 1'));
    await expect.element(count).toHaveTextContent('2 of 2 selected');

    // At the cap the remaining image cannot be added; a selected one can still be removed.
    await expect.element(tile('Posted image 2')).toBeDisabled();
    await expect.element(tile('Posted image 1')).toBeEnabled();
    await userEvent.click(tile('Posted image 2'), { force: true });
    await expect.element(count).toHaveTextContent('2 of 2 selected');

    await userEvent.click(confirmButton());
    expect(onResolved).toHaveBeenCalledWith([postedPick(3), postedPick(1)]);
  });

  test('multi pick: deselecting frees a slot', async () => {
    setPosted([postedItem(1), postedItem(2)]);
    const onResolved = openModal({ sources: ['posted'], max: 1 });

    await userEvent.click(tile('Posted image 1'));
    await expect.element(tile('Posted image 2')).toBeDisabled();
    await userEvent.click(tile('Posted image 1'));
    await expect.element(tile('Posted image 2')).toBeEnabled();
    await userEvent.click(tile('Posted image 2'));
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledWith([postedPick(2)]);
  });

  test('multi pick: a selection can span both sources', async () => {
    setPosted([postedItem(1)]);
    setGenerated([output('gen-a')]);
    const onResolved = openModal({ max: 5 });

    await userEvent.click(tile('Posted image 1'));
    await userEvent.click(page.getByRole('tab', { name: 'Generated' }));
    await userEvent.click(tile('Generated image 1'));
    await expect
      .element(page.getByTestId('block-image-picker-count'))
      .toHaveTextContent('2 of 5 selected');
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledWith([
      postedPick(1),
      { source: 'generated', url: blobUrl('gen-a'), width: 832, height: 1216, nsfwLevel: 1 },
    ]);
  });

  test('generated: a level change starts the empty-page count again', async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    setGenerated([output('mature', { nsfwLevel: 'r' })], { hasNextPage: true, fetchNextPage });

    openModal({ sources: ['generated'] });
    // Control: nothing is pickable at PG / PG-13, so the bound is reached.
    await expect.element(page.getByText(LOAD_MORE_NOTE), { timeout: 8000 }).toBeInTheDocument();

    // The viewer now browses at R: the output already loaded becomes pickable without a fetch.
    setLevel(7);
    await expect.element(tile('Generated image 1')).toBeInTheDocument();
    // The count is cleared in an effect, one render after the image appears.
    await expect.element(page.getByText(LOAD_MORE_NOTE)).not.toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Load more' }).query()).toBeNull();
  });

  test('generated: lists only rated image outputs at a level the viewer browses at', async () => {
    setGenerated([
      output('unrated', { nsfwLevel: undefined }),
      output('prototype', { nsfwLevel: 'constructor' }),
      output('mature', { nsfwLevel: 'r' }),
      output('clip', { type: 'video' }),
      output('sfw', { nsfwLevel: 'pg13' }),
    ]);
    const onResolved = openModal({ sources: ['generated'] });

    await expect.element(tile('Generated image 1')).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^Generated image / }).elements()).toHaveLength(1);
    await userEvent.click(tile('Generated image 1'));
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledWith([
      { source: 'generated', url: blobUrl('sfw'), width: 832, height: 1216, nsfwLevel: 2 },
    ]);
  });

  test('generated: a mature output is listed for a viewer who browses at that level', async () => {
    mocks.browsingLevel = 7;
    setGenerated([
      output('unrated', { nsfwLevel: undefined }),
      output('mature', { nsfwLevel: 'r' }),
      output('explicit', { nsfwLevel: 'x' }),
      output('sfw', { nsfwLevel: 'pg13' }),
    ]);
    const onResolved = openModal({ sources: ['generated'], max: 5 });

    await expect.element(tile('Generated image 2')).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^Generated image / }).elements()).toHaveLength(2);
    await userEvent.click(tile('Generated image 1'));
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledWith([
      { source: 'generated', url: blobUrl('mature'), width: 832, height: 1216, nsfwLevel: 4 },
    ]);
  });

  test('posted: asks the server for public posts only when the app asked for publicOnly', async () => {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'], publicOnly: true });

    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    for (const [input] of mocks.postedQuery.mock.calls) expect(input).toEqual({ publicOnly: true });
    await expect
      .element(page.getByText(/Posted images are limited to public posts/))
      .toBeInTheDocument();
  });

  test('posted: publicOnly is kept when the viewer jumps to a date', async () => {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'], publicOnly: true });
    await expect.element(tile('Posted image 1')).toBeInTheDocument();

    await userEvent.fill(page.getByLabelText('Jump to date'), '2024-06-30');
    await vi.waitFor(
      () =>
        expect(mocks.postedQuery).toHaveBeenLastCalledWith(
          { toDate: new Date(2024, 5, 30, 23, 59, 59, 999), publicOnly: true },
          expect.anything()
        ),
      { timeout: 5000 }
    );
  });

  test('a generated-only publicOnly picker says nothing about posts', async () => {
    setGenerated([]);
    openModal({ sources: ['generated'], publicOnly: true });

    await expect.element(page.getByText(/finished scanning/)).toBeInTheDocument();
    await expect
      .element(page.getByText(/Posted images are limited to public posts/))
      .not.toBeInTheDocument();
  });

  test('posted: without publicOnly the server is asked exactly as before', async () => {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'], publicOnly: false });

    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    expect(mocks.postedQuery).toHaveBeenCalled();
    for (const [input] of mocks.postedQuery.mock.calls) expect(input).toEqual({});
  });

  test('posted: lists what the server returned, whatever its level', async () => {
    setPosted([postedItem(1, { nsfwLevel: 8 })]);
    const onResolved = openModal({ sources: ['posted'] });

    await userEvent.click(tile('Posted image 1'));
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledWith([{ ...postedPick(1), nsfwLevel: 8 }]);
  });

  test('posted: an image whose url is not Civitai-hosted is not listed', async () => {
    setPosted([postedItem(1, { url: '/key-1/width=1200/key-1.jpeg' }), postedItem(2)]);
    const onResolved = openModal({ sources: ['posted'] });

    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^Posted image / }).elements()).toHaveLength(1);
    await userEvent.click(tile('Posted image 1'));
    await userEvent.click(confirmButton());

    expect(onResolved).toHaveBeenCalledWith([postedPick(2)]);
  });

  test('each tab has its own empty state', async () => {
    openModal();

    await expect
      .element(page.getByText('None of your posted images can be used here yet.'))
      .toBeInTheDocument();
    await userEvent.click(page.getByRole('tab', { name: 'Generated' }));
    await expect
      .element(page.getByText('None of your generated images can be used here yet.'))
      .toBeInTheDocument();
  });

  test('loads the next page while more remain', async () => {
    const fetchNextPage = setPosted([postedItem(1)], { hasNextPage: true });

    openModal({ sources: ['posted'] });

    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    await vi.waitFor(() => expect(fetchNextPage).toHaveBeenCalled(), { timeout: 6000 });
  });

  test('a page with nothing pickable keeps loading instead of reporting an empty library', async () => {
    const fetchNextPage = setPosted([], { hasNextPage: true });

    openModal({ sources: ['posted'] });

    await vi.waitFor(() => expect(fetchNextPage).toHaveBeenCalled(), { timeout: 6000 });
    expect(page.getByText('None of your posted images can be used here yet.').query()).toBeNull();
  });

  test('stops loading by itself after 3 pages in a row add nothing, and offers a button', async () => {
    const fetchNextPage = setPosted([], { hasNextPage: true });

    openModal({ sources: ['posted'] });

    const loadMore = page.getByRole('button', { name: 'Load more' });
    await expect.element(loadMore, { timeout: 8000 }).toBeInTheDocument();
    await expect.element(page.getByText(LOAD_MORE_NOTE)).toBeInTheDocument();
    expect(fetchNextPage).toHaveBeenCalledTimes(3);

    // Long enough for two more automatic loads, had the bound not held.
    await settle(1300);
    expect(fetchNextPage).toHaveBeenCalledTimes(3);

    await userEvent.click(loadMore);
    await vi.waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(4));
    await expect.element(loadMore).toBeInTheDocument();
  });

  test('the same bound holds on the generated tab', async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    setGenerated([output('unrated', { nsfwLevel: undefined })], {
      hasNextPage: true,
      fetchNextPage,
    });

    openModal({ sources: ['generated'] });

    await expect
      .element(page.getByRole('button', { name: 'Load more' }), { timeout: 8000 })
      .toBeInTheDocument();
    expect(fetchNextPage).toHaveBeenCalledTimes(3);
    await settle(1300);
    expect(fetchNextPage).toHaveBeenCalledTimes(3);
  });

  test('keeps loading by itself while each page adds an image', async () => {
    // As the real query does, the first page keeps its identity while later pages arrive.
    const pages = [{ items: [postedItem(1)] }];
    const fetchNextPage = setPosted([], { hasNextPage: true, data: { pages } });
    fetchNextPage.mockImplementation(async () => {
      pages.push({ items: [postedItem(pages.length + 1)] });
      setPosted([], {
        hasNextPage: pages.length < 6,
        fetchNextPage,
        data: { pages: [...pages] },
      });
      mocks.postedSubscribers.forEach((rerender) => rerender());
    });

    openModal({ sources: ['posted'] });

    // Five loads in a row, past the bound of three, because none of them was empty.
    await expect.element(tile('Posted image 6'), { timeout: 10000 }).toBeInTheDocument();
    expect(fetchNextPage).toHaveBeenCalledTimes(5);
    expect(page.getByRole('button', { name: 'Load more' }).query()).toBeNull();
  });

  test('a failed page stops the automatic loading and offers a retry', async () => {
    const fetchNextPage = setPosted([postedItem(1)], { hasNextPage: true, isError: true });

    openModal({ sources: ['posted'] });

    const retry = page.getByRole('button', { name: 'Retry' });
    await expect.element(retry).toBeInTheDocument();
    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    // Past the loader's start-up delay and two of its intervals.
    await settle(2600);
    expect(fetchNextPage).not.toHaveBeenCalled();

    await userEvent.click(retry);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(fetchNextPage.refetch).not.toHaveBeenCalled();
  });

  test('an image loaded by Retry clears the empty-page count, so loading carries on by itself', async () => {
    const items: unknown[] = [];
    // As the real query does, the first page keeps its identity while later pages arrive.
    const pages: Array<{ items: unknown[] }> = [{ items: [] }];
    const fetchNextPage = setPosted([], { hasNextPage: true, data: { pages } });
    const answer = (over: Record<string, unknown>) => {
      setPosted([], { hasNextPage: true, fetchNextPage, data: { pages: [...pages] }, ...over });
      mocks.postedSubscribers.forEach((rerender) => rerender());
    };
    fetchNextPage.mockImplementation(async () => {
      const call = fetchNextPage.mock.calls.length;
      // Three empty pages (the bound), a failed page, then pages with an image each.
      if (call <= 3) return;
      if (call === 4) return answer({ isError: true });
      items.push(postedItem(items.length + 1));
      pages.push({ items: [items[items.length - 1]] });
      answer({ hasNextPage: items.length < 3 });
    });

    openModal({ sources: ['posted'] });

    // The bound is reached, so the fourth page is asked for by hand, and fails.
    const loadMore = page.getByRole('button', { name: 'Load more' });
    await expect.element(loadMore, { timeout: 8000 }).toBeInTheDocument();
    await userEvent.click(loadMore);
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect.element(retry).toBeInTheDocument();
    expect(fetchNextPage).toHaveBeenCalledTimes(4);

    await userEvent.click(retry);
    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    expect(page.getByText(LOAD_MORE_NOTE).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Load more' }).query()).toBeNull();
    // ...and the next pages load without a click.
    await expect.element(tile('Posted image 3'), { timeout: 8000 }).toBeInTheDocument();
    expect(page.getByText(LOAD_MORE_NOTE).query()).toBeNull();
  });

  test('a failed page does not count as an empty one', async () => {
    const items: unknown[] = [];
    // As the real query does, the first page keeps its identity while later pages arrive.
    const pages: Array<{ items: unknown[] }> = [{ items: [] }];
    const fetchNextPage = setPosted([], { hasNextPage: true, data: { pages } });
    const answer = (over: Record<string, unknown>) => {
      setPosted([], { hasNextPage: true, fetchNextPage, data: { pages: [...pages] }, ...over });
      mocks.postedSubscribers.forEach((rerender) => rerender());
    };
    fetchNextPage.mockImplementation(async () => {
      const call = fetchNextPage.mock.calls.length;
      // One empty page, a failed page, an empty retry: two empty pages in all, under the bound of
      // three, so the page after them is still loaded without a click.
      if (call === 1) return;
      if (call === 2) return answer({ isError: true });
      if (call === 3) return answer({ isError: false });
      items.push(postedItem(1));
      pages.push({ items: [items[0]] });
      answer({ hasNextPage: false });
    });

    openModal({ sources: ['posted'] });

    const retry = page.getByRole('button', { name: 'Retry' });
    await expect.element(retry, { timeout: 8000 }).toBeInTheDocument();
    await userEvent.click(retry);

    await expect.element(tile('Posted image 1'), { timeout: 8000 }).toBeInTheDocument();
    expect(fetchNextPage).toHaveBeenCalledTimes(4);
  });

  test('a failed first load offers a retry that refetches', async () => {
    const fetchNextPage = setPosted([], { data: undefined, isError: true });

    openModal({ sources: ['posted'] });

    await userEvent.click(page.getByRole('button', { name: 'Retry' }));
    expect(fetchNextPage.refetch).toHaveBeenCalledTimes(1);
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  test('cancel closes without resolving', async () => {
    setPosted([postedItem(1)]);
    const onResolved = openModal({ sources: ['posted'] });

    await userEvent.click(tile('Posted image 1'));
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));

    expect(dialogIsOpen()).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });

  test('signed out: offers sign-in, lists nothing, and closes without resolving', async () => {
    mocks.currentUser = null;
    setPosted([postedItem(1)]);
    const onResolved = openModal();

    await expect.element(page.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(mocks.postedQuery).not.toHaveBeenCalled();
    expect(mocks.generatedQuery).not.toHaveBeenCalled();
    expect(mocks.openLoginPopup).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole('button', { name: 'Sign in' }));

    expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1);
    expect(dialogIsOpen()).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });
});

const postedTiles = () => page.getByRole('button', { name: /^Posted image / }).elements();

describe('BlockImagePickerModal: tray, jump to date, tile labels', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.currentUser = { id: 1 };
    mocks.browsingLevel = 3;
    mocks.postedQuery.mockReset();
    mocks.generatedQuery.mockReset();
    setPosted([]);
    setGenerated([]);
  });

  // Regression: at origin/main there is no tray, so a pick on the other tab is invisible.
  test('multi pick: the tray shows picks from both tabs, and removing one deselects it', async () => {
    setPosted([postedItem(1), postedItem(2)]);
    setGenerated([output('gen-a')]);
    const onResolved = openModal({ max: 5 });

    await userEvent.click(tile('Posted image 2'));
    await userEvent.click(page.getByRole('tab', { name: 'Generated' }));
    await userEvent.click(tile('Generated image 1'));

    const tray = page.getByRole('list', { name: 'Selected images' });
    const removePosted = tray.getByRole('button', { name: 'Remove selected image 1 (Posted)' });
    await expect.element(removePosted).toBeInTheDocument();
    await expect
      .element(tray.getByRole('button', { name: 'Remove selected image 2 (Generated)' }))
      .toBeInTheDocument();
    expect(tray.getByRole('listitem').elements()).toHaveLength(2);

    await userEvent.click(removePosted);
    const count = page.getByTestId('block-image-picker-count');
    await expect.element(count).toHaveTextContent('1 of 5 selected');
    expect(tray.getByRole('listitem').elements()).toHaveLength(1);
    await userEvent.click(page.getByRole('tab', { name: 'Posted' }));
    await expect.element(tile('Posted image 2')).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(confirmButton());
    expect(onResolved).toHaveBeenCalledWith([
      { source: 'generated', url: blobUrl('gen-a'), width: 832, height: 1216, nsfwLevel: 1 },
    ]);
  });

  // Invariant guard (no tray at origin/main either): a single pick has nothing to collect.
  test('single pick: no tray', async () => {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'] });

    await userEvent.click(tile('Posted image 1'));
    await expect.element(tile('Posted image 1')).toHaveAttribute('aria-pressed', 'true');
    expect(page.getByTestId('block-image-picker-tray').query()).toBeNull();
  });

  // Regression: at origin/main there is no way to start the list anywhere but the newest image.
  test('jumping to a date asks the posted list for that day, and keeps the picks', async () => {
    const newest = { data: { pages: [{ items: [postedItem(1), postedItem(2)] }] } };
    const older = { data: { pages: [{ items: [postedItem(30)] }] } };
    mocks.postedQuery.mockImplementation((input: { toDate?: Date }) => ({
      isLoading: false,
      isError: false,
      isFetching: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(async () => undefined),
      refetch: vi.fn(async () => undefined),
      // A new first page for a new date, as the real query gives: the list is replaced.
      ...(input.toDate ? older : newest),
    }));
    const onResolved = openModal({ sources: ['posted'], max: 5 });

    await userEvent.click(tile('Posted image 2'));
    await userEvent.fill(page.getByLabelText('Jump to date'), '2024-06-30');

    await vi.waitFor(
      () =>
        expect(mocks.postedQuery).toHaveBeenLastCalledWith(
          { toDate: new Date(2024, 5, 30, 23, 59, 59, 999) },
          expect.anything()
        ),
      { timeout: 5000 }
    );
    await expect.element(tile('Posted image 1')).toHaveAttribute('aria-pressed', 'false');
    expect(postedTiles()).toHaveLength(1);
    const count = page.getByTestId('block-image-picker-count');
    await expect.element(count).toHaveTextContent('1 of 5 selected');

    await userEvent.click(page.getByRole('button', { name: 'Back to newest' }));
    await vi.waitFor(
      () => expect(mocks.postedQuery).toHaveBeenLastCalledWith({}, expect.anything()),
      { timeout: 5000 }
    );
    await expect.element(tile('Posted image 2')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(confirmButton());
    expect(onResolved).toHaveBeenCalledWith([postedPick(2)]);
  });

  // Regression: at origin/main the generated tab has no date control.
  test('jumping to a date asks the generated list for that day', async () => {
    setGenerated([output('gen-a')]);
    openModal({ sources: ['generated'] });

    await expect.element(tile('Generated image 1')).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText('Jump to date'), '2025-01-05');

    await vi.waitFor(
      () =>
        expect(mocks.generatedQuery).toHaveBeenLastCalledWith(
          { tags: ['img'], toDate: new Date(2025, 0, 5, 23, 59, 59, 999) },
          { enabled: true, ignoreFilters: true }
        ),
      { timeout: 5000 }
    );
  });

  // Regression: at origin/main a tile was named by its index alone.
  test('labels a tile with when the image was posted', async () => {
    setPosted([postedItem(1, { createdAt: new Date(2024, 5, 30, 12) })]);
    openModal({ sources: ['posted'] });

    await expect
      .element(page.getByRole('button', { name: 'Posted image 1, Jun 30, 2024', exact: true }))
      .toBeInTheDocument();
  });

  test('shows the posted date on the tile itself, not only in its label', async () => {
    setPosted([postedItem(1, { createdAt: new Date(2024, 5, 30, 12) }), postedItem(2)]);
    openModal({ sources: ['posted'] });

    const dated = page.getByRole('button', { name: 'Posted image 1, Jun 30, 2024', exact: true });
    await expect.element(dated).toHaveTextContent('Jun 30, 2024');
    // An undated image shows no date at all, not today's.
    await expect.element(tile('Posted image 2')).toBeInTheDocument();
    expect(tile('Posted image 2').element().textContent).toBe('');
  });

  test('shows the generated date on the tile, from the workflow it came with', async () => {
    mocks.generatedQuery.mockReturnValue({
      data: [{ createdAt: new Date(2025, 0, 5, 9), succeededOutput: [output('gen-a')] }],
      isFetching: false,
      isFetchingNextPage: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(async () => undefined),
      refetch: vi.fn(async () => undefined),
    });
    openModal({ sources: ['generated'] });

    await expect
      .element(page.getByRole('button', { name: 'Generated image 1, Jan 5, 2025', exact: true }))
      .toHaveTextContent('Jan 5, 2025');
  });

  // Invariant guard (red at origin/main only because there is no date control).
  test('a date with nothing on or before it says so, and offers the way back', async () => {
    mocks.postedQuery.mockImplementation((input: { toDate?: Date }) => ({
      data: { pages: [{ items: input.toDate ? [] : [postedItem(1)] }] },
      isLoading: false,
      isError: false,
      isFetching: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(async () => undefined),
      refetch: vi.fn(async () => undefined),
    }));
    openModal({ sources: ['posted'] });

    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText('Jump to date'), '2001-01-01');
    await expect
      .element(
        page.getByText('None of your images from on or before this date can be used here.'),
        {
          timeout: 5000,
        }
      )
      .toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Back to newest' }));
    await expect.element(tile('Posted image 1')).toBeInTheDocument();
  });

  // Regression: a year still being typed is not applied, so the grid does not flash empty for it.
  test('a half-typed year is not applied', async () => {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'] });

    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText('Jump to date'), '0202-06-30');
    // The input really holds the half-typed year, so the absence below is not a dropped fill.
    await expect.element(page.getByLabelText('Jump to date')).toHaveValue('0202-06-30');
    await settle(PICKER_JUMP_DEBOUNCE_MS * 2);
    for (const [input] of mocks.postedQuery.mock.calls) expect(input).toEqual({});
  });

  // A date is applied once it holds still, not on every change; an emptied input on blur.
  test('a date is applied after it holds still, and an emptied input returns to newest on blur', async () => {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'] });
    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    const input = page.getByLabelText('Jump to date');

    await fillWithinDebounce(input, '2024-06-30');
    // Straight after the change: not applied yet.
    expect(mocks.postedQuery).not.toHaveBeenCalledWith(
      { toDate: expect.anything() },
      expect.anything()
    );
    await vi.waitFor(
      () =>
        expect(mocks.postedQuery).toHaveBeenLastCalledWith(
          { toDate: new Date(2024, 5, 30, 23, 59, 59, 999) },
          expect.anything()
        ),
      { timeout: 5000 }
    );

    await userEvent.clear(input);
    await expect.element(input).toHaveValue('');
    // Click away: Tab inside a native date input only moves between its own parts.
    await userEvent.click(page.getByText('Choose an image'));
    expect(document.activeElement).not.toBe(input.element());
    await vi.waitFor(
      () => expect(mocks.postedQuery).toHaveBeenLastCalledWith({}, expect.anything()),
      { timeout: 5000 }
    );
  });

  const JUNE_30 = { toDate: new Date(2024, 5, 30, 23, 59, 59, 999) };
  const JULY_15 = { toDate: new Date(2024, 6, 15, 23, 59, 59, 999) };
  const boundsQueried = () =>
    mocks.postedQuery.mock.calls.map(([input]) => (input as { toDate?: Date }).toDate?.getTime());

  async function applyJune30() {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'] });
    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText('Jump to date'), '2024-06-30');
    await vi.waitFor(
      () => expect(mocks.postedQuery).toHaveBeenLastCalledWith(JUNE_30, expect.anything()),
      { timeout: 5000 }
    );
  }

  test('Back to newest cancels a date still waiting to be applied', async () => {
    await applyJune30();
    const started = performance.now();
    await userEvent.fill(page.getByLabelText('Jump to date'), '2024-07-15');
    await userEvent.click(page.getByRole('button', { name: 'Back to newest' }));
    expect(
      performance.now() - started,
      `fill + click took longer than the ${PICKER_JUMP_DEBOUNCE_MS}ms debounce`
    ).toBeLessThan(PICKER_JUMP_DEBOUNCE_MS);
    await settle(PICKER_JUMP_DEBOUNCE_MS * 2);

    expect(mocks.postedQuery).toHaveBeenLastCalledWith({}, expect.anything());
    expect(boundsQueried()).not.toContain(JULY_15.toDate.getTime());
  });

  test('a date emptied before it settles is never applied', async () => {
    setPosted([postedItem(1)]);
    openModal({ sources: ['posted'] });
    await expect.element(tile('Posted image 1')).toBeInTheDocument();
    const input = page.getByLabelText('Jump to date');
    const started = performance.now();
    await userEvent.fill(input, '2024-06-30');
    await userEvent.clear(input);
    expect(
      performance.now() - started,
      `fill + clear took longer than the ${PICKER_JUMP_DEBOUNCE_MS}ms debounce`
    ).toBeLessThan(PICKER_JUMP_DEBOUNCE_MS);
    await settle(PICKER_JUMP_DEBOUNCE_MS * 2);

    expect(boundsQueried().filter((bound) => bound !== undefined)).toEqual([]);
  });

  test('blurring a half-edited date keeps the date that is applied', async () => {
    await applyJune30();
    const input = page.getByLabelText('Jump to date');
    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}');
    // The setup really produced a half-edited field, not an empty one.
    expect((input.element() as HTMLInputElement).validity.badInput).toBe(true);
    await userEvent.click(page.getByText('Choose an image'));
    await settle(PICKER_JUMP_DEBOUNCE_MS * 2);

    expect(mocks.postedQuery).toHaveBeenLastCalledWith(JUNE_30, expect.anything());
  });
});
