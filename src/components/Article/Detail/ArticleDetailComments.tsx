import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { CommentsProvider, CreateComment, Comment } from '~/components/CommentsV2';

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
