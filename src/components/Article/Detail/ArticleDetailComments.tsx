import { Stack, Group, Text, Loader, Center, Divider, Title, Button } from '@mantine/core';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import { IconMessageCancel } from '@tabler/icons-react';
import { SortFilter } from '~/components/Filters';
import type { ThreadSort } from '~/server/common/enums';
import { ReturnToRootThread } from '~/components/CommentsV2/ReturnToRootThread';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';
import { dialogStore } from '~/components/Dialog/dialogStore';
import HiddenCommentsModal from '~/components/CommentsV2/HiddenCommentsModal';

type ArticleDetailCommentsProps = {
  articleId: number;
  userId: number;
};

export function ArticleDetailComments({ articleId, userId }: ArticleDetailCommentsProps) {
  return (
    <>
      <RootThreadProvider
        entityType="article"
        entityId={articleId}
        limit={20}
        hideWhenLocked
        badges={[{ userId, label: 'op', color: 'violet' }]}
      >
        {({
          data,
          created,
          isLoading,
          isFetching,
          isFetchingNextPage,
          isLocked,
          showMore,
          hiddenCount,
          toggleShowMore,
          sort,
          setSort,
          activeComment,
        }) => isLocked ? null : (
          <Stack mt="xl" gap="xl">
            <Stack gap={0}>
              <Group justify="space-between">
                <Group gap="md">
                  <Title order={2} id="comments">
                    Comments
                  </Title>
                  {hiddenCount > 0 && !isLoading && (
                    <Button
                      variant="subtle"
                      onClick={() =>
                        dialogStore.trigger({
                          component: HiddenCommentsModal,
                          props: { entityId: articleId, entityType: 'article', userId },
                        })
                      }
                      size="compact-xs"
                    >
                      <Group gap={4} justify="center">
                        <IconMessageCancel size={16} />
                        <Text inherit inline>
                          {`See ${hiddenCount} more hidden ${
                            hiddenCount > 1 ? 'comments' : 'comment'
                          }`}
                        </Text>
                      </Group>
                    </Button>
                  )}
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
                      <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
                    ))}
                  </Stack>
                  {showMore && (
                    <Center>
                      <Button
                        onClick={toggleShowMore}
                        loading={isFetchingNextPage}
                        variant="subtle"
                        size="md"
                      >
                        Load More Comments
                      </Button>
                    </Center>
                  )}
                  {created.map((comment) => (
                    <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
                  ))}
                </Stack>
              </>
            )}
          </Stack>
        )}
      </RootThreadProvider>
    </>
  );
}
