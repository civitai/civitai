import { Anchor, Button, Card, Divider, SegmentedControl, Text } from '@mantine/core';
import { CollectionItemStatus, CollectionType } from '@prisma/client';
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

export const ImageContestCollectionDetails = ({
  imageId,
  isOwner,
  isModerator,
  shareUrl,
  userId,
}: {
  imageId: number;
  isOwner: boolean;
  isModerator?: boolean;
  shareUrl?: string;
  userId?: number;
}) => {
  const isOwnerOrMod = isOwner || isModerator;
  const { collectionItems } = useImageContestCollectionDetails(
    { id: imageId },
    { enabled: !!imageId }
  );

  if ((collectionItems?.length ?? 0) === 0) return null;

  const displayedItems =
    collectionItems?.filter((ci) => ci.status === CollectionItemStatus.ACCEPTED || isOwnerOrMod) ??
    [];

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
          const userScore = item?.scores?.find((s) => s.userId === userId)?.score;

          if (isModerator && inReview) {
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
                <ReviewActions itemId={item.id} collectionId={item.collection.id} />
              </div>
            );
          }

          if (isOwnerOrMod) {
            return (
              <div key={item.collection.id} className="flex flex-col gap-3">
                <Divider />
                <Text>
                  You have submitted this image to the{' '}
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
                    {isModerator && !userScore ? (
                      <ContestItemScore
                        itemId={item.id}
                        collectionId={item.collection.id}
                        imageId={imageId}
                      />
                    ) : (
                      <>
                        <Text>
                          Share the link to your submission in the and have your friends react on
                          it. This could help you win the contest and the Community Choice award.
                        </Text>
                        <Text>
                          Please note than an account is required to react and reaction votes are
                          limited to one per account.
                        </Text>
                        <ShareButton
                          url={shareUrl}
                          title="Share now"
                          collect={{ type: CollectionType.Image, imageId }}
                        >
                          <Button
                            radius="xl"
                            color="gray"
                            size="sm"
                            compact
                            className="text-center"
                          >
                            <Text size="xs">Share Now</Text>
                          </Button>
                        </ShareButton>
                      </>
                    )}
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

function ContestItemScore({
  itemId,
  collectionId,
  imageId,
}: {
  itemId: number;
  collectionId: number;
  imageId: number;
}) {
  const [selectedScore, setSelectedScore] = useState(1);

  const { setItemScore, loading } = useSetCollectionItemScore({ imageId });
  const handleSetItemScore = async () => {
    await setItemScore({
      itemId,
      collectionId,
      score: selectedScore,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Text>
        Rate this submission on a scale of 1 to 10, with 1 being the lowest and 10 being the
        highest.
      </Text>
      <SegmentedControl
        data={['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']}
        value={selectedScore.toString()}
        onChange={(value) => setSelectedScore(Number(value))}
      />
      <Button onClick={handleSetItemScore} loading={loading}>
        Submit
      </Button>
    </div>
  );
}
