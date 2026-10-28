import { Button, Checkbox, Group, Loader, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { requestableLockLabels, type RequestableLock } from '@civitai/shared/lock-review';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { MAX_APPEAL_MESSAGE_LENGTH } from '~/server/common/constants';
import { EntityType } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const MIN_REASON_LENGTH = 10;

export function LockReviewDialog({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.report.getLockReviewState.useQuery({ id: modelId });
  const requestable = data?.requestable ?? [];
  const [picked, setPicked] = useState<RequestableLock[]>([]);
  const [message, setMessage] = useState('');
  const locks = requestable.length === 1 ? requestable : picked;

  const createAppeal = trpc.report.createAppeal.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Review requested',
        message: 'A moderator will look at it; the current settings stay in place until then.',
      });
      dialog.onClose();
      await queryUtils.report.getLockReviewState.invalidate({ id: modelId });
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to request a review',
        error: new Error(error.message),
      });
    },
  });

  const canSubmit = locks.length > 0 && message.trim().length >= MIN_REASON_LENGTH;

  return (
    <Modal {...dialog} title="Request a review" size="lg" centered>
      <Stack gap="md">
        <Text size="sm">
          A moderator has locked some of this model&apos;s settings, so you can&apos;t change them
          yourself. If you think one is wrong, tell us which and why, and a moderator will take
          another look.
        </Text>
        {isLoading ? (
          <Loader size="sm" />
        ) : (
          <Checkbox.Group
            label="Which setting?"
            withAsterisk
            value={locks}
            onChange={(value) => setPicked(value as RequestableLock[])}
          >
            <Stack pt="xs" gap="sm">
              {requestable.map((key) => (
                <Checkbox key={key} value={key} label={requestableLockLabels[key]} />
              ))}
            </Stack>
          </Checkbox.Group>
        )}
        <Textarea
          label="Why should it change?"
          placeholder="Tell us what the moderator should know."
          withAsterisk
          autosize
          minRows={3}
          maxLength={MAX_APPEAL_MESSAGE_LENGTH}
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            loading={createAppeal.isPending}
            onClick={() =>
              createAppeal.mutate({
                entityType: EntityType.Model,
                entityId: modelId,
                message: message.trim(),
                locks,
              })
            }
          >
            Send request
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
