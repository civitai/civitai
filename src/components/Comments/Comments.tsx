import { Stack, Text, Center, Loader, Group, Alert, Button, useMantineTheme } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { useRouter } from 'next/router';
import { CommentForm } from '~/components/Comments/CommentForm';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';

/*
  - take initial comments
  - view more comments
  - add a comment
  - edit comment
  - delete comment
*/
type CommentsProps = {
  initialData?: InfiniteCommentResults['comments'];
} & CommentConnectorInput;

export function Comments({ entityId, entityType, initialData }: CommentsProps) {
  const router = useRouter();
  const user = useCurrentUser();
  const theme = useMantineTheme();

  const { data, isLoading, fetchNextPage, hasNextPage } =
    trpc.commentv2.getInfinite.useInfiniteQuery(
      { entityId, entityType },
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      }
    );

  const handleMoreClick = () => fetchNextPage();

  return (
    <Stack>
      {/* New Comment */}
      {user ? (
        <Group align="flex-start" noWrap>
          <UserAvatar user={user} size="md" />
          <CommentForm entityId={entityId} entityType={entityType} />
        </Group>
      ) : (
        <Alert>
          <Stack align="center" justify="center" spacing={2}>
            <Text size="xs" color={theme.colors.gray[4]}>
              You must be logged in to add a comment
            </Text>
            <Button
              component={NextLink}
              href={`/login?returnUrl=${router.asPath}`}
              size="xs"
              compact
            >
              Log In
            </Button>
          </Stack>
        </Alert>
      )}
      {!data && isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <></>
      )}
      {hasNextPage &&
        (isLoading ? (
          <Center>
            <Loader variant="dots" />
          </Center>
        ) : (
          <Text variant="link" onClick={handleMoreClick}>
            Show more
          </Text>
        ))}
    </Stack>
  );
}
