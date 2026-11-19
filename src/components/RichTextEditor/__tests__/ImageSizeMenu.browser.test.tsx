import type { Editor } from '@tiptap/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { SizedImage } from '~/shared/tiptap/sized-image.node';

// Uploads only start for a blob: URL, which these tests never use; the hook itself would
// pull a network layer into a test about the size control.
vi.mock('~/hooks/useCFImageUpload', () => ({ useCFImageUpload: () => ({ uploadToCF: vi.fn() }) }));

const { EdgeMediaEditNode } = await import('~/components/TipTap/EdgeMediaNode');
const { ImageSizeMenu } = await import('~/components/RichTextEditor/ImageSizeMenu');

const IMAGE = 'https://image.civitai.com/test/image.jpeg';

let editor: Editor | null = null;
function Harness({ content }: { content: string }) {
  editor = useEditor({
    // The article editor's image nodes: the addVideo branch of RichTextEditorComponent.
    extensions: [
      StarterKit.configure({ heading: false }),
      EdgeMediaEditNode.configure({ accepts: ['image', 'video'], inline: true }),
      SizedImage.configure({ inline: true }),
    ],
    content,
    immediatelyRender: true,
  });
  if (!editor) return null;
  return (
    <>
      <ImageSizeMenu editor={editor} />
      <EditorContent editor={editor} />
    </>
  );
}

async function mount(content: string) {
  editor = null;
  renderWithProviders(<Harness content={content} />);
  await expect.poll(() => editor?.view.dom.isConnected).toBe(true);
}

const selectFirst = (type: string) => {
  let pos = -1;
  editor!.state.doc.descendants((node, p) => {
    if (pos === -1 && node.type.name === type) pos = p;
  });
  expect(pos).toBeGreaterThanOrEqual(0);
  editor!.commands.setNodeSelection(pos);
};

const sizeControl = () => page.getByRole('radiogroup', { name: 'Image size' });

describe('image size menu', () => {
  test.each([
    [
      'an uploaded image (edge-media)',
      `<p>text <edge-media url="${IMAGE}" type="image"></edge-media></p>`,
      'media',
    ],
    ['an older plain image', `<p>text <img src="${IMAGE}"></p>`, 'image'],
  ])('sizes %s, and Full clears the size', async (_label, content, type) => {
    await mount(content);
    selectFirst(type);

    await expect.element(sizeControl()).toBeVisible();
    await expect.element(page.getByRole('radio', { name: 'Full' })).toBeChecked();

    await userEvent.click(page.getByText('S', { exact: true }));
    await expect.poll(() => editor!.getHTML()).toContain('data-width="33"');
    await expect.element(page.getByRole('radio', { name: 'S' })).toBeChecked();
    expect(editor!.view.dom.querySelector('img')?.getAttribute('data-width')).toBe('33');

    await userEvent.click(page.getByText('Full', { exact: true }));
    await expect.poll(() => editor!.getHTML()).not.toContain('data-width');
  });

  test('closes for a text selection and for a video', async () => {
    await mount(
      `<p>some words <img src="${IMAGE}"></p><edge-media url="${IMAGE}" type="video"></edge-media>`
    );
    // Each absence starts from the menu showing, so it cannot pass before the plugin has run.
    selectFirst('image');
    await expect.element(sizeControl()).toBeVisible();
    editor!.commands.setTextSelection({ from: 1, to: 5 });
    await expect.element(sizeControl()).not.toBeInTheDocument();

    selectFirst('image');
    await expect.element(sizeControl()).toBeVisible();
    selectFirst('media');
    expect(editor!.state.selection.toJSON().type).toBe('node');
    await expect.element(sizeControl()).not.toBeInTheDocument();
  });
});
