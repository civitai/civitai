import type { Editor } from '@tiptap/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// Uploads only start for a blob: URL, which these tests never use; the hook itself would
// pull a network layer into a test about the size control.
vi.mock('~/hooks/useCFImageUpload', () => ({ useCFImageUpload: () => ({ uploadToCF: vi.fn() }) }));

const { EdgeMediaEditNode } = await import('~/components/TipTap/EdgeMediaNode');
const { ImageSizeMenu } = await import('~/components/RichTextEditor/ImageSizeMenu');
const { SizedImageEditNode } = await import('~/components/RichTextEditor/SizedImageEditNode');

const IMAGE = 'https://image.civitai.com/test/image.jpeg';
const COLUMN = 800;

// A blob: URL passes through `useEdgeUrl` untouched, so the image loads at exactly this size.
async function imageUrl(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
  return URL.createObjectURL(blob);
}

let editor: Editor | null = null;
function Harness({ content }: { content: string }) {
  editor = useEditor({
    // The article editor's image nodes: the addVideo branch of RichTextEditorComponent.
    extensions: [
      StarterKit.configure({ heading: false }),
      EdgeMediaEditNode.configure({ accepts: ['image', 'video'], inline: true }),
      SizedImageEditNode.configure({ inline: true }),
    ],
    content,
    immediatelyRender: true,
  });
  if (!editor) return null;
  return (
    <div style={{ width: COLUMN }}>
      <ImageSizeMenu editor={editor} />
      <EditorContent editor={editor} />
    </div>
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

const alignControl = () => page.getByRole('radiogroup', { name: 'Image alignment' });

/** Drag a resize handle of the selected image by `dx` pixels. */
async function dragHandle(side: 'left' | 'right', dx: number) {
  const handle = await expect
    .poll(() => document.querySelector<HTMLElement>(`[data-side="${side}"]`))
    .not.toBeNull()
    .then(() => document.querySelector<HTMLElement>(`[data-side="${side}"]`)!);
  const { left, top, width, height } = handle.getBoundingClientRect();
  const x = left + width / 2;
  const y = top + height / 2;
  const at = (clientX: number) => ({ clientX, clientY: y, bubbles: true, pointerId: 1 });
  handle.dispatchEvent(new PointerEvent('pointerdown', at(x)));
  window.dispatchEvent(new PointerEvent('pointermove', at(x + dx / 2)));
  window.dispatchEvent(new PointerEvent('pointermove', at(x + dx)));
  window.dispatchEvent(new PointerEvent('pointerup', at(x + dx)));
}

describe('image placement menu', () => {
  // Desktop: below 640px small widths are bumped to 60%, which would move the measured sizes.
  beforeEach(() => page.viewport(1280, 800));

  test.each([
    [
      'an uploaded image (edge-media)',
      `<p>text <edge-media url="${IMAGE}" type="image"></edge-media></p>`,
      'media',
    ],
    ['an older plain image', `<p>text <img src="${IMAGE}"></p>`, 'image'],
  ])('aligns %s, and Full width clears size and alignment', async (_label, content, type) => {
    await mount(
      content
        .replace('<edge-media', '<edge-media data-width="40"')
        .replace('<img', '<img data-width="40"')
    );
    selectFirst(type);

    await expect.element(alignControl()).toBeVisible();
    // A sized image with no alignment shows as centred.
    await expect.element(page.getByRole('radio', { name: 'Centre' })).toBeChecked();

    await userEvent.click(page.getByLabelText('Float left, text wraps'));
    await expect.poll(() => editor!.getHTML()).toContain('data-align="float-left"');

    await userEvent.click(page.getByRole('button', { name: 'Full width' }));
    await expect.poll(() => editor!.getHTML()).not.toContain('data-align');
    expect(editor!.getHTML()).not.toContain('data-width');
  });

  // The frame is shared by both image nodes; an edge-media node with a blob: url is an upload in
  // flight and renders a loader, so the drag is driven on the plain image.
  test('dragging the right edge sets the width, snapped to 5%', async () => {
    await mount(`<p><img src="${await imageUrl(COLUMN, 400)}"></p>`);
    await expect
      .poll(() => document.querySelector('img')?.getBoundingClientRect().width)
      .toBe(COLUMN);
    selectFirst('image');

    // An unsized image starts the line, so only its right edge moves: 800 → 532px is 66.5%.
    await dragHandle('right', -268);

    await expect.poll(() => editor!.getHTML()).toContain('data-width="65"');
    await expect
      .poll(() => document.querySelector('img')?.getBoundingClientRect().width)
      .toBe(COLUMN * 0.65);
  });

  test('dragging a centred image grows it on both sides, and to the edge clears the size', async () => {
    const src = await imageUrl(COLUMN, 400);
    await mount(`<p><img src="${src}" data-width="60"></p>`);
    selectFirst('image');

    // Centred, so 60px of drag is 120px of width: 480 → 600px is 75%.
    await dragHandle('right', 60);
    await expect.poll(() => editor!.getHTML()).toContain('data-width="75"');

    await dragHandle('left', -400);
    await expect.poll(() => editor!.getHTML()).not.toContain('data-width');
  });

  test('closes for a text selection and for a video', async () => {
    await mount(
      `<p>some words <img src="${IMAGE}"></p><edge-media url="${IMAGE}" type="video"></edge-media>`
    );
    // Each absence starts from the menu showing, so it cannot pass before the plugin has run.
    selectFirst('image');
    await expect.element(alignControl()).toBeVisible();
    editor!.commands.setTextSelection({ from: 1, to: 5 });
    await expect.element(alignControl()).not.toBeInTheDocument();

    selectFirst('image');
    await expect.element(alignControl()).toBeVisible();
    selectFirst('media');
    expect(editor!.state.selection.toJSON().type).toBe('node');
    await expect.element(alignControl()).not.toBeInTheDocument();
  });
});
