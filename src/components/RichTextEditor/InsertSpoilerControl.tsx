import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconEyeOff, IconPhotoOff } from '@tabler/icons-react';

export function SpoilerTextControl() {
  const { editor } = useRichTextEditorContext();
  return (
    <RichTextEditor.Control
      onClick={() => editor?.chain().focus().toggleSpoiler().run()}
      active={editor?.isActive('spoiler')}
      aria-label="Spoiler text (type ||text||)"
      title="Spoiler text (type ||text||)"
    >
      <IconEyeOff size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

export function SpoilerBlockControl() {
  const { editor } = useRichTextEditorContext();
  return (
    <RichTextEditor.Control
      onClick={() => editor?.chain().focus().toggleSpoilerBlock().run()}
      active={editor?.isActive('spoilerBlock')}
      aria-label="Spoiler block: hides images, embeds and text behind a reveal"
      title="Spoiler block: hides images, embeds and text behind a reveal"
    >
      <IconPhotoOff size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}
