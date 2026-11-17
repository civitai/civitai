import { Center, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  CommentSectionProvider,
  useCommentSection,
} from '~/components/CommentsV3/CommentSectionContext';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { LoadMoreButton } from '~/components/LoadMoreButton/LoadMoreButton';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { ThreadSort } from '~/server/common/enums';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';

export default function HiddenCommentsModal(props: { modelId: number | string }) {
  // A direct `?dialog=hiddenComments` load passes `modelId` from the URL, as a string.
  const modelId = parseNumericString(props.modelId) || 0;
  const dialog = useDialogContext();
  const { data: model } = trpc.model.getById.useQuery({ id: modelId }, { enabled: !!modelId });

  return (
    <Modal
      {...dialog}
      title="Hidden Comments"
      closeButtonProps={{ 'aria-label': 'Close hidden comments modal' }}
      size="xl"
      withCloseButton
    >
      <Stack gap="xl">
        <AlertWithIcon icon={<IconAlertCircle />}>
          Some comments may be hidden by the author or moderators to ensure a positive and inclusive
          environment. Moderated for respectful and relevant discussions.
        </AlertWithIcon>
        {!!modelId && (
          <CommentSectionProvider
            entityType="model"
            entityId={modelId}
            ownerId={model?.user.id}
            deepLinks={false}
            initialSort={ThreadSort.Newest}
            hiddenOnly
          >
            <HiddenComments modelUserId={model?.user.id} />
          </CommentSectionProvider>
        )}
      </Stack>
    </Modal>
  );
}

function HiddenComments({ modelUserId }: { modelUserId?: number }) {
  const { rootIds, byId, removed, isLoading, hasMore, isFetchingMore, loadMore } =
    useCommentSection();

  if (isLoading)
    return (
      <Center mt="xl">
        <Loader type="bars" />
      </Center>
    );

  const comments = rootIds.flatMap((id) => {
    const comment = byId.get(id);
    return comment && !removed.has(id) ? [comment] : [];
  });
  if (!comments.length) return <Text>No hidden comments</Text>;

  return (
    <Stack>
      {comments.map((comment) => (
        <CommentDiscussionItem key={comment.id} data={comment} modelUserId={modelUserId} />
      ))}
      {hasMore && (
        <Center>
          <LoadMoreButton
            onClick={loadMore}
            loading={isFetchingMore}
            label="Load More Comments"
            color="blue"
            variant="subtle"
            size="md"
          />
        </Center>
      )}
    </Stack>
  );
}
