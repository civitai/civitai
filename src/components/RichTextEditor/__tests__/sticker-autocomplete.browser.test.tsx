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

  // Byte for byte the flag-off state as well as the owns-nothing state: no popup
  // at all, rather than a dropdown advertising a feature they may not have.
  test('shows no popup when there is nothing to offer', async () => {
    renderWithProviders(<Harness available={[]} />);
    await typeInto(' :gu');
    expect(document.body.textContent).not.toContain('No stickers match');
    expect(document.body.textContent).not.toContain('gumdong_heart');
  });

  test('still says so when a query matches none of what you own', async () => {
    renderWithProviders(<Harness />);
    await typeInto(' :zz');
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

// The two insertion paths have to agree on WHERE a sticker may be inserted, not
// just what. The menu refuses mid-word via allowedPrefixes; the input rule needs
// the same boundary or `foo:slug:` converts while the menu declines.
describe('both insertion paths agree on position', () => {
  test('the input rule ignores a slug glued to the end of a word', async () => {
    renderWithProviders(<Harness />);
    await typeInto('foo:gumdong_heart:');
    await expect.element(page.getByTestId('sticker-node')).not.toBeInTheDocument();
    await expect.element(page.getByRole('textbox').first()).toHaveTextContent('foo:gumdong_heart:');
  });

  // Pins an escaping bug: `\s` inside a template literal collapses to `s`, so the
  // boundary read "not preceded by a non-s character" and only words ending in s
  // slipped through. Every other mid-word case still passed.
  test('the input rule ignores a slug glued to a word ending in s', async () => {
    renderWithProviders(<Harness />);
    await typeInto('bananas:gumdong_heart:');
    await expect.element(page.getByTestId('sticker-node')).not.toBeInTheDocument();
  });

  test('the menu ignores the same position', async () => {
    renderWithProviders(<Harness />);
    await typeInto('foo:gu');
    expect(document.body.textContent).not.toContain('gumdong_heart');
  });

  test('a sticker at the very start of a comment still works', async () => {
    renderWithProviders(<Harness />);
    await typeInto(':gumdong_heart:');
    await expect.element(page.getByTestId('sticker-node').first()).toBeInTheDocument();
  });

  test('a clock time is not a slug even though it fits the shape', async () => {
    renderWithProviders(<Harness />);
    await typeInto('at 12:30:');
    await expect.element(page.getByTestId('sticker-node')).not.toBeInTheDocument();
    await expect.element(page.getByRole('textbox').first()).toHaveTextContent('12:30:');
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
