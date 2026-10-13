import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as AuthHelpers from '~/utils/auth-helpers';
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
  generatedQuery: vi.fn(),
  openLoginPopup: vi.fn(),
  currentUser: { id: 1 } as { id: number } | null,
}));

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

vi.mock('~/utils/auth-helpers', async (orig) => ({
  ...(await orig<typeof AuthHelpers>()),
  openLoginPopup: mocks.openLoginPopup,
}));

vi.mock('~/utils/trpc', async (orig) => ({
  ...(await orig<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'blockImagePicker.getPosted': { useInfiniteQuery: mocks.postedQuery },
  }),
}));

vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', async (orig) => ({
  ...(await orig<typeof GenerationRequestHooks>()),
  useGetTextToImageRequests: mocks.generatedQuery,
}));

// eslint-disable-next-line import/first
import BlockImagePickerModal from '~/components/AppBlocks/BlockImagePickerModal';
// eslint-disable-next-line import/first
import type { BlockImagePickerSource } from '~/components/AppBlocks/imagePickerLogic';
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
  const fetchNextPage = vi.fn(async () => undefined);
  mocks.postedQuery.mockReturnValue({
    data: { pages: [{ items }] },
    isLoading: false,
    isError: false,
    isFetching: false,
    hasNextPage: false,
    fetchNextPage,
    ...over,
  });
  return fetchNextPage;
}

function setGenerated(outputs: unknown[], over: Record<string, unknown> = {}) {
  mocks.generatedQuery.mockReturnValue({
    data: outputs.length ? [{ succeededOutput: outputs }] : [],
    isFetching: false,
    isFetchingNextPage: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(async () => undefined),
    ...over,
  });
}

function openModal(props: { sources?: BlockImagePickerSource[]; max?: number | null } = {}) {
  const onResolved = vi.fn();
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({
    id: 'image-picker-test',
    component: BlockImagePickerModal,
    props: {
      sources: props.sources ?? ['posted', 'generated'],
      max: props.max ?? null,
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

  test('generated: lists only rated SFW image outputs, and a pick has no imageId', async () => {
    setGenerated([
      output('unrated', { nsfwLevel: undefined }),
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

  test('posted: an image above the SFW ceiling is not listed even if the server returned it', async () => {
    setPosted([postedItem(1, { nsfwLevel: 8 }), postedItem(2)]);
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
