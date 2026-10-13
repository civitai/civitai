import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as BrowsingLevelProviderModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as CivitaiSessionProviderModule from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import type * as DomainColorModule from '~/hooks/useDomainColor';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as Trpc from '~/utils/trpc';

/**
 * BlockImagePickerModal against a REAL query cache.
 *
 * The posted list depends on the viewer's browsing level, which the server reads from the session
 * and which is not part of the query key. These tests run the modal's own query options through
 * react-query on a client configured like the app's (`staleTime: Infinity`), so a list cached at
 * one level and shown at another is visible here. The posted procedure is answered by
 * `mocks.fetchPosted`; everything between the hook and the DOM is real.
 */

const mocks = vi.hoisted(() => ({
  fetchPosted: vi.fn(),
  saveSettings: vi.fn(),
  session: {
    type: 'authed',
    settings: {
      showNsfw: true,
      blurNsfw: false,
      browsingLevel: 31,
      disableHidden: false,
      allowAds: false,
      autoplayGifs: true,
    },
  },
  level: 31,
  levelSubscribers: new Set<() => void>(),
}));

function setLevel(level: number) {
  mocks.level = level;
  mocks.levelSubscribers.forEach((notify) => notify());
}

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({ data: undefined, status: 'authenticated', update: async () => null }),
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (orig) => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    mocks.levelSubscribers.add(notify);
    return () => void mocks.levelSubscribers.delete(notify);
  };
  return {
    ...(await orig<typeof BrowsingLevelProviderModule>()),
    useViewerBrowsingLevelDebounced: () => useSyncExternalStore(subscribe, () => mocks.level),
  };
});

vi.mock('~/components/CivitaiWrapped/CivitaiSessionProvider', async (orig) => ({
  ...(await orig<typeof CivitaiSessionProviderModule>()),
  useCivitaiSessionContext: () => mocks.session,
}));

vi.mock('~/hooks/useDomainColor', async (orig) => ({
  ...(await orig<typeof DomainColorModule>()),
  useDomainColor: () => 'blue',
}));

vi.mock('~/utils/trpc', async (orig) => {
  const { useInfiniteQuery, useMutation, useQueryClient } = await import('@tanstack/react-query');
  const POSTED_KEY = ['blockImagePicker', 'getPosted'];
  return {
    ...(await orig<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'blockImagePicker.getPosted': {
          // The component's own options (`gcTime`, `staleTime`, `getNextPageParam`) reach
          // react-query untouched; only the network call is replaced.
          useInfiniteQuery: (input: unknown, options: Record<string, unknown>) =>
            useInfiniteQuery({
              queryKey: [...POSTED_KEY, input],
              queryFn: ({ pageParam }) => mocks.fetchPosted(pageParam),
              initialPageParam: undefined,
              getNextPageParam: () => undefined,
              ...options,
            }),
        },
        // The real provider's own mutation options (its `onSuccess`) run on a real mutation;
        // only the request is replaced.
        'user.updateContentSettings': {
          useMutation: (options: Record<string, unknown>) =>
            useMutation({ mutationFn: (input: unknown) => mocks.saveSettings(input), ...options }),
        },
      },
      {
        useUtils: () => {
          const queryClient = useQueryClient();
          return {
            blockImagePicker: {
              getPosted: { reset: () => queryClient.resetQueries({ queryKey: POSTED_KEY }) },
            },
            user: { getSettings: { cancel: () => undefined, setData: () => undefined } },
          };
        },
      }
    ),
  };
});

// eslint-disable-next-line import/first
import BlockImagePickerModal from '~/components/AppBlocks/BlockImagePickerModal';
// eslint-disable-next-line import/first
import { DialogProvider } from '~/components/Dialog/DialogProvider';
// eslint-disable-next-line import/first
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
// eslint-disable-next-line import/first
import { BrowserSettingsProvider, useBrowsingSettings } from '~/providers/BrowserSettingsProvider';

const CDN = 'https://image.civitai.com/acct';

const postedItem = (n: number, nsfwLevel: number) => ({
  imageId: 6000 + n,
  key: `key-${n}`,
  url: `${CDN}/key-${n}/width=1200/key-${n}.jpeg`,
  width: 1200,
  height: 600 + n,
  nsfwLevel,
});

const MATURE = postedItem(1, 8);
const SFW = postedItem(2, 1);
const pickOf = ({ key: _key, ...item }: ReturnType<typeof postedItem>) => ({
  source: 'posted',
  ...item,
});

function mountApp() {
  // `staleTime: Infinity` is the app's global query default (`queryClientConfig` in
  // `src/utils/trpc.ts`); the default `gcTime` keeps an unobserved query for minutes.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <DialogProvider />
    </QueryClientProvider>
  );
}

function openPicker() {
  const onResolved = vi.fn();
  dialogStore.trigger({
    id: `image-picker-cache-${Date.now()}-${Math.random()}`,
    component: BlockImagePickerModal,
    props: { sources: ['posted'], max: null, onResolved },
  });
  return onResolved;
}

const tiles = () => page.getByRole('button', { name: /^Posted image / });
const firstTile = () => page.getByRole('button', { name: 'Posted image 1', exact: true });
const confirmButton = () => page.getByRole('button', { name: /^Use / });

/** Mounts the real settings provider around the dialogs and hands back its store's setter. */
function mountAppWithSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const settings: { set?: (state: { showNsfw?: boolean; browsingLevel?: number }) => void } = {};
  function CaptureSettings() {
    settings.set = useBrowsingSettings((state) => state.setState);
    return null;
  }
  renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <BrowserSettingsProvider>
        <CaptureSettings />
        <DialogProvider />
      </BrowserSettingsProvider>
    </QueryClientProvider>
  );
  return settings;
}

const LOAD_MORE_NOTE = 'No usable images found in the most recent pages.';

describe('BlockImagePickerModal posted list and the query cache', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.fetchPosted.mockReset();
    mocks.saveSettings.mockReset();
    mocks.level = 31;
  });

  test.each([
    ['mature content turned off', { showNsfw: false }],
    ['the browsing level narrowed', { browsingLevel: 1 }],
  ])(
    'a list fetched before the settings save landed is replaced when it lands: %s',
    async (_name, change) => {
      // The server keeps answering at the OLD level until the save has gone through.
      mocks.fetchPosted.mockResolvedValue({ items: [MATURE] });
      let saved: (value: unknown) => void = () => undefined;
      mocks.saveSettings.mockReturnValue(new Promise((resolve) => (saved = resolve)));
      const settings = mountAppWithSettings();

      const onResolved = openPicker();
      await expect.element(firstTile()).toBeInTheDocument();

      // The viewer changes the setting. The page's level flips at once; the save is delayed.
      settings.set?.(change);
      setLevel(1);
      await vi.waitFor(() => expect(mocks.fetchPosted).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1), {
        timeout: 4000,
      });
      expect(mocks.saveSettings).toHaveBeenCalledWith(change);
      // Control: the refetch at the flip was answered at the old level, so the image is back.
      await expect.element(firstTile()).toBeInTheDocument();
      expect(mocks.fetchPosted).toHaveBeenCalledTimes(2);

      // The save lands; from here the server answers at the new level. No click, no reopen.
      mocks.fetchPosted.mockResolvedValue({ items: [SFW] });
      saved(undefined);
      await vi.waitFor(() => expect(mocks.fetchPosted).toHaveBeenCalledTimes(3));

      await expect.element(firstTile()).toBeInTheDocument();
      expect(tiles().elements()).toHaveLength(1);
      await userEvent.click(firstTile());
      await userEvent.click(confirmButton());
      expect(onResolved).toHaveBeenCalledWith([pickOf(SFW)]);
    }
  );

  test('an image picked before the settings save landed cannot be confirmed after it', async () => {
    mocks.fetchPosted.mockResolvedValue({ items: [MATURE] });
    let saved: (value: unknown) => void = () => undefined;
    mocks.saveSettings.mockReturnValue(new Promise((resolve) => (saved = resolve)));
    const settings = mountAppWithSettings();

    const onResolved = openPicker();
    await expect.element(firstTile()).toBeInTheDocument();
    settings.set?.({ showNsfw: false });
    setLevel(1);
    await vi.waitFor(() => expect(mocks.fetchPosted).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1), { timeout: 4000 });

    // The server still answered at the old level, so the image is back, and the viewer picks it.
    await userEvent.click(firstTile());
    await expect.element(firstTile()).toHaveAttribute('aria-pressed', 'true');
    await expect.element(confirmButton()).toBeEnabled();

    mocks.fetchPosted.mockResolvedValue({ items: [SFW] });
    saved(undefined);
    await vi.waitFor(() => expect(mocks.fetchPosted).toHaveBeenCalledTimes(3));

    // The list on screen is the new one; nothing in it is selected and nothing can be confirmed.
    await expect.element(firstTile()).toHaveAttribute('aria-pressed', 'false');
    await expect.element(confirmButton()).toBeDisabled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  test('loading a further page keeps the selection', async () => {
    mocks.fetchPosted.mockImplementation(async (cursor: unknown) =>
      cursor === undefined ? { items: [MATURE], nextCursor: 7 } : { items: [SFW] }
    );
    mountApp();

    const onResolved = openPicker();
    await userEvent.click(firstTile());
    // The second page arrives by itself.
    await expect
      .element(page.getByRole('button', { name: 'Posted image 2', exact: true }), { timeout: 8000 })
      .toBeInTheDocument();
    expect(mocks.fetchPosted).toHaveBeenCalledTimes(2);

    await expect.element(firstTile()).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(confirmButton());
    expect(onResolved).toHaveBeenCalledWith([pickOf(MATURE)]);
  });

  test('a reset list starts its empty-page count again', async () => {
    let cursor = 100;
    mocks.fetchPosted.mockImplementation(async () => ({ items: [], nextCursor: cursor++ }));
    mountApp();

    openPicker();
    // Control: the first list is all empty pages, so the bound is reached.
    await expect.element(page.getByText(LOAD_MORE_NOTE), { timeout: 8000 }).toBeInTheDocument();

    mocks.fetchPosted.mockImplementation(async () => ({ items: [SFW], nextCursor: cursor++ }));
    setLevel(1);

    await expect.element(firstTile()).toBeInTheDocument();
    expect(page.getByText(LOAD_MORE_NOTE).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Load more' }).query()).toBeNull();
  });

  test('a reopened picker lists what the server returns now, not the pages of the last open', async () => {
    mocks.fetchPosted.mockResolvedValue({ items: [MATURE] });
    mountApp();

    const first = openPicker();
    await userEvent.click(firstTile());
    await userEvent.click(confirmButton());
    // Control: at the first open the mature image is what is listed and picked.
    expect(first).toHaveBeenCalledWith([pickOf(MATURE)]);
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(0));

    // The viewer turns mature content off; the server now returns a different list. The second
    // answer is held back so the state BEFORE it arrives can be inspected.
    let answer: (page: { items: unknown[] }) => void = () => undefined;
    mocks.fetchPosted.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    setLevel(1);

    const second = openPicker();
    await vi.waitFor(() => expect(mocks.fetchPosted).toHaveBeenCalledTimes(2));
    // Nothing from the earlier open is on screen while the fresh list loads.
    expect(tiles().elements()).toHaveLength(0);

    answer({ items: [SFW] });
    await expect.element(firstTile()).toBeInTheDocument();
    expect(tiles().elements()).toHaveLength(1);
    await userEvent.click(firstTile());
    await userEvent.click(confirmButton());
    expect(second).toHaveBeenCalledWith([pickOf(SFW)]);
  });

  test('a level change while the picker is open drops the listed pages and the selection', async () => {
    mocks.fetchPosted.mockResolvedValue({ items: [MATURE] });
    mountApp();

    const onResolved = openPicker();
    await userEvent.click(firstTile());
    await expect.element(confirmButton()).toBeEnabled();

    let answer: (page: { items: unknown[] }) => void = () => undefined;
    mocks.fetchPosted.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    setLevel(1);

    await vi.waitFor(() => expect(mocks.fetchPosted).toHaveBeenCalledTimes(2));
    expect(tiles().elements()).toHaveLength(0);
    await expect.element(confirmButton()).toBeDisabled();

    answer({ items: [SFW] });
    await expect.element(firstTile()).toBeInTheDocument();
    await userEvent.click(firstTile());
    await userEvent.click(confirmButton());
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith([pickOf(SFW)]);
  });
});
