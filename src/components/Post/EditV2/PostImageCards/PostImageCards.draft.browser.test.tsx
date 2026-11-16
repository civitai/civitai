import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';

// The real StorylineTextCard and PostImageCards, over a store that really holds the texts: the
// draft-to-row handoff is what is under test.
const { store, addText, setText } = vi.hoisted(() => ({
  store: {
    texts: [] as { id: number; index: number; content: string }[],
    listeners: new Set<() => void>(),
  },
  addText: vi.fn(),
  setText: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  const { useState } = await import('react');
  const mutation = (spy: typeof addText) => (opts: { onSuccess?: (data: unknown) => void }) => {
    const [status, setStatus] = useState('idle');
    return {
      mutate: (input: unknown) => {
        setStatus('success');
        opts.onSuccess?.(spy(input));
      },
      reset: () => setStatus('idle'),
      isPending: false,
      isSuccess: status === 'success',
      isError: false,
      isIdle: status === 'idle',
    };
  };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'storyline.addText': { useMutation: mutation(addText) },
      'storyline.setText': { useMutation: mutation(setText) },
      'storyline.deleteText': { useMutation: mutation(vi.fn()) },
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<object>()),
  useFeatureFlags: () => ({ storylineText: true }),
}));
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => {
  const { useSyncExternalStore, useRef } = await import('react');
  const images = [{ type: 'added', data: { id: 11, index: 0, url: 'u11' } }];
  const post = { id: 5, user: { id: 7 } };
  const registerPendingSave = () => () => undefined;
  const setTexts = (update: (texts: typeof store.texts) => typeof store.texts) => {
    store.texts = update(store.texts);
    store.listeners.forEach((listener) => listener());
  };
  // A new snapshot only when the texts change, as a real store's would.
  let cached: { texts: typeof store.texts } & Record<string, unknown> = {} as never;
  const state = () => {
    if (cached.texts !== store.texts)
      cached = { images, texts: store.texts, post, setTexts, registerPendingSave };
    return cached;
  };
  return {
    ...(await orig<typeof PostEditProviderMod>()),
    usePostEditStore: (selector: (s: ReturnType<typeof state>) => unknown) => {
      // The real store compares selector results shallowly; an array built per read would loop.
      const last = useRef<unknown>(undefined);
      return useSyncExternalStore(
        (listener) => {
          store.listeners.add(listener);
          return () => store.listeners.delete(listener);
        },
        () => {
          const next = selector(state());
          const same =
            Array.isArray(next) && Array.isArray(last.current)
              ? next.length === last.current.length && next.every((x, i) => x === last.current[i])
              : Object.is(next, last.current);
          if (!same) last.current = next;
          return last.current;
        }
      );
    },
    usePendingSave: vi.fn(),
    usePostPreviewContext: () => ({ showPreview: false, toggleShowPreview: vi.fn() }),
  };
});
vi.mock('~/components/MediaUploadSettings/MediaUploadSettingsProvider', () => ({
  useMediaUploadSettingsContext: () => ({ maxItems: 20 }),
}));
vi.mock('~/components/Post/EditV2/PostImageCards/AddedImage', () => ({
  AddedImage: () => <div>image card</div>,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/Storyline/editor/usePostStorylineMode', () => ({
  usePostStorylineMode: () => ({ inStoryline: true }),
}));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
// The real editor is TipTap behind next/dynamic; the card's contract is the HTML it hands back.
vi.mock('~/components/RichTextEditor/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Text" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// eslint-disable-next-line import/first
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards/PostImageCards';

describe('PostImageCards: an Add text draft becoming its row', () => {
  test('typing creates the row without a second card or a remounted editor', async () => {
    store.texts = [];
    addText.mockReset();
    setText.mockReset();
    addText.mockReturnValue({ id: 31, index: 4, content: '' });
    setText.mockImplementation(({ id, content }) => ({ id, content }));
    renderWithProviders(<PostImageCards />);

    await page.getByRole('button', { name: 'Add text' }).first().click();
    const box = page.getByLabelText('Text', { exact: true });
    await expect.element(box).toBeVisible();
    expect(addText).not.toHaveBeenCalled();
    const node = box.element();

    await box.fill('Once');
    expect(addText).toHaveBeenCalledTimes(1);
    expect(store.texts).toHaveLength(1);
    // The store's row is the draft's own card: one card, the same editor node, still holding the words.
    expect(page.getByLabelText('Text', { exact: true }).elements()).toEqual([node]);
    expect(node.value).toBe('Once');
  });

  test('a second Add text leaves the first card mounted', async () => {
    store.texts = [];
    addText.mockReset();
    addText.mockReturnValue({ id: 41, index: 4, content: '' });
    setText.mockImplementation(({ id, content }) => ({ id, content }));
    renderWithProviders(<PostImageCards />);

    await page.getByRole('button', { name: 'Add text' }).first().click();
    const first = page.getByLabelText('Text', { exact: true }).element();
    await page.getByLabelText('Text', { exact: true }).fill('Typed');
    await page.getByRole('button', { name: 'Add text' }).first().click();
    await expect.poll(() => page.getByLabelText('Text', { exact: true }).elements().length).toBe(2);
    expect(page.getByLabelText('Text', { exact: true }).elements()).toContain(first);
  });
});
