import { Stack, Text, Center, Loader, Group, Alert, Button, useMantineTheme } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { CommentDetail } from '~/components/Comments/CommentDetail';
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
  initialLimit?: number;
} & CommentConnectorInput;

export function Comments({ entityId, entityType, initialData, initialLimit = 4 }: CommentsProps) {
  const router = useRouter();
  const user = useCurrentUser();
  const theme = useMantineTheme();
  console.log({ initialData });

  const { items, nextCursor } = useMemo(() => {
    const data = [...(initialData ?? [])];
    return {
      nextCursor: data.length > initialLimit ? data.splice(-1)[0]?.id : undefined,
      items: data,
    };
  }, [initialData, initialLimit]);

  const { data, isInitialLoading, fetchNextPage, hasNextPage } =
    trpc.commentv2.getInfinite.useInfiniteQuery(
      { entityId, entityType },
      {
        getNextPageParam: (lastPage) => {
          return !!lastPage ? lastPage.nextCursor : 0;
        },
        getPreviousPageParam: (firstPage) => {
          return !!firstPage ? firstPage.nextCursor : 0;
        },
        initialData: !!initialData
          ? {
              pages: [{ nextCursor, comments: items }],
              pageParams: [null],
            }
          : undefined,
      }
    );

  const handleMoreClick = () => fetchNextPage();

  const comments = useMemo(() => data?.pages.flatMap((x) => x.comments), [data]);

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
      {!comments && isInitialLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        comments &&
        comments.map((comment) => (
          <CommentDetail
            key={comment.id}
            comment={comment}
            entityId={entityId}
            entityType={entityType}
          />
        ))
      )}
      {hasNextPage &&
        (isInitialLoading ? (
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
