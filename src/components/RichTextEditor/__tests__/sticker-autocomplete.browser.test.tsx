import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';

// The node view renders <Sticker>, which resolves artwork over tRPC. Not what
// these tests are about, and pulling it in would make the editor need a network
// layer — stub it to something assertable instead.
vi.mock('~/components/Sticker/Sticker', () => ({
  Sticker: ({ cosmeticId }: { cosmeticId: number }) => (
    <span data-testid="sticker-node">sticker:{cosmeticId}</span>
  ),
}));

// The suggestion list shows artwork through EdgeImage, which reads the signed-in
// user for its CDN preferences. Irrelevant here and it would drag a session
// provider into a test about editor behaviour.
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ alt }: { alt?: string }) => <span>{alt}</span>,
}));

const { StickerEditNode } = await import('~/components/TipTap/StickerNode');

const OWNED: ResolvedSticker[] = [
  { id: 1387, name: 'Gumdong Heart Hug', slug: 'gumdong_heart', url: 'fake-image-id' },
];

function Harness({ available = OWNED }: { available?: ResolvedSticker[] }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false }), StickerEditNode],
    content: '<p></p>',
    immediatelyRender: true,
  });

  useEffect(() => {
    if (editor) editor.extensionStorage.sticker.available = available;
  }, [editor, available]);

  return <EditorContent editor={editor} />;
}

const typeInto = async (text: string) => {
  const box = page.getByRole('textbox').first();
  // Guards the negative assertions below: without this they pass on a page where
  // the editor never mounted, which is exactly how they passed the first run.
  await expect.element(box).toBeInTheDocument();
  await userEvent.click(box);
  await userEvent.type(box, text);
  await expect.element(box).not.toBeEmptyDOMElement();
  return box;
};

describe('sticker autocomplete', () => {
  test('suggests owned stickers after two characters', async () => {
    renderWithProviders(<Harness />);
    await typeInto(' :gu');
    await expect.element(page.getByText(/gumdong_heart/).first()).toBeInTheDocument();
  });

  test('does not suggest anything the user does not own', async () => {
    renderWithProviders(<Harness available={[]} />);
    await typeInto(' :gu');
    await expect.element(page.getByText('No stickers match').first()).toBeInTheDocument();
  });

  test('inserts the node when a suggestion is chosen, leaving no text behind', async () => {
    renderWithProviders(<Harness />);
    await typeInto(' :gu');
    await userEvent.click(page.getByText(/gumdong_heart/).first());
    await expect.element(page.getByTestId('sticker-node').first()).toBeInTheDocument();
    await expect.element(page.getByRole('textbox').first()).not.toHaveTextContent(':gu');
  });
});

// The case the input rule exists for. Someone who learned `:slug:` in chat types
// it into a comment and never touches the menu; without the rule that is plain
// text, which renders as nothing and costs nothing but looks correct until post.
describe('a fully typed :slug:', () => {
  test('converts to a node without the menu being used', async () => {
    renderWithProviders(<Harness />);
    await typeInto(' :gumdong_heart:');
    await expect.element(page.getByTestId('sticker-node').first()).toBeInTheDocument();
  });

  test('stays as text when the user does not own it', async () => {
    renderWithProviders(<Harness available={[]} />);
    await typeInto(' :gumdong_heart:');
    await expect.element(page.getByRole('textbox').first()).toHaveTextContent(':gumdong_heart:');
  });
});

// `:` is common punctuation. A menu opening on a clock time or a pasted URL would
// be immediately annoying, and is the reason for the prefix and length rules.
describe('the : trigger stays quiet', () => {
  test('ignores a clock time', async () => {
    renderWithProviders(<Harness />);
    await typeInto('meet at 12:30');
    expect(document.body.textContent).not.toContain('gumdong_heart');
  });

  test('ignores a url scheme', async () => {
    renderWithProviders(<Harness />);
    await typeInto('see https://example.com');
    expect(document.body.textContent).not.toContain('gumdong_heart');
  });

  test('ignores a single character after the colon', async () => {
    renderWithProviders(<Harness />);
    await typeInto(' :g');
    expect(document.body.textContent).not.toContain(':gumdong_heart:');
  });
});
