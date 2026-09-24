import { Button, Center, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { ReviewSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

// Legacy model comments only: a hidden CommentV2 renders in place as a placeholder instead.
export default function HiddenCommentsModal({
  entityId,
}: {
  entityType: 'model';
  entityId: number;
}) {
  const dialog = useDialogContext();
  return (
    <Modal
      {...dialog}
      title="Hidden Comments"
      closeButtonProps={{
        'aria-label': 'Close hidden comments modal',
      }}
      size="xl"
      withCloseButton
    >
      <Stack gap="xl">
        <AlertWithIcon icon={<IconAlertCircle />}>
          Some comments may be hidden by the author or moderators to ensure a positive and inclusive
          environment. Moderated for respectful and relevant discussions.
        </AlertWithIcon>
        <HiddenModelCommentsContent modelId={entityId} />
      </Stack>
    </Modal>
  );
}

function HiddenModelCommentsContent({ modelId }: { modelId: number }) {
  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage } =
    trpc.comment.getAll.useInfiniteQuery(
      { modelId, limit: 20, sort: ReviewSort.Newest, hidden: true },
      { getNextPageParam: (lastPage) => lastPage.nextCursor, placeholderData: undefined }
    );

  const comments = useMemo(() => data?.pages.flatMap((x) => x.comments) ?? [], [data?.pages]);

  if (isLoading) {
    return (
      <Center mt="xl">
        <Loader type="bars" />
      </Center>
    );
  }

  if (!comments.length) {
    return <Text>No hidden comments</Text>;
  }

  return (
    <Stack>
      {comments.map((comment) => (
        <CommentDiscussionItem key={comment.id} data={comment} />
      ))}
      {hasNextPage && (
        <Center>
          <Button
            onClick={() => fetchNextPage()}
            loading={isFetchingNextPage}
            variant="subtle"
            size="md"
          >
            Load More Comments
          </Button>
        </Center>
      )}
    </Stack>
  );
}
