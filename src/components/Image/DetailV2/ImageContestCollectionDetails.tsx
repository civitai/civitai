import { Anchor, Button, Card, Divider, Text } from '@mantine/core';
import { CollectionItemStatus, CollectionType } from '@prisma/client';
import { IconTournament } from '@tabler/icons-react';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { useImageContestCollectionDetails } from '~/components/Image/image.utils';
import { ShareButton } from '~/components/ShareButton/ShareButton';

export const ImageContestCollectionDetails = ({
  imageId,
  isOwner,
}: {
  imageId: number;
  isOwner: boolean;
}) => {
  const { collectionItems } = useImageContestCollectionDetails({ id: imageId });
  const { shareUrl } = useImageDetailContext();
  if ((collectionItems?.length ?? 0) === 0) return null;

  const displayedItems =
    collectionItems?.filter((ci) => ci.status === CollectionItemStatus.ACCEPTED || isOwner) ?? [];

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
          if (isOwner) {
            return (
              <div key={item.collection.id} className="flex flex-col gap-3">
                <Divider />
                <Text>
                  You have submitted this image to the{' '}
                  <Text weight="bold" component="span">
                    {item.collection.name}
                  </Text>{' '}
                  contest.
                </Text>

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
                  href={`/collection/${item.collection.id}`}
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
                contest.{' '}
              </Text>
              <Anchor href={`/collection/${item.collection.id}`} className="text-center" size="xs">
                View and vote on all contest entries
              </Anchor>
            </div>
          );
        })}
      </div>
    </Card>
  );
};
