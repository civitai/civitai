import { Button, Center, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { ReviewSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

type CommentEntityType =
  | 'model'
  | 'model3d'
  | 'model3dReview'
  | 'post'
  | 'article'
  | 'bounty'
  | 'bountyEntry'
  | 'challenge'
  | 'comment'
  | 'image'
  | 'appListing';

export default function HiddenCommentsModal({
  entityId,
  entityType,
  userId,
}: {
  entityType: CommentEntityType;
  entityId: number;
  userId?: number; // Optional userId for badges, if needed
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
        {entityType === 'model' ? (
          <HiddenModelCommentsContent modelId={entityId} />
        ) : (
          <HiddenCommentsContent entityType={entityType} entityId={entityId} userId={userId} />
        )}
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

function HiddenCommentsContent({
  entityType,
  entityId,
  userId,
}: {
  entityType: CommentEntityType;
  entityId: number;
  userId?: number;
}) {
  return (
    <RootThreadProvider
      entityType={entityType}
      entityId={entityId}
      limit={20}
      badges={userId ? [{ userId, label: 'op', color: 'violet' }] : undefined}
      hidden
    >
      {({ data, isLoading, isFetching, isFetchingNextPage, showMore, toggleShowMore }) =>
        isLoading || isFetching ? (
          <Center mt="xl">
            <Loader type="bars" />
          </Center>
        ) : !!data?.length ? (
          <Stack className="relative" gap="xl">
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
            ))}
            {showMore && (
              <Center>
                <Button
                  onClick={toggleShowMore}
                  loading={isFetchingNextPage}
                  variant="subtle"
                  size="md"
                >
                  Load More Comments
                </Button>
              </Center>
            )}
          </Stack>
        ) : (
          <Text>No hidden comments</Text>
        )
      }
    </RootThreadProvider>
  );
}
