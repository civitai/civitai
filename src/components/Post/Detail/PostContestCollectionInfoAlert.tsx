import { Alert, Anchor, Button, Group, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { CollectionItemStatus } from '@prisma/client';
import { PostContestCollectionItem } from '~/types/router';

export const PostContestCollectionInfoAlert = ({
  isOwner,
  collectionItem,
  itemLabel = 'post',
}: {
  isOwner?: boolean;
  collectionItem?: PostContestCollectionItem;
  itemLabel?: string;
}) => {
  const showDetails =
    collectionItem && (isOwner || collectionItem.status === CollectionItemStatus.ACCEPTED);

  if (!showDetails) return null;

  const collectionName = (
    <Text component="span" weight="bold">
      {collectionItem.collection.name}
    </Text>
  );

  if (isOwner) {
    return (
      <Alert>
        <Stack>
          {collectionItem.status === CollectionItemStatus.REVIEW ? (
            <Stack>
              <Text>
                Thank you for your submission to the {collectionName} contest!. We will review your
                submission and let you know if it is accepted so that it appears in the contest
                collection within 24 to 48 hours.
              </Text>
              <Text>You will receive a notification when your submission is reviewed.</Text>
            </Stack>
          ) : collectionItem.status === CollectionItemStatus.ACCEPTED ? (
            <Text>
              Your submission to the {collectionName} contest has been accepted and is now visible
              in the contest collection.
            </Text>
          ) : (
            <Text>
              Your submission to the {collectionName} contest has been rejected and will not be
              visible in the contest collection.
            </Text>
          )}

          <Group ml="auto">
            <Button
              component={NextLink}
              href={`/posts/create?collectionId=${collectionItem.collection.id}`}
              compact
            >
              Submit Another Entry
            </Button>
            <Button
              component={NextLink}
              href={`/collection/${collectionItem.collection.id}`}
              compact
              variant="outline"
            >
              View Contest Collection
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }

  return (
    <Alert>
      <Stack>
        <Text>
          This {itemLabel} is an entry in the{' '}
          <Anchor href={`/collection/${collectionItem.collection.id}`}>{collectionName}</Anchor>{' '}
          contest.
        </Text>
      </Stack>
    </Alert>
  );
};
