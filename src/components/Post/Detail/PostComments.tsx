import {
  Stack,
  Group,
  Text,
  Loader,
  Center,
  Divider,
  Title,
  Button,
  LoadingOverlay,
} from '@mantine/core';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import { ReturnToRootThread } from '../../CommentsV2/ReturnToRootThread';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';
import { IconMessageCancel } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import HiddenCommentsModal from '~/components/CommentsV2/HiddenCommentsModal';
import { SortFilter } from '~/components/Filters';
import type { ThreadSort } from '~/server/common/enums';

type PostCommentsProps = {
  postId: number;
  userId: number;
};

export function PostComments({ postId, userId }: PostCommentsProps) {
  return (
    <RootThreadProvider
      entityType="post"
      entityId={postId}
      limit={3}
      badges={[{ userId, label: 'op', color: 'violet' }]}
    >
      {({
        data,
        created,
        isLoading,
        isFetching,
        remaining,
        showMore,
        toggleShowMore,
        activeComment,
        hiddenCount,
        sort,
        setSort,
      }) => (
        <div className="flex w-full flex-col gap-4">
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
                      props: { entityId: postId, entityType: 'post', userId },
                    })
                  }
                  size="compact-xs"
                >
                  <Group gap={4} justify="center">
                    <IconMessageCancel size={16} />
                    <Text inherit inline>
                      {`See ${hiddenCount} more hidden ${hiddenCount > 1 ? 'comments' : 'comment'}`}
                    </Text>
                  </Group>
                </Button>
              )}
            </Group>
            <SortFilter type="threads" value={sort} onChange={(v) => setSort(v as ThreadSort)} />
          </Group>
          {isLoading ? (
            <Center>
              <Loader type="bars" />
            </Center>
          ) : (
            <Stack className="relative">
              <ReturnToRootThread />
              {activeComment && (
                <Stack gap="xl">
                  <Divider />
                  <Text size="sm" c="dimmed">
                    Viewing thread for
                  </Text>
                  <Comment comment={activeComment} viewOnly />
                </Stack>
              )}
              <Stack className={activeComment ? classes.rootCommentReplyInset : undefined}>
                <CreateComment />
                <Stack className="relative">
                  <LoadingOverlay visible={isFetching} />
                  {data?.map((comment) => (
                    <Comment key={comment.id} comment={comment} />
                  ))}
                </Stack>
                {!!remaining && !showMore && (
                  <Divider
                    label={
                      <Group gap="xs" align="center">
                        <Text c="blue.4" style={{ cursor: 'pointer' }} onClick={toggleShowMore}>
                          Show {remaining} More
                        </Text>
                      </Group>
                    }
                    labelPosition="center"
                    variant="dashed"
                  />
                )}
                {created.map((comment) => (
                  <Comment key={comment.id} comment={comment} />
                ))}
              </Stack>
            </Stack>
          )}
        </div>
      )}
    </RootThreadProvider>
  );
}
