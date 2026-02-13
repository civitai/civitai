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

type Props = {
  challengeId: number;
  userId?: number;
};

export function ChallengeDiscussion({ challengeId, userId }: Props) {
  return (
    <RootThreadProvider
      entityType="challenge"
      entityId={challengeId}
      limit={10}
      hideWhenLocked
      badges={userId ? [{ userId, label: 'op', color: 'violet' }] : []}
    >
      {({
        data,
        created,
        isLoading,
        isFetching,
        isFetchingNextPage,
        showMore,
        hiddenCount,
        toggleShowMore,
        sort,
        setSort,
        activeComment,
      }) => (
        <Stack mt="xl" gap="xl">
          <Stack gap={0}>
            <Group justify="space-between">
              <Group gap="md">
                <Title order={2} id="comments">
                  Discussion
                </Title>
                {hiddenCount > 0 && !isLoading && (
                  <Button
                    variant="subtle"
                    onClick={() =>
                      dialogStore.trigger({
                        component: HiddenCommentsModal,
                        props: { entityId: challengeId, entityType: 'challenge', userId },
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
              <SortFilter type="threads" value={sort} onChange={(v) => setSort(v as ThreadSort)} />
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
              <Stack gap="xl" className={activeComment ? classes.rootCommentReplyInset : undefined}>
                <CreateComment />
                <Stack className="relative" gap="xl">
                  {data?.map((comment) => (
                    <Comment key={comment.id} comment={comment} />
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
                  <Comment key={comment.id} comment={comment} />
                ))}
              </Stack>
            </>
          )}
        </Stack>
      )}
    </RootThreadProvider>
  );
}
