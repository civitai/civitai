import { Button, Group, Modal } from '@mantine/core';
import rehypeRaw from 'rehype-raw';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { useDialogContext } from '~/components/Dialog/DialogContext';

export default function RegionWarningModal({
  title,
  content,
  storageKey,
}: {
  title: string;
  content: string;
  storageKey: string;
}) {
  const dialog = useDialogContext();

  const handleDismiss = () => {
    dialog.onClose();
    localStorage.setItem(storageKey, 'true');
  };

  return (
    <Modal
      {...dialog}
      title={`⚠️ ${title}`}
      classNames={{
        title: 'text-xl font-bold text-inherit',
        header: 'bg-red-5 text-white',
        close: 'text-inherit',
      }}
      size="xl"
      centered
    >
      <TypographyStylesWrapper>
        <CustomMarkdown
          rehypePlugins={[rehypeRaw]}
          remarkPlugins={[remarkBreaks, remarkGfm]}
          className="markdown-content-spaced"
        >
          {content}
        </CustomMarkdown>
      </TypographyStylesWrapper>
      <Group justify="flex-end" gap="sm" mt="lg">
        <Button variant="outline" onClick={handleDismiss}>
          Dismiss
        </Button>
      </Group>
    </Modal>
  );
}
