import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconMoodSmile } from '@tabler/icons-react';
import { StickerPicker } from '~/components/Sticker/StickerPicker';

const controlTitle = 'Insert sticker';

/**
 * Wraps the shared picker in a toolbar control. The picker itself is mount-point
 * agnostic — the same component backs the chat composer.
 */
export function InsertStickerControl(props: RichTextEditorControlProps) {
  const { editor } = useRichTextEditorContext();

  return (
    <StickerPicker
      position="bottom-start"
      onSelect={(sticker) =>
        editor?.chain().focus().setSticker({ id: sticker.id, slug: sticker.slug }).run()
      }
      target={
        <RichTextEditor.Control {...props} aria-label={controlTitle} title={controlTitle}>
          <IconMoodSmile size={16} stroke={1.5} />
        </RichTextEditor.Control>
      }
    />
  );
}
