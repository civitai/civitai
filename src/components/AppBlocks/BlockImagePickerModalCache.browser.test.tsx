import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as BrowsingLevelProviderModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
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

vi.mock('~/utils/trpc', async (orig) => {
  const { useInfiniteQuery, useQueryClient } = await import('@tanstack/react-query');
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
      },
      {
        useUtils: () => {
          const queryClient = useQueryClient();
          return {
            blockImagePicker: {
              getPosted: { reset: () => queryClient.resetQueries({ queryKey: POSTED_KEY }) },
            },
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

describe('BlockImagePickerModal posted list and the query cache', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.fetchPosted.mockReset();
    mocks.level = 31;
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
