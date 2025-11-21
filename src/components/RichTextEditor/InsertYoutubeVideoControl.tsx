import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconBrandYoutube } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { UrlControlModal } from '~/components/RichTextEditor/UrlControlModal';

const controlTitle = 'Insert YouTube video';

export function InsertYoutubeVideoControl(props: Props) {
  const { editor } = useRichTextEditorContext();

  const handleClick = () => {
    dialogStore.trigger({
      component: UrlControlModal,
      props: {
        title: controlTitle,
        label: 'YouTube URL',
        placeholder: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        regex: /^(https?\:\/\/)?((www\.)?youtube\.com|youtu\.be)\/.+$/,
        onSuccess: ({ url }) => {
          editor?.commands.setYoutubeVideo({ src: url });
        },
      },
    });
  };

  return (
    <RichTextEditor.Control
      {...props}
      onClick={handleClick}
      aria-label={controlTitle}
      title={controlTitle}
    >
      <IconBrandYoutube size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;
