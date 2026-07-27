import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconMarkdown } from '@tabler/icons-react';
import { useRef } from 'react';
import { formatBytes } from '~/utils/number-helpers';
import {
  showErrorNotification,
  showInfoNotification,
  showWarningNotification,
} from '~/utils/notifications';

const MAX_FILE_SIZE = 1024 * 1024 * 2;
const ACCEPTED_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;

export function InsertMarkdownControl(props: Props) {
  const { editor } = useRichTextEditorContext();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = async (file: File) => {
    if (!editor) return;

    if (file.size > MAX_FILE_SIZE) {
      showWarningNotification({
        message: `File is too big. Max file size is ${formatBytes(MAX_FILE_SIZE)}`,
      });
      return;
    }

    try {
      // Loaded on demand: the markdown stack is ~41 kB brotli and every other
      // editor surface shares this chunk.
      const { convertMarkdownForEditor, describeMarkdownConversion } = await import(
        '~/utils/markdown-to-editor-html'
      );
      const { html, ...stats } = convertMarkdownForEditor(await file.text());

      if (!html.trim()) {
        showWarningNotification({ message: 'That file appears to be empty.' });
        return;
      }

      // Replace on an untouched editor (the common case: importing a document
      // into a fresh article), otherwise splice in at the cursor so an import
      // can't wipe work in progress.
      if (editor.isEmpty) editor.commands.setContent(html);
      else editor.commands.insertContent(html);

      const notes = describeMarkdownConversion(stats);
      if (notes)
        showInfoNotification({
          title: 'Imported with changes',
          message: `${notes}. The article editor can't store those as-is.`,
          autoClose: 8000,
        });
    } catch (error) {
      showErrorNotification({
        title: 'Failed to import markdown',
        error: error as Error,
      });
    }
  };

  return (
    <RichTextEditor.Control
      {...props}
      onClick={() => inputRef.current?.click()}
      aria-label="Import Markdown"
      title="Import Markdown file"
    >
      <IconMarkdown size={16} stroke={1.5} />
      <input
        type="file"
        accept={[...ACCEPTED_EXTENSIONS, 'text/markdown'].join(',')}
        ref={inputRef}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so re-picking the same file after an edit still fires change.
          e.target.value = '';
          if (file) handleFile(file);
        }}
        hidden
      />
    </RichTextEditor.Control>
  );
}
