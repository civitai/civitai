import {
  ActionIcon,
  ActionIconProps,
  Button,
  Center,
  Loader,
  Modal,
  ModalProps,
  Tooltip,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { cloneElement, useCallback, useEffect } from 'react';
import rehypeRaw from 'rehype-raw';
import { trpc } from '../../utils/trpc';
import { useDialogContext } from '../Dialog/DialogProvider';
import { dialogStore } from '../Dialog/dialogStore';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

type Props = {
  feature: string;
  contentSlug?: string | string[];
  actionButton?: React.ReactElement<
    ActionIconProps & {
      onClick?: React.MouseEventHandler<HTMLButtonElement>;
    }
  >;
  modalProps?: Omit<ModalProps, 'opened' | 'onClose'>;
};

export default function FeatureIntroductionModal({
  feature,
  contentSlug,
  modalProps,
}: Omit<Props, 'actionButton'>) {
  const { data: content, isLoading } = trpc.content.get.useQuery({
    slug: contentSlug ?? feature,
  });
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} size="lg" title={content?.title} {...modalProps} withCloseButton>
      {isLoading || !content ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <CustomMarkdown rehypePlugins={[rehypeRaw]} allowExternalVideo>
          {content.content}
        </CustomMarkdown>
      )}

      <Center>
        <Button onClick={dialog.onClose}>Close</Button>
      </Center>
    </Modal>
  );
}

export const FeatureIntroduction = ({
  feature,
  contentSlug,
  modalProps,
  actionButton = (
    <LegacyActionIcon>
      <IconInfoCircle />
    </LegacyActionIcon>
  ),
}: Props) => {
  const { data: content, isLoading } = trpc.content.get.useQuery({ slug: contentSlug ?? feature });
  const featureKey = `feature-introduction:${feature}`;

  const handleOpenDialog = useCallback(() => {
    dialogStore.trigger({
      component: FeatureIntroductionModal,
      props: { feature, contentSlug, modalProps },
    });
  }, [contentSlug, feature, modalProps]);

  useEffect(() => {
    const isDismissed = localStorage.getItem(featureKey) === 'true';

    if (content && !isDismissed) {
      localStorage.setItem(featureKey, 'true');
      handleOpenDialog();
    }
  }, [content, handleOpenDialog, featureKey]);

  if (isLoading || !content) return null;

  return (
    <Tooltip label={content.title} maw={300} withArrow withinPortal>
      {actionButton && cloneElement(actionButton, { onClick: handleOpenDialog })}
    </Tooltip>
  );
};

export function FeatureIntroductionHelpButton({
  feature,
  contentSlug,
  modalProps,
}: Omit<Props, 'actionButton'>) {
  const handleOpenDialog = useCallback(() => {
    dialogStore.trigger({
      component: FeatureIntroductionModal,
      props: { feature, contentSlug, modalProps },
    });
  }, [contentSlug, feature, modalProps]);

  return <HelpButton onClick={handleOpenDialog} />;
}
