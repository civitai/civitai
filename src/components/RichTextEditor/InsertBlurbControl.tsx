import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconRepeat } from '@tabler/icons-react';
import { openBlurbManager } from '~/components/RichTextEditor/blurb-manager';

const controlTitle = 'Insert blurb';

/**
 * The only labelled control in the toolbar. Blurbs are a feature a creator has to learn exists,
 * and a bare glyph does not teach it.
 */
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
          onInsert: (blurb) =>
            editor
              ?.chain()
              .focus()
              .insertContent({ type: 'blurb', attrs: { id: blurb.id, text: blurb.content } })
              .run(),
        })
      }
    >
      <IconRepeat size={16} stroke={1.5} />
      <span className="text-xs font-semibold">Blurbs</span>
    </RichTextEditor.Control>
  );
}
