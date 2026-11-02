import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
import '@mantine/tiptap/styles.layer.css';
import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => ({}),
  useOptionalFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOwnedSticker: () => ({ sticker: [] }),
}));
vi.mock('~/components/Sticker/StickerPicker', () => ({ StickerPicker: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  // Every procedure is an inert query/mutation: this test is about where the editor draws, not data.
  const inert = () => ({ data: undefined, isLoading: false, isFetching: false, mutate: vi.fn() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy: any = new Proxy(() => inert(), {
    get: (_t, key) =>
      ['useQuery', 'useMutation', 'useInfiniteQuery'].includes(key as string)
        ? inert
        : key === 'useUtils'
        ? () => new Proxy({}, { get: () => proxy })
        : proxy,
    apply: () => inert(),
  });
  return { ...(await importOriginal<object>()), trpc: proxy };
});

const { CommentForm } = await import('~/components/CommentsV2/Comment/CommentForm');
const { CommentsCtx, RootThreadCtx } = await import('~/components/CommentsV2/CommentsProvider');

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the element is what the browser hits at its own centre, i.e. it is drawn and clickable. */
function isReachable(el: Element) {
  const rect = el.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return rect.width > 0 && !!hit && el.contains(hit);
}

describe('CommentForm formatting strip', () => {
  test('stays clickable after selecting text in a one-line comment box', async () => {
    renderWithProviders(
      <RootThreadCtx.Provider value={{ setExpanded: vi.fn() } as never}>
        <CommentsCtx.Provider
          value={{ entityId: 1, entityType: 'challenge', isMuted: false, data: [] } as never}
        >
          <div style={{ padding: '120px 24px' }}>
            <CommentForm autoFocus />
          </div>
        </CommentsCtx.Provider>
      </RootThreadCtx.Provider>
    );
    await settle(1500);

    const editor = document.querySelector('.ProseMirror') as HTMLElement;
    editor.focus();
    document.execCommand('insertText', false, 'hello world');
    await settle(300);
    const range = document.createRange();
    range.selectNodeContents(editor.querySelector('p')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await settle(800);

    const link = document.querySelector('button[aria-label="Link"]');
    expect(link).not.toBeNull();
    expect(isReachable(link!)).toBe(true);
  });
});
