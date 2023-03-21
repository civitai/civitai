import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { CommentsProvider, LoadNextPage, CreateComment, Comment } from '~/components/CommentsV2';

type PostCommentsProps = {
  postId: number;
  userId: number;
};

export function PostComments({ postId, userId }: PostCommentsProps) {
  return (
    <CommentsProvider
      entityType="post"
      entityId={postId}
      limit={3}
      badges={[{ userId, label: 'op', color: 'violet' }]}
    >
      {({ data, created, isInitialLoading, isFetching }) =>
        isInitialLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
            <CreateComment />
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} />
            ))}
            <LoadNextPage>
              {({ remaining, onClick }) => (
                <Divider
                  label={
                    <Group spacing="xs" align="center">
                      {isFetching && <Loader size="xs" />}
                      <Text variant="link" sx={{ cursor: 'pointer' }} onClick={onClick}>
                        Load more comments
                      </Text>
                    </Group>
                  }
                  labelPosition="center"
                  variant="dashed"
                />
              )}
            </LoadNextPage>
            {created.map((comment) => (
              <Comment key={comment.id} comment={comment} />
            ))}
          </Stack>
        )
      }
    </CommentsProvider>
  );
}
