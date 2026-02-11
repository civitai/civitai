import { Anchor, Button, CloseButton, Modal, Paper, Text } from '@mantine/core';
import Link from 'next/link';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { ChallengeDetails } from '~/components/Challenges/challenge.utils';
import { useGetActiveChallenges } from '~/components/Challenges/challenge.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { generationFormStore } from '~/store/generation-form.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { formatDate, isFutureDate, startOfDay } from '~/utils/date-helpers';

export function ChallengeInvitation({ onClose }: { onClose?: VoidFunction }) {
  const dialog = useDialogContext();

  const { challenges, loading, hasMore } = useGetActiveChallenges();

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
            <ChallengeInvitation2
              key={challenge.challengeId}
              {...challenge}
              onClose={handleClose}
            />
          ))}
          {hasMore && (
            <div className="px-5 pb-5 text-center">
              <Button
                component={NextLink}
                href="/challenges"
                variant="subtle"
                onClick={handleClose}
              >
                View all challenges →
              </Button>
            </div>
          )}
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
    if (props.resources.length) {
      generationGraphPanel.open({
        type: 'modelVersions',
        ids: props.resources,
      });
    }
    else generationGraphPanel.open();

    generationFormStore.setType('image');

    onClose();
  }
  const date = startOfDay(props.date);

  // Use challengeId for navigation to challenge detail page
  const detailUrl = `/challenges/${props.challengeId}`;

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
          <Text size="sm" c="dimmed">
            by{' '}
            <Link
              href={
                props.createdBy.username
                  ? `/user/${props.createdBy.username}`
                  : `/user?id=${props.createdBy.id}`
              }
              passHref
              legacyBehavior
            >
              <Anchor c="white" onClick={onClose}>
                {props.createdBy.deletedAt ? '[deleted]' : props.createdBy.username}
              </Anchor>
            </Link>
          </Text>
        </div>
      </div>
      <div className="flex flex-col gap-8 p-5">
        <div className="flex gap-2">
          <div className="shrink-0">
            <UserAvatar
              user={{ ...props.createdBy, cosmetics: props.createdBy.cosmetics ?? [] }}
              size="lg"
              linkToProfile
            />
          </div>
          <Paper className="w-full rounded-tl-none dark:bg-dark-5" p="xs" radius="md" shadow="sm">
            <Text size="lg">
              {props.invitation || 'Join this challenge and showcase your creativity!'}
            </Text>
          </Paper>
        </div>

        <div className="-mt-6 ml-auto">
          <Text size="sm">
            Click{' '}
            <Link href={detailUrl} passHref legacyBehavior>
              <Anchor onClick={onClose}>here</Anchor>
            </Link>{' '}
            to see the full details, rules and prizes.
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
