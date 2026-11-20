import { RichTextEditor } from '@mantine/tiptap';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { TextColorControl } from '~/components/RichTextEditor/TextColorControl';
import { constants } from '~/server/common/constants';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

const spanColor = () =>
  document.querySelector<HTMLElement>('.ProseMirror span[style]')?.style.color;
let html = '';
// What the article actually saves: the editor's HTML after the sanitiser.
const savedHtml = () => sanitizeHtml(html);

function Editor({ content }: { content: string }) {
  const editor = useEditor({
    extensions: [StarterKit, TextStyleKit],
    content,
    onUpdate: ({ editor }) => (html = editor.getHTML()),
  });
  return (
    <RichTextEditor editor={editor}>
      <RichTextEditor.Toolbar>
        <TextColorControl colors={constants.richTextEditor.presetColors} />
      </RichTextEditor.Toolbar>
      <RichTextEditor.Content />
    </RichTextEditor>
  );
}

async function openColorControl(content = '<p>hello</p>') {
  html = '';
  renderWithProviders(<Editor content={content} />);
  const text = page.getByText('hello');
  await expect.element(text).toBeInTheDocument();
  await userEvent.tripleClick(text);
  await userEvent.click(page.getByRole('button', { name: 'Text color' }));
}

describe('text colour control', () => {
  test('a typed hex colour, with or without #, is applied and survives the sanitiser', async () => {
    await openColorControl();
    await userEvent.fill(page.getByRole('textbox', { name: 'Hex color' }), ' 1A2b3C ');
    await userEvent.keyboard('{Enter}');

    await expect.poll(spanColor).toBe('rgb(26, 43, 60)');
    expect(savedHtml()).toMatch(/<span style="color:[^"]+">hello<\/span>/);
  });

  test('a hex the sanitiser would strip is refused, not applied', async () => {
    await openColorControl();
    const input = page.getByRole('textbox', { name: 'Hex color' });
    await userEvent.fill(input, '#12345');
    await userEvent.keyboard('{Enter}');

    await expect.element(input).toHaveAttribute('aria-invalid', 'true');
    expect(spanColor()).toBeUndefined();
  });

  test('a colour from the drag picker survives the sanitiser', async () => {
    await openColorControl();
    await userEvent.click(page.getByRole('button', { name: 'Color picker' }));
    // No Mantine CSS in this harness, so the picker has no size to click; drive it by keyboard.
    (
      page.getByRole('slider', { name: 'Saturation and brightness' }).element() as HTMLElement
    ).focus();
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');

    await expect.poll(spanColor).toBeTruthy();
    expect(savedHtml()).toMatch(/<span style="color:[^"]+">hello<\/span>/);
  });

  test('a preset swatch still applies', async () => {
    await openColorControl();
    await userEvent.click(page.getByRole('button', { name: 'Set color #fa5252' }));

    await expect.poll(spanColor).toBe('rgb(250, 82, 82)');
  });

  test('a typed hex moves the drag picker to that colour', async () => {
    await openColorControl();
    await userEvent.click(page.getByRole('button', { name: 'Color picker' }));
    await userEvent.fill(page.getByRole('textbox', { name: 'Hex color' }), '#ff0000');

    await expect
      .element(page.getByRole('slider', { name: 'Saturation and brightness' }))
      .toHaveAttribute('aria-valuetext', 'rgba(255, 0, 0, 1)');
  });

  test('reopening on saved coloured text shows its colour as hex', async () => {
    await openColorControl('<p><span style="color: rgb(26, 43, 60)">hello</span></p>');

    await expect.element(page.getByRole('textbox', { name: 'Hex color' })).toHaveValue('#1a2b3c');
  });

  test('the same colour applies again to a second selection', async () => {
    await openColorControl('<p>hello</p><p>world</p>');
    await userEvent.fill(page.getByRole('textbox', { name: 'Hex color' }), '#1a2b3c');
    await userEvent.keyboard('{Enter}');
    await expect.poll(spanColor).toBe('rgb(26, 43, 60)');

    await userEvent.tripleClick(page.getByText('world'));
    await userEvent.click(page.getByRole('button', { name: 'Text color' }));
    await expect.element(page.getByRole('textbox', { name: 'Hex color' })).toHaveValue('#1a2b3c');
    await userEvent.keyboard('{Enter}');

    await expect
      .poll(() =>
        [...document.querySelectorAll<HTMLElement>('.ProseMirror span[style]')].map(
          (s) => s.style.color
        )
      )
      .toEqual(['rgb(26, 43, 60)', 'rgb(26, 43, 60)']);
  });
});
