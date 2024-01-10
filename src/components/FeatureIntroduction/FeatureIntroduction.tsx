import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Center,
  Loader,
  Modal,
  Popover,
  Stack,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { useIsClient } from '../../providers/IsClientProvider';
import { dialogStore } from '../Dialog/dialogStore';
import { trpc } from '../../utils/trpc';
import { IconInfoCircle } from '@tabler/icons-react';
import { useDialogContext } from '../Dialog/DialogProvider';
import { set } from 'lodash';

type Props = {
  feature: string;
  contentSlug?: string | string[];
  actionButton?: React.ReactNode;
};

const FeatureIntroductionModal = ({ feature, contentSlug }: Omit<Props, 'actionButton'>) => {
  const { data: content, isLoading } = trpc.content.get.useQuery({
    slug: contentSlug ?? feature,
  });
  const dialog = useDialogContext();

  if (isLoading || !content)
    return (
      <Center>
        <Loader />
      </Center>
    );

  return (
    <Modal {...dialog} title={content.title} size="lg" withCloseButton>
      <ReactMarkdown rehypePlugins={[rehypeRaw]} className="markdown-content">
        {content.content}
      </ReactMarkdown>

      <Center>
        <Button onClick={dialog.onClose}>Close</Button>
      </Center>
    </Modal>
  );
};

export const FeatureIntroduction = ({
  feature,
  contentSlug,
  actionButton = (
    <ThemeIcon>
      <IconInfoCircle />
    </ThemeIcon>
  ),
}: Props) => {
  const isClient = useIsClient();
  const { data: content, isLoading } = trpc.content.get.useQuery({ slug: contentSlug ?? feature });
  const featureKey = `feature-introduction:${feature}`;

  const handleOpenDialog = () => {
    dialogStore.trigger({
      component: FeatureIntroductionModal,
      props: { feature, contentSlug },
    });
  };

  useEffect(() => {
    if (!isClient) return;

    const isDismissed = localStorage.getItem(featureKey) === 'true';

    if (content && !isDismissed) {
      localStorage.setItem(featureKey, 'true');
      handleOpenDialog();
    }
  }, [isClient, content]);

  if (isLoading || !content) return null;

  return (
    <Tooltip label={content.title} withArrow withinPortal>
      <UnstyledButton onClick={handleOpenDialog}>{actionButton}</UnstyledButton>
    </Tooltip>
  );
};
