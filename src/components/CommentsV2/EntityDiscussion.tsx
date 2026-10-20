import { Stack, Group, Text, Loader, Center, Divider, Title } from '@mantine/core';
import { LoadMoreButton } from '~/components/LoadMoreButton/LoadMoreButton';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import { SortFilter } from '~/components/Filters';
import type { ThreadSort } from '~/server/common/enums';
import { ReturnToRootThread } from '~/components/CommentsV2/ReturnToRootThread';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';

type Props = {
  entityType: CommentConnectorInput['entityType'];
  entityId: number;
  userId?: number;
  limit?: number;
};

export function EntityDiscussion({ entityType, entityId, userId, limit = 10 }: Props) {
  return (
    <RootThreadProvider
      entityType={entityType}
      entityId={entityId}
      limit={limit}
      hideWhenLocked
      badges={userId ? [{ userId, label: 'op', color: 'violet' }] : []}
    >
      {({
        data,
        created,
        isLoading,
        isFetching,
        isFetchingNextPage,
        isLocked,
        showMore,
        toggleShowMore,
        sort,
        setSort,
        activeComment,
      }) =>
        isLocked ? null : (
          <Stack mt="xl" gap="xl">
            <Stack gap={0}>
              <Group justify="space-between">
                <Group gap="md">
                  <Title order={2} id="comments">
                    Discussion
                  </Title>
                </Group>
                <SortFilter
                  type="threads"
                  value={sort}
                  onChange={(v) => setSort(v as ThreadSort)}
                />
              </Group>
              <ReturnToRootThread />
            </Stack>
            {isLoading || isFetching ? (
              <Center mt="xl">
                <Loader type="bars" />
              </Center>
            ) : (
              <>
                {activeComment && (
                  <Stack gap="xl">
                    <Divider />
                    <Text size="sm" c="dimmed">
                      Viewing thread for
                    </Text>
                    <Comment comment={activeComment} viewOnly />
                  </Stack>
                )}
                <Stack
                  gap="xl"
                  className={activeComment ? classes.rootCommentReplyInset : undefined}
                >
                  <CreateComment />
                  <Stack className="relative" gap="xl">
                    {data?.map((comment) => (
                      <Comment key={comment.id} comment={comment} />
                    ))}
                  </Stack>
                  {showMore && (
                    <Center>
                      <LoadMoreButton
                        onClick={toggleShowMore}
                        loading={isFetchingNextPage}
                        label="Load More Comments"
                        color="blue"
                        variant="subtle"
                        size="md"
                      />
                    </Center>
                  )}
                  {created.map((comment) => (
                    <Comment key={comment.id} comment={comment} />
                  ))}
                </Stack>
              </>
            )}
          </Stack>
        )
      }
    </RootThreadProvider>
  );
}
