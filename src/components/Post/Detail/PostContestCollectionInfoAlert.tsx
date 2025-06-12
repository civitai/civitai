import { Alert, Anchor, Button, Group, Stack, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import type { PostContestCollectionItem } from '~/types/router';

export const PostContestCollectionInfoAlert = ({
  isOwner,
  collectionItem,
  itemLabel = 'post',
  isModerator,
}: {
  isOwner?: boolean;
  isModerator?: boolean;
  collectionItem?: PostContestCollectionItem;
  itemLabel?: string;
}) => {
  const showDetails =
    collectionItem &&
    collectionItem.collection.metadata?.includeContestCallouts &&
    (isOwner || isModerator || collectionItem.status === CollectionItemStatus.ACCEPTED);

  if (!showDetails) return null;

  const collectionName = (
    <Text component="span" fw="bold">
      {collectionItem.collection.name}
    </Text>
  );

  const tagDisplay = collectionItem?.tag ? (
    <>
      {' '}
      for the{' '}
      <Text tt="capitalize" fw="bold" span>
        {collectionItem?.tag.name}
      </Text>{' '}
      category
    </>
  ) : null;

  if (isOwner || isModerator) {
    return (
      <Alert>
        <Stack>
          {collectionItem.status === CollectionItemStatus.REVIEW ? (
            <Stack>
              <Text>
                Thank you for your submission to the {collectionName} contest{tagDisplay}! We will
                review your submission and let you know if it is accepted so that it appears in the
                contest collection within 72 hours.
              </Text>
              <Text>You will receive a notification when your submission is reviewed.</Text>
            </Stack>
          ) : collectionItem.status === CollectionItemStatus.ACCEPTED ? (
            <Text>
              Your submission to the {collectionName} contest has been accepted and is now visible
              in the contest collection{tagDisplay}.
            </Text>
          ) : (
            <Text>
              Your submission to the {collectionName} contest has been rejected and will not be
              visible in the contest collection.
            </Text>
          )}

          <Group ml="auto">
            <Button
              component={Link}
              href={`/posts/create?collectionId=${collectionItem.collection.id}`}
              size="compact-sm"
            >
              Submit Another Entry
            </Button>
            <Button
              component={Link}
              href={`/collections/${collectionItem.collection.id}`}
              size="compact-sm"
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
          <Link href={`/collections/${collectionItem.collection.id}`} passHref legacyBehavior>
            <Anchor>{collectionName}</Anchor>
          </Link>{' '}
          contest{tagDisplay}.
        </Text>
      </Stack>
    </Alert>
  );
};
