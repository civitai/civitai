import { Anchor, Button, Card, Divider, Text } from '@mantine/core';
import { CollectionItemStatus, CollectionType } from '@prisma/client';
import { IconTournament } from '@tabler/icons-react';
import { useImageContestCollectionDetails } from '~/components/Image/image.utils';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { formatDate } from '~/utils/date-helpers';

export const ImageContestCollectionDetails = ({
  imageId,
  isOwner,
  isModerator,
  shareUrl,
}: {
  imageId: number;
  isOwner: boolean;
  isModerator?: boolean;
  shareUrl?: string;
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
                    <Text>
                      Share the link to your submission in the and have your friends react on it.
                      This could help you win the contest and the Community Choice award.
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
                      <Button radius="xl" color="gray" size="sm" compact className="center">
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
