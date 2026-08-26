import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconRepeat } from '@tabler/icons-react';
import { openBlurbManager } from '~/components/Dialog/triggers/blurb-manager';
import { insertBlurb } from '~/components/RichTextEditor/blurb.util';

const controlTitle = 'Insert snippet';

export function InsertBlurbControl(props: RichTextEditorControlProps) {
  const { editor } = useRichTextEditorContext();

  return (
    <RichTextEditor.Control
      {...props}
      aria-label={controlTitle}
      title={controlTitle}
      className="w-auto gap-1.5 bg-blue-1 px-2 text-blue-8 dark:bg-blue-8/20 dark:text-blue-4"
      onClick={() =>
        openBlurbManager({
          onInsert: (blurb) => {
            if (editor) insertBlurb(editor, blurb);
          },
        })
      }
    >
      <IconRepeat size={16} stroke={1.5} />
      <span className="text-xs font-semibold">Snippets</span>
    </RichTextEditor.Control>
  );
}
