import { Center, Divider, Group, Loader, LoadingOverlay, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import React from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

import { ModelDiscussionV2 } from '~/components/Model/ModelDiscussion/ModelDiscussionV2';

type CommentEntityType =
  | 'model'
  | 'post'
  | 'article'
  | 'bounty'
  | 'bountyEntry'
  | 'comment'
  | 'image';

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
          <ModelDiscussionV2 modelId={entityId} onlyHidden />
        ) : (
          <HiddenCommentsContent entityType={entityType} entityId={entityId} userId={userId} />
        )}
      </Stack>
    </Modal>
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
      {({ data, isLoading, isFetching, remaining, showMore, toggleShowMore }) =>
        isLoading ? (
          <Center mt="xl">
            <Loader type="bars" />
          </Center>
        ) : !!data?.length ? (
          <Stack className="relative" gap="xl">
            <LoadingOverlay visible={isFetching} />
            {data?.map((comment) => (
              <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
            ))}
            {!!remaining && !showMore && (
              <Divider
                label={
                  <Group gap="xs" align="center">
                    <Text c="blue.4" style={{ cursor: 'pointer' }} onClick={toggleShowMore} inherit>
                      Show {remaining} More
                    </Text>
                  </Group>
                }
                labelPosition="center"
                variant="dashed"
              />
            )}
          </Stack>
        ) : (
          <Text>No hidden comments</Text>
        )
      }
    </RootThreadProvider>
  );
}
