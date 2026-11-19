import { Button, Group, Modal, Stack, Textarea } from '@mantine/core';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconMarkdown } from '@tabler/icons-react';
import type { Editor } from '@tiptap/core';
import { useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { markdownForEditor } from './markdown-for-editor';

export function InsertMarkdownControl() {
  const { editor } = useRichTextEditorContext();
  return (
    <RichTextEditor.Control
      aria-label="Insert Markdown"
      title="Insert Markdown"
      disabled={!editor?.isEditable}
      onClick={() => dialogStore.trigger({ component: InsertMarkdownModal, props: { editor } })}
    >
      <IconMarkdown size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

function InsertMarkdownModal({ editor }: { editor: Editor | null }) {
  const dialog = useDialogContext();
  const [source, setSource] = useState('');
  const [error, setError] = useState<string>();

  function insert() {
    const html = markdownForEditor(source);
    if (!html.trim()) {
      setError('Enter Markdown text or a table to insert.');
      return;
    }
    if (
      editor
        ?.chain()
        .focus()
        .insertContent(html, { parseOptions: { preserveWhitespace: false } })
        .run()
    ) {
      dialog.onClose();
    } else {
      setError('This content could not be inserted at the current selection.');
    }
  }

  return (
    <Modal title="Insert Markdown" {...dialog}>
      <Stack>
        <Textarea
          label="Markdown"
          description="Paste or type Markdown, including pipe tables."
          placeholder={'| Setting | Value |\n| --- | --- |\n| Steps | 20 |'}
          autosize
          minRows={5}
          maxRows={14}
          data-autofocus
          value={source}
          error={error}
          onChange={(event) => {
            setSource(event.currentTarget.value);
            setError(undefined);
          }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button disabled={!source.trim() || !editor?.isEditable} onClick={insert}>
            Insert
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
