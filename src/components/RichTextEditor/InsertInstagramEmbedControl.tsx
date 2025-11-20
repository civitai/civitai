import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconBrandInstagram } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { UrlControlModal } from '~/components/RichTextEditor/UrlControlModal';
import { INSTAGRAM_REGEX } from '~/libs/tiptap/extensions/Instagram';

const controlTitle = 'Embed Instagram Post';

export function InsertInstagramEmbedControl(props: Props) {
  const { editor } = useRichTextEditorContext();

  const handleClick = () => {
    dialogStore.trigger({
      component: UrlControlModal,
      props: {
        title: controlTitle,
        label: 'Instagram URL',
        placeholder: 'https://www.instagram.com/p/COZ3QqYhZ5I',
        regex: INSTAGRAM_REGEX,
        onSuccess: ({ url }) => {
          editor?.commands.setInstagramEmbed({ src: url });
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
      <IconBrandInstagram size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;
