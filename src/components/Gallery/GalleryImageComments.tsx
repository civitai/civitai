import { Stack, Group, Text, Loader, Center, Divider } from '@mantine/core';
import { CommentsProvider, LoadNextPage, CreateComment, Comment } from '~/components/CommentsV2';
import { useEffect } from 'react';
import { IconPlus } from '@tabler/icons';

type GalleryImageCommentsProps = {
  imageId: number;
  userId: number;
};

export function GalleryImageComments({ imageId, userId }: GalleryImageCommentsProps) {
  return (
    <CommentsProvider
      entityType="image"
      entityId={imageId}
      limit={3}
      badges={[{ userId, label: 'op', color: 'violet' }]}
    >
      {({ data, created, isInitialLoading, isFetching }) =>
        isInitialLoading ? (
          <Center p="xl">
            <Loader />
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
