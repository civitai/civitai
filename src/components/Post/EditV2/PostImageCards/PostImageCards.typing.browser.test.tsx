import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

// The real StorylineTextCard, PostImageCards and TipTap editor, with a create that takes a while to
// answer, as on a phone: the keystrokes that land before the first re-render are what is under test.
const { store, ui, addText, setText } = vi.hoisted(() => ({
  ui: { showPreview: false },
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
        setStatus('pending');
        const result = spy(input);
        setTimeout(() => {
          setStatus('success');
          opts.onSuccess?.(result);
        }, 300);
      },
      reset: () => setStatus('idle'),
      isPending: status === 'pending',
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
          const prev = last.current;
          const same =
            Array.isArray(next) && Array.isArray(prev)
              ? next.length === prev.length && next.every((x, i) => x === prev[i])
              : Object.is(next, prev);
          if (!same) last.current = next;
          return last.current;
        }
      );
    },
    usePendingSave: vi.fn(),
    usePostPreviewContext: () => ({ showPreview: ui.showPreview, toggleShowPreview: vi.fn() }),
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
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/components/RichTextEditor/RichTextEditor', async () => ({
  RichTextEditor: (await import('~/components/RichTextEditor/RichTextEditorComponent'))
    .RichTextEditor,
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOwnedSticker: () => ({ sticker: [] }),
}));

// eslint-disable-next-line import/first
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards/PostImageCards';

describe('PostImageCards: typing fast into a new text', () => {
  test('keystrokes that land before a re-render create one row and keep every word', async () => {
    store.texts = [{ id: 21, index: 0, content: '<p>First</p>' }];
    addText.mockReset();
    setText.mockReset();
    addText.mockReturnValue({ id: 31, index: 0, content: '' });
    setText.mockImplementation(({ id, content }) => ({ id, content }));
    renderWithProviders(<PostImageCards />);

    await page.getByRole('button', { name: 'Add text' }).last().click();
    await vi.waitFor(() => expect(document.querySelectorAll('.ProseMirror')).toHaveLength(2));
    const editors = [...document.querySelectorAll('.ProseMirror')];
    const draft = editors[1];
    await vi.waitFor(() => expect(document.activeElement).toBe(draft));

    // Two characters per task: React cannot re-render between the two of a pair.
    const words = 'Second test slide';
    for (let i = 0; i < words.length; i += 2) {
      for (const ch of words.slice(i, i + 2)) document.execCommand('insertText', false, ch);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await vi.waitFor(() => expect(setText).toHaveBeenCalled(), { timeout: 3000 });
    // The autosave window after the last keystroke.
    await vi.waitFor(
      () =>
        expect(setText).toHaveBeenLastCalledWith({ id: 31, content: '<p>Second test slide</p>' }),
      { timeout: 3000 }
    );
    expect(addText).toHaveBeenCalledTimes(1);
    expect(store.texts.map((t) => t.id)).toEqual([21, 31]);
    expect(draft.isConnected).toBe(true);
    expect(document.querySelectorAll('.ProseMirror')).toHaveLength(2);
  });
});
