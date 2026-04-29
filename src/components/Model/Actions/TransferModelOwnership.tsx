import { Alert, Button, Group, Modal, NumberInput, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { CreatorCardV2 } from '~/components/CreatorCard/CreatorCard';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function TransferModelOwnership({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();

  const [targetUserId, setTargetUserId] = useState<number | undefined>();

  const validUserId = !!targetUserId && targetUserId > 0;

  const { data: targetUser, isFetching: targetLoading } = trpc.user.getCreator.useQuery(
    { id: targetUserId! },
    { enabled: validUserId }
  );

  const transferMutation = trpc.moderator.models.transferOwnership.useMutation({
    onSuccess: async (data) => {
      showSuccessNotification({
        title: 'Model transferred',
        message: `Updated ${data.modelsUpdated} model(s), ${data.postsUpdated} post(s), ${data.imagesUpdated} image(s).`,
      });
      await queryUtils.model.getById.invalidate({ id: modelId });
      dialog.onClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to transfer model',
        error: new Error(error.message),
      });
    },
  });

  const handleTransfer = () => {
    if (!validUserId) return;
    transferMutation.mutate({ modelIds: [modelId], targetUserId: targetUserId! });
  };

  return (
    <Modal
      {...dialog}
      title="Transfer Model Ownership"
      closeOnClickOutside={!transferMutation.isLoading}
      closeOnEscape={!transferMutation.isLoading}
      withCloseButton={!transferMutation.isLoading}
      withinPortal
    >
      <Stack gap="md">
        <Text size="sm">
          Transfer this model and all of its versions, posts, and images to another user. Comments
          and reviews stay attached to their original authors.
        </Text>

        <NumberInput
          label="Target User ID"
          placeholder="Enter the recipient's user ID"
          min={1}
          value={targetUserId ?? ''}
          onChange={(val) => setTargetUserId(typeof val === 'number' ? val : undefined)}
          disabled={transferMutation.isLoading}
        />

        {validUserId && targetLoading && (
          <Text size="xs" c="dimmed">
            Looking up user...
          </Text>
        )}

        {validUserId && !targetLoading && !targetUser && (
          <Alert color="red" icon={<IconAlertCircle />}>
            No user found with ID {targetUserId}.
          </Alert>
        )}

        {targetUser && <CreatorCardV2 user={targetUser} withActions={false} tipsEnabled={false} />}

        <Alert color="yellow" icon={<IconAlertCircle />}>
          This action is silent - neither user is notified. The transfer is logged for audit.
        </Alert>

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose} disabled={transferMutation.isLoading}>
            Cancel
          </Button>
          <Button
            color="orange"
            loading={transferMutation.isLoading}
            disabled={!targetUser}
            onClick={handleTransfer}
          >
            Transfer
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
