import { act, useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';

/**
 * "Done Rearranging" sends the order; the editor then shows what the server saved: its indexes, and
 * none of the sent images it did not place. A refused order puts back the order from before the
 * rearrange.
 */

type Image = { type: 'added'; data: { id: number; index: number } };
type State = {
  images: Image[];
  texts: never[];
  isReordering: boolean;
  post: { id: number };
};

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = {
    state: undefined as unknown as State,
    set(next: Partial<State>) {
      store.state = { ...store.state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    store,
    mutate: vi.fn(),
    mutation: {} as {
      onSuccess?: (positions: unknown, vars: { imageIds: number[] }) => Promise<void>;
      onError?: (error: { message: string }) => void;
    },
    showErrorNotification: vi.fn(),
  };
});

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'post.reorderImages': {
        useMutation: (opts: typeof h.mutation) => {
          h.mutation.onSuccess = opts.onSuccess;
          h.mutation.onError = opts.onError;
          return { mutate: h.mutate, isPending: false };
        },
      },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) => {
    const state = useSyncExternalStore(h.store.subscribe, () => h.store.state);
    return selector({
      ...state,
      setImages: (fn: (current: Image[]) => Image[]) =>
        h.store.set({ images: fn(h.store.state.images) }),
      setTexts: (fn: (current: never[]) => never[]) =>
        h.store.set({ texts: fn(h.store.state.texts) }),
      toggleReordering: () => h.store.set({ isReordering: !h.store.state.isReordering }),
    });
  },
}));
vi.mock('~/utils/notifications', async (orig) => ({
  ...(await orig<object>()),
  showErrorNotification: h.showErrorNotification,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<object>()),
  useFeatureFlags: () => ({}),
}));

// eslint-disable-next-line import/first
import { ReorderImagesButton } from '~/components/Post/EditV2/PostReorderImages';

const added = (id: number, index: number): Image => ({ type: 'added', data: { id, index } });
const shown = () => h.store.state.images.map((x) => [x.data.id, x.data.index]);

/** Rearrange 1, 2, 3 into 3, 1, 2 and press Done: the order goes to the server. */
async function rearrangeAndSave() {
  renderWithProviders(<ReorderImagesButton />);
  await page.getByRole('button', { name: 'Rearrange' }).click();
  act(() => h.store.set({ images: [added(3, 0), added(1, 1), added(2, 2)] }));
  await page.getByRole('button', { name: 'Done Rearranging' }).click();
  expect(h.mutate).toHaveBeenCalledWith({ id: 1, imageIds: [3, 1, 2] });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.state = {
    images: [added(1, 0), added(2, 1), added(3, 2)],
    texts: [],
    isReordering: false,
    post: { id: 1 },
  };
});

describe('ReorderImagesButton saving an order', () => {
  test('shows the indexes the server saved, without a sent image it did not place', async () => {
    await rearrangeAndSave();
    // A hidden image holds index 1, so image 1 is saved at 2; image 2 was not placed.
    await act(() =>
      h.mutation.onSuccess!(
        [
          { type: 'image', id: 3, index: 0 },
          { type: 'image', id: 1, index: 2 },
        ],
        { imageIds: [3, 1, 2] }
      )
    );
    expect(shown()).toEqual([
      [3, 0],
      [1, 2],
    ]);
  });

  test('a refused order puts back the order from before the rearrange, with an error', async () => {
    await rearrangeAndSave();
    act(() => h.mutation.onError!({ message: 'This order could not be saved.' }));
    expect(shown()).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(h.showErrorNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Order not saved' })
    );
  });
});
