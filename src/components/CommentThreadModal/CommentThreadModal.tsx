import { Center, Loader, Stack, Text } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';

import CommentSection from '~/components/CommentSection/CommentSection';
import { CommentGetAllItem } from '~/types/router';
import { trpc } from '~/utils/trpc';

export default function CommentThreadModal({ innerProps }: ContextModalProps<Props>) {
  const { comment } = innerProps;
  const { data: commentDetails, isLoading } = trpc.comment.getById.useQuery({ id: comment.id });

  return (
    <Stack spacing="xl">
      <Text>{comment.content}</Text>
      {isLoading ? (
        <Center my="xl">
          <Loader />
        </Center>
      ) : (
        <CommentSection
          comments={commentDetails?.comments ?? []}
          modelId={comment.modelId}
          parentId={comment.id}
        />
      )}
    </Stack>
  );
}

type Props = {
  comment: CommentGetAllItem;
};
