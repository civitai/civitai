import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { CommentsProvider, CreateComment, Comment } from '~/components/CommentsV2';
import { useEntityAccessRequirement } from '../../Club/club.utils';

type PostCommentsProps = {
  postId: number;
  userId: number;
};

export function PostComments({ postId, userId }: PostCommentsProps) {
  const { entities, isLoadingAccess } = useEntityAccessRequirement({
    entityType: 'Post',
    entityIds: [postId],
  });

  const [access] = entities;
  const hasAccess = access?.hasAccess;

  return (
    <CommentsProvider
      entityType="post"
      entityId={postId}
      limit={3}
      badges={[{ userId, label: 'op', color: 'violet' }]}
      forceLocked={!hasAccess}
    >
      {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
        isLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
            <CreateComment />
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} />
            ))}
            {!!remaining && !showMore && (
              <Divider
                label={
                  <Group spacing="xs" align="center">
                    <Text variant="link" sx={{ cursor: 'pointer' }} onClick={toggleShowMore}>
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
        )
      }
    </CommentsProvider>
  );
}
