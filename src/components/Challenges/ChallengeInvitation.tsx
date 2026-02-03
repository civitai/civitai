import { Anchor, Avatar, Button, CloseButton, Modal, Paper, Text } from '@mantine/core';
import Link from 'next/link';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { ChallengeDetails } from '~/components/Challenges/challenge.utils';
import { useGetActiveChallenges } from '~/components/Challenges/challenge.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { formatDate, isFutureDate, startOfDay } from '~/utils/date-helpers';
import { LogoBadge } from '~/components/Logo/LogoBadge';

export function ChallengeInvitation({ onClose }: { onClose?: VoidFunction }) {
  const dialog = useDialogContext();

  const { challenges, loading } = useGetActiveChallenges();

  const handleClose = () => {
    dialog.onClose();
    onClose?.();
  };

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      radius="md"
      size="lg"
      classNames={{ content: 'p-0' }}
      withCloseButton={false}
    >
      <CloseButton
        variant="transparent"
        size="lg"
        color="gray.0"
        title="close modal"
        onClick={handleClose}
        className="absolute right-5 top-5"
      />
      {loading ? (
        <PageLoader className="p-5" />
      ) : !!challenges.length ? (
        <div className="flex flex-col gap-5">
          {challenges.map((challenge) => (
            <ChallengeInvitation2 key={challenge.articleId} {...challenge} onClose={handleClose} />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4 p-5 text-center">
            <p>There is no active challenge at the moment.</p>
          </div>
        </>
      )}
    </Modal>
  );
}

function ChallengeInvitation2({ onClose, ...props }: ChallengeDetails & { onClose: () => void }) {
  function handleAccept() {
    const modelVersionId = props.resources?.[0].id;
    if (modelVersionId)
      generationGraphPanel.open({
        type: 'modelVersion',
        id: modelVersionId,
      });
    else generationGraphPanel.open();

    onClose();
  }
  const date = startOfDay(props.date);

  return (
    <div className="flex flex-col">
      <div
        className="flex h-[150px] w-full justify-between p-5 md:h-[205px]"
        style={{
          backgroundImage: `url(${getEdgeUrl(props.coverUrl, {
            width: DEFAULT_EDGE_IMAGE_WIDTH * 2.5,
          })})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          backgroundColor: 'rgba(0,0,0,0.6)',
          backgroundBlendMode: 'darken',
        }}
      >
        <div className="flex flex-col gap-0 self-end">
          <Text size="xl" c="white" lineClamp={2} fw={600}>
            {props.title}
          </Text>
          <Text size="sm" c="white">
            {isFutureDate(date) ? 'Ends on ' : ''}
            {formatDate(props?.date)}
          </Text>
        </div>
      </div>
      <div className="flex flex-col gap-8 p-5">
        <div className="flex gap-2">
          {props.judge === 'team' ? (
            <LogoBadge className="size-16" />
          ) : (
            <Avatar
              src="/images/civbot-judge.png"
              alt="Robot floating head"
              className="size-16 shrink-0 grow-0 rounded-full bg-gray-1 p-2 md:size-20 dark:bg-dark-5"
            />
          )}
          <Paper className="w-full rounded-tl-none dark:bg-dark-5" p="xs" radius="md" shadow="sm">
            <Text size="lg">{props.invitation}</Text>
          </Paper>
        </div>

        <div className="-mt-6 ml-auto">
          <Text size="sm">
            Click{' '}
            <Link href={`/articles/${props.articleId}`} passHref legacyBehavior>
              <Anchor onClick={onClose}>here</Anchor>
            </Link>{' '}
            to read the full article for rules and prizes.
          </Text>
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:justify-end">
          <Button
            component={NextLink}
            variant="light"
            className="w-full md:w-auto"
            href={`/posts/create?collectionId=${props.collectionId}`}
            onClick={onClose}
          >
            Submit your Entry
          </Button>
          <Button className="w-full md:w-auto" onClick={handleAccept}>
            Accept Challenge
          </Button>
        </div>
      </div>
    </div>
  );
}
