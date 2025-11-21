import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconReportAnalytics } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { UrlControlModal } from '~/components/RichTextEditor/UrlControlModal';
import { STRAWPOLL_REGEX } from '~/libs/tiptap/extensions/StrawPoll';

const controlTitle = 'Embed StrawPoll';

export function InsertStrawPollControl(props: Props) {
  const { editor } = useRichTextEditorContext();

  const handleClick = () => {
    dialogStore.trigger({
      component: UrlControlModal,
      props: {
        title: controlTitle,
        label: 'StrawPoll URL',
        placeholder: 'https://www.strawpoll.com/polls/rae5gcp1',
        regex: STRAWPOLL_REGEX,
        onSuccess: ({ url }) => {
          editor?.commands.setStrawPollEmbed({ src: url });
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
      <IconReportAnalytics size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;
