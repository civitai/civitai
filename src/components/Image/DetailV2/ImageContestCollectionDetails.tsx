import { Anchor, Button, Card, Divider, SegmentedControl, Text } from '@mantine/core';
import { CollectionItemStatus, CollectionType } from '~/shared/utils/prisma/enums';
import { IconBan, IconCheck, IconTournament } from '@tabler/icons-react';
import { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import React, { useState } from 'react';
import { useSetCollectionItemScore } from '~/components/Collections/collection.utils';
import { useImageContestCollectionDetails } from '~/components/Image/image.utils';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { CollectionGetAllItems } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc, queryClient } from '~/utils/trpc';
import { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { ContestCollectionItemScorer } from '~/components/Collections/components/ContestCollections/ContestCollectionItemScorer';
import { CollectionItemNSFWLevelSelector } from '~/components/Collections/components/ContestCollections/CollectionItemNSFWLevelSelector';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';

export const ImageContestCollectionDetails = ({
  image,
  isOwner,
  isModerator,
  shareUrl,
  userId,
}: {
  image: {
    id: number;
    nsfwLevel?: number;
    postId?: number | null;
  };
  isOwner: boolean;
  isModerator?: boolean;
  shareUrl?: string;
  userId?: number;
}) => {
  const isOwnerOrMod = isOwner || isModerator;

  const { updateImage } = useImageDetailContext();
  const { collectionItems } = useImageContestCollectionDetails(
    { id: image.id },
    { enabled: !!image.id }
  );
  const queryUtils = trpc.useUtils();

  if ((collectionItems?.length ?? 0) === 0) return null;

  const displayedItems =
    collectionItems?.filter(
      (ci) => ci.status === CollectionItemStatus.ACCEPTED || isOwnerOrMod || ci.permissions?.manage
    ) ?? [];

  if (displayedItems.length === 0) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 text-xl font-semibold">
          <IconTournament />
          <span>Contests</span>
        </Text>
      </div>
      <div className="flex flex-col gap-3">
        {collectionItems?.map((item) => {
          const tagDisplay = item?.tag ? (
            <>
              {' '}
              for the{' '}
              <Text component="span" tt="capitalize" weight="bold">
                {item?.tag.name}
              </Text>{' '}
              category
            </>
          ) : null;
          const inReview = item.status === CollectionItemStatus.REVIEW;
          const collectionSupportsScoring = item?.collection?.metadata?.judgesCanScoreEntries;
          const isCollectionJudge = item?.permissions?.manage || isModerator;
          const handleScoreUpdated = ({
            collectionItemId,
            score,
            userId,
          }: {
            collectionItemId: number;
            score: number;
            userId: number;
          }) => {
            queryUtils.image.getContestCollectionDetails.setData(
              { id: image.id },
              produce((old) => {
                if (!old) return;

                const item = old.collectionItems.find((item) => item.id === collectionItemId);
                if (!item) return;

                const existingScore = item.scores.find((itemScore) => itemScore.userId === userId);
                if (!existingScore) {
                  item.scores.push({ userId, score });
                  return;
                }

                existingScore.score = score;
              })
            );
          };

          if (isCollectionJudge && inReview) {
            return (
              <div key={item.collection.id} className="flex flex-col gap-3">
                <Divider />
                <Text>
                  This image is part of the{' '}
                  <Text weight="bold" component="span">
                    {item.collection.name}
                  </Text>{' '}
                  contest{tagDisplay}.{' '}
                </Text>
                {isCollectionJudge && (
                  <CollectionItemNSFWLevelSelector
                    collectionId={item.collection.id}
                    collectionItemId={item.id}
                    nsfwLevel={image?.nsfwLevel}
                    onNsfwLevelUpdated={(value) => {
                      queryUtils.image.get.setData(
                        { id: image.id },
                        produce((old) => {
                          if (!old) return;

                          old.nsfwLevel = parseInt(value, 10);
                          return old;
                        })
                      );

                      updateImage(image.id, { nsfwLevel: parseInt(value, 10) });
                    }}
                  />
                )}
                <ReviewActions itemId={item.id} collectionId={item.collection.id} />
                {isCollectionJudge && collectionSupportsScoring && (
                  <ContestCollectionItemScorer
                    collectionItemId={item.id}
                    onScoreChanged={handleScoreUpdated}
                    currentScore={item.scores.find((s) => s.userId === userId)?.score}
                    layout="minimal"
                  />
                )}
              </div>
            );
          }

          if (isOwnerOrMod || isCollectionJudge) {
            return (
              <div key={item.collection.id} className="flex flex-col gap-3">
                {isCollectionJudge && (
                  <CollectionItemNSFWLevelSelector
                    collectionId={item.collection.id}
                    collectionItemId={item.id}
                    nsfwLevel={image?.nsfwLevel}
                    onNsfwLevelUpdated={(value) => {
                      queryUtils.image.get.setData(
                        { id: image.id },
                        produce((old) => {
                          if (!old) return;

                          old.nsfwLevel = parseInt(value, 10);
                          return old;
                        })
                      );

                      updateImage(image.id, { nsfwLevel: parseInt(value, 10) });
                    }}
                  />
                )}
                <Divider />
                <Text>
                  {isOwner ? 'You have' : 'This user has'} submitted this image to the{' '}
                  <Text weight="bold" component="span">
                    {item.collection.name}
                  </Text>{' '}
                  Contest{tagDisplay}.
                </Text>

                {!!item.collection.metadata?.votingPeriodStart && (
                  <Text>
                    The ability to react/vote for this film will go live starting at{' '}
                    <Text weight="bold" component="span">
                      {formatDate(item.collection.metadata?.votingPeriodStart)}
                    </Text>{' '}
                    when the Community Voting period begins
                  </Text>
                )}

                {item.status === CollectionItemStatus.REVIEW && (
                  <Text>
                    Your submission is currently under review and should be processed within 24 to
                    48 hours. Once done, you will get a notification.
                  </Text>
                )}
                {item.status === CollectionItemStatus.ACCEPTED && (
                  <div className="flex flex-col gap-3">
                    {isCollectionJudge && collectionSupportsScoring && (
                      <ContestCollectionItemScorer
                        collectionItemId={item.id}
                        onScoreChanged={handleScoreUpdated}
                        currentScore={item.scores.find((s) => s.userId === userId)?.score}
                        layout="minimal"
                      />
                    )}

                    <Text>
                      Share the link to your submission in the contest and have your friends react
                      on it. This could help you win the contest and the Community Choice award.
                    </Text>
                    <Text>
                      Please note than an account is required to react and reaction votes are
                      limited to one per account.
                    </Text>
                    <ShareButton
                      url={shareUrl}
                      title="Share now"
                      collect={{ type: CollectionType.Image, imageId: image.id }}
                    >
                      <Button radius="xl" color="gray" size="sm" compact className="text-center">
                        <Text size="xs">Share Now</Text>
                      </Button>
                    </ShareButton>
                  </div>
                )}
                {item.status === CollectionItemStatus.REJECTED && (
                  <Text>
                    Your submission to the {item.collection.name} contest has been rejected and will
                    not be visible in the contest collection.
                  </Text>
                )}

                <Anchor
                  href={`/collections/${item.collection.id}`}
                  className="text-center"
                  size="xs"
                >
                  View and vote on all contest entries
                </Anchor>
              </div>
            );
          }

          return (
            <div key={item.collection.id} className="flex flex-col gap-3">
              <Divider />
              <Text>
                This image is part of the{' '}
                <Text weight="bold" component="span">
                  {item.collection.name}
                </Text>{' '}
                contest{tagDisplay}.{' '}
              </Text>
              {!!item.collection.metadata?.votingPeriodStart && (
                <Text>
                  The ability to react/vote for this film will go live starting at{' '}
                  <Text weight="bold" component="span">
                    {formatDate(item.collection.metadata?.votingPeriodStart)}
                  </Text>{' '}
                  when the Community Voting period begins
                </Text>
              )}
              <Anchor href={`/collections/${item.collection.id}`} className="text-center" size="xs">
                View and vote on all contest entries
              </Anchor>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

function ReviewActions({ itemId, collectionId }: { itemId: number; collectionId: number }) {
  const queryUtils = trpc.useUtils();

  const updateCollectionItemsStatusMutation =
    trpc.collection.updateCollectionItemsStatus.useMutation({
      async onMutate({ collectionItemIds, status }) {
        await queryUtils.collection.getAllCollectionItems.cancel();

        const queryKey = getQueryKey(trpc.collection.getAllCollectionItems);
        queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
          produce(state, (old?: InfiniteData<CollectionGetAllItems>) => {
            if (!old?.pages?.length) return;

            for (const page of old.pages)
              for (const item of page.collectionItems) {
                if (collectionItemIds.includes(item.id)) {
                  item.status = status;
                }
              }
          })
        );
      },
      onSuccess(_, { status }) {
        showSuccessNotification({ message: `The items have been ${status.toLowerCase()}` });
      },
      onError(error) {
        showErrorNotification({
          title: 'Failed to review items',
          error: new Error(error.message),
        });
      },
    });

  const handleApproveSelected = () => {
    updateCollectionItemsStatusMutation.mutate({
      collectionItemIds: [itemId],
      status: CollectionItemStatus.ACCEPTED,
      collectionId,
    });
  };

  const handleRejectSelected = () => {
    updateCollectionItemsStatusMutation.mutate({
      collectionItemIds: [itemId],
      status: CollectionItemStatus.REJECTED,
      collectionId,
    });
  };

  const status = updateCollectionItemsStatusMutation.variables?.status;
  const loading = updateCollectionItemsStatusMutation.isLoading;

  return (
    <div className="flex items-center justify-center gap-4">
      <PopConfirm
        message={`Are you sure you want to reject this entry?`}
        onConfirm={handleRejectSelected}
        withArrow
        withinPortal
      >
        <Button
          className="flex-1"
          leftIcon={<IconBan size="1.25rem" />}
          color="red"
          disabled={loading}
          loading={loading && status === CollectionItemStatus.REJECTED}
        >
          Reject
        </Button>
      </PopConfirm>
      <PopConfirm
        message={`Are you sure you want to approve this entry?`}
        onConfirm={handleApproveSelected}
        withArrow
        withinPortal
      >
        <Button
          className="flex-1"
          leftIcon={<IconCheck size="1.25rem" />}
          disabled={loading}
          loading={loading && status === CollectionItemStatus.ACCEPTED}
        >
          Approve
        </Button>
      </PopConfirm>
    </div>
  );
}
