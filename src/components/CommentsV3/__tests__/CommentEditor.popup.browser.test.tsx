import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
import '@mantine/tiptap/styles.layer.css';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type { CommentV3Comment } from '../types';

/**
 * Selecting text in a one-line comment box opens the formatting strip, which is taller than the
 * box. The box must not clip it: the Link button has to be drawn and clickable. This runs the real
 * rich-text editor; only the data hooks are inert.
 */

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
vi.mock('../CommentSectionContext', () => ({
  useCommentSection: () => ({ byId: new Map(), borderless: false }),
}));
vi.mock('../useCommentMutations', () => ({
  useCommentMutations: () => ({ create: vi.fn(), edit: vi.fn(), saving: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
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

const { CommentEditor } = await import('../CommentComposer');

// The editor is a lazy chunk (next/dynamic). Loaded here, so the 1 s waits below cover a render, not
// a cold import of the editor, which a busy runner can take longer than that to fetch.
beforeAll(async () => {
  await import('~/components/RichTextEditor/RichTextEditorComponent');
}, 30_000);

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the element is what the browser hits at its own centre, i.e. it is drawn and clickable. */
function isReachable(el: Element) {
  const rect = el.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return rect.width > 0 && !!hit && el.contains(hit);
}

const existing = { id: 5, depth: 0, content: '<p>hello world</p>' } as CommentV3Comment;

describe.each([
  ['a one-line comment', {}],
  ['a one-line reply', { parent: existing }],
  ['an edit of a one-line comment', { editing: existing }],
])('CommentEditor formatting strip in %s', (_name, props) => {
  test('stays clickable after selecting the text', async () => {
    renderWithProviders(
      <div style={{ padding: '120px 24px' }}>
        <CommentEditor autoFocus {...props} />
      </div>
    );
    await vi.waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull());

    const editor = document.querySelector('.ProseMirror') as HTMLElement;
    editor.focus();
    if (!editor.textContent) document.execCommand('insertText', false, 'hello world');
    await settle(300);
    const range = document.createRange();
    range.selectNodeContents(editor.querySelector('p')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Link"]')).not.toBeNull()
    );
    // The strip positions itself after it appears; a clipped one never becomes reachable.
    await vi.waitFor(() => {
      const link = document.querySelector('button[aria-label="Link"]');
      expect(link).not.toBeNull();
      expect(isReachable(link!)).toBe(true);
    });
  });
});
