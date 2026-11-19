import { RichTextEditor } from '@mantine/tiptap';
import { generateJSON } from '@tiptap/html';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { InsertMarkdownControl } from '~/components/RichTextEditor/InsertMarkdownControl';
import { RenderRichText } from '~/components/RichTextEditor/RenderRichText';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { markdownTableExtensions } from '~/shared/tiptap/markdown-table';

function Editor({ onChange }: { onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit, ...markdownTableExtensions],
    content: '<p>Before</p><p>After</p>',
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });
  return (
    <>
      <RichTextEditor editor={editor}>
        <InsertMarkdownControl />
        <RichTextEditor.Content />
      </RichTextEditor>
      <DialogProvider />
    </>
  );
}

test('inserts a table at the cursor, edits a cell, and reads the saved table in an article', async () => {
  const onChange = vi.fn<(html: string) => void>();
  const view = await renderWithProviders(<Editor onChange={onChange} />);
  await page.getByText('Before').click();
  await userEvent.keyboard('{End}');
  await page.getByRole('button', { name: 'Insert Markdown' }).click();

  const insert = page.getByRole('button', { name: 'Insert', exact: true });
  await expect.element(insert).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Markdown' })
    .fill('| Name | Steps |\n| --- | ---: |\n| **Base** | 2 |');
  await insert.click();

  const value = page.getByRole('cell', { name: '2' });
  await value.click();
  await userEvent.keyboard('{End}4');
  await expect.element(page.getByRole('cell', { name: '24' })).toBeVisible();

  const saved = onChange.mock.lastCall![0];
  await view.rerender(<RenderRichText content={generateJSON(saved, tiptapExtensions)} />);
  const header = page.getByRole('columnheader', { name: 'Steps' });
  await expect.element(header).toBeVisible();
  expect(getComputedStyle(header.element()).textAlign).toBe('right');
  const cell = page.getByRole('cell', { name: '24' });
  await expect.element(cell).toBeVisible();
  expect(getComputedStyle(cell.element()).textAlign).toBe('right');
  expect(page.getByRole('cell', { name: 'Base' }).element().querySelector('strong')).toBeTruthy();
  const table = page.getByRole('table').element().parentElement;
  expect(table?.previousElementSibling?.textContent).toBe('Before');
  expect(table?.nextElementSibling?.textContent).toBe('After');
});
