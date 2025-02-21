import { Anchor, Avatar, Button, CloseButton, Modal, Paper, Text } from '@mantine/core';
import Link from 'next/link';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { useQueryCurrentChallenge } from '~/components/Challenges/challenge.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { generationPanel } from '~/store/generation.store';
import { formatDate } from '~/utils/date-helpers';

export function ChallengeInvitation({ onClose }: { onClose?: VoidFunction }) {
  const dialog = useDialogContext();

  const { challenge, loading } = useQueryCurrentChallenge();

  const handleClose = () => {
    dialog.onClose();
    onClose?.();
  };

  const handleAccept = () => {
    if (challenge) {
      generationPanel.open({
        type: 'modelVersion',
        id: challenge.modelVersionIds[0],
      });
    }

    handleClose();
  };

  const header = (
    <div
      className="flex h-[150px] w-full justify-between p-5 md:h-[205px]"
      style={
        challenge
          ? {
              backgroundImage: `url(${getEdgeUrl(challenge.coverUrl, {
                width: DEFAULT_EDGE_IMAGE_WIDTH * 2.5,
              })})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              backgroundColor: 'rgba(0,0,0,0.6)',
              backgroundBlendMode: 'darken',
            }
          : undefined
      }
    >
      {challenge ? (
        <div className="flex flex-col gap-0 self-end">
          <Text size="xl" color="white" lineClamp={2} weight={600}>
            {challenge.title}
          </Text>
          <Text size="sm" color="white">
            {formatDate(challenge?.date)}
          </Text>
        </div>
      ) : (
        <Text size="xl" weight={600}>
          Daily Challenge Invitation
        </Text>
      )}
      <CloseButton
        variant="transparent"
        size="lg"
        color="gray.0"
        title="close modal"
        onClick={handleClose}
      />
    </div>
  );

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      radius="md"
      size="lg"
      classNames={{ modal: 'p-0 overflow-hidden' }}
      withCloseButton={false}
    >
      {loading ? (
        <PageLoader className="p-5" />
      ) : challenge ? (
        <>
          {header}
          <div className="flex flex-col gap-8 p-5">
            <div className="flex gap-2">
              <Avatar
                src="/images/civbot-judge.png"
                alt="Robot floating head"
                className="size-16 shrink-0 grow-0 rounded-full bg-gray-1 p-2 md:size-20 dark:bg-dark-5"
              />
              <Paper
                className="w-full rounded-tl-none dark:bg-dark-5"
                p="xs"
                radius="md"
                shadow="sm"
              >
                <Text size="lg">{challenge.invitation}</Text>
              </Paper>
            </div>

            <div className="-mt-6 ml-auto">
              <Text size="sm">
                Click{' '}
                <Link href={`/articles/${challenge.articleId}`} passHref legacyBehavior>
                  <Anchor onClick={handleClose}>here</Anchor>
                </Link>{' '}
                to read the full article for rules and prizes.
              </Text>
            </div>

            <div className="flex flex-col gap-2 md:flex-row md:justify-end">
              <Button component={NextLink} variant="light" className="w-full md:w-auto" href={`/posts/create?collectionId=${challenge.collectionId}`} onClick={handleClose}>
                Submit your Entry
              </Button>
              <Button className="w-full md:w-auto" onClick={handleAccept}>
                Accept Challenge
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          {header}
          <div className="flex flex-col gap-4 p-5 text-center">
            <p>There is no active challenge at the moment.</p>
          </div>
        </>
      )}
    </Modal>
  );
}
