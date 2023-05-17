import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { CommentsProvider, LoadNextPage, CreateComment, Comment } from '~/components/CommentsV2';

type ArticleDetailCommentsProps = {
  articleId: number;
  userId: number;
};

export function ArticleDetailComments({ articleId, userId }: ArticleDetailCommentsProps) {
  return (
    <CommentsProvider
      entityType="article"
      entityId={articleId}
      limit={20}
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
                        {remaining > 0
                          ? `Show ${remaining} more ${remaining > 1 ? 'comments' : 'comment'}`
                          : 'Show more'}
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
