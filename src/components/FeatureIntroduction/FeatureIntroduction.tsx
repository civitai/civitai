import {
  ActionIcon,
  ActionIconProps,
  AspectRatio,
  Box,
  Button,
  Center,
  Loader,
  Modal,
  ModalProps,
  Tooltip,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { cloneElement, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { trpc } from '../../utils/trpc';
import { useDialogContext } from '../Dialog/DialogProvider';
import { dialogStore } from '../Dialog/dialogStore';
import { HelpButton } from '~/components/HelpButton/HelpButton';

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

export const FeatureIntroductionModal = ({
  feature,
  contentSlug,
  modalProps,
}: Omit<Props, 'actionButton'>) => {
  const { data: content, isLoading } = trpc.content.get.useQuery({
    slug: contentSlug ?? feature,
  });
  const dialog = useDialogContext();

  const videoKeysRequirements = [
    ['youtube', 'embed'],
    ['drive.google.com', 'preview'],
  ];

  return (
    <Modal {...dialog} size="lg" title={content?.title} {...modalProps} withCloseButton>
      {isLoading || !content ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <ReactMarkdown
          rehypePlugins={[rehypeRaw]}
          className="markdown-content"
          components={{
            a: ({ node, ...props }) => {
              if (
                videoKeysRequirements.some((requirements) =>
                  requirements.every((item) => props.href?.includes(item))
                )
              ) {
                return (
                  <AspectRatio ratio={16 / 9} maw={800} mx="auto">
                    <Box
                      component="iframe"
                      sx={{
                        border: 'none',
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                      }}
                      src={props.href as string}
                      allowFullScreen
                    />
                  </AspectRatio>
                );
              }

              return (
                <Link href={props.href as string} passHref>
                  <a
                    target={props.href?.includes('http') ? '_blank' : '_self'}
                    rel="nofollow noreferrer"
                  >
                    {props.children?.[0]}
                  </a>
                </Link>
              );
            },
          }}
        >
          {content.content}
        </ReactMarkdown>
      )}

      <Center>
        <Button onClick={dialog.onClose}>Close</Button>
      </Center>
    </Modal>
  );
};

export const FeatureIntroduction = ({
  feature,
  contentSlug,
  modalProps,
  actionButton = (
    <ActionIcon>
      <IconInfoCircle />
    </ActionIcon>
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
