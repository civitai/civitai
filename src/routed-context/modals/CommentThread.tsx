import { Modal, Group, CloseButton, Alert, Center, Loader, Stack, Text } from '@mantine/core';
import { z } from 'zod';
import CommentSection from '~/components/CommentSection/CommentSection';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { daysFromNow } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  schema: z.object({
    commentId: z.number(),
  }),
  Element: ({ context, props: { commentId } }) => {
    const { data, isLoading } = trpc.comment.getById.useQuery({ id: commentId });

    return (
      <Modal opened={context.opened} onClose={context.close} withCloseButton={false} size={800}>
        {isLoading ? (
          <Center p="xl" style={{ height: 300 }}>
            <Loader />
          </Center>
        ) : !data ? (
          <Alert>Comment could not be found</Alert>
        ) : (
          <Stack>
            <Group position="apart" align="flex-start">
              <UserAvatar
                user={data.user}
                subText={daysFromNow(data.createdAt)}
                size="lg"
                spacing="xs"
                withUsername
              />
              <CloseButton onClick={context.close} />
            </Group>
            <Stack spacing="xl">
              <Text>{data.content}</Text>
              <CommentSection
                comments={data.comments ?? []}
                modelId={data.modelId}
                parentId={data.id}
              />
            </Stack>
          </Stack>
        )}
      </Modal>
    );
  },
});
