import { Button, Group, Radio, Stack, Textarea, Modal } from '@mantine/core';
import React, { useState } from 'react';

import type { UnpublishReason } from '~/server/common/moderation-helpers';
import { unpublishReasons } from '~/server/common/moderation-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

const reasonOptions = Object.entries(unpublishReasons).map(([key, { optionLabel }]) => ({
  value: key,
  label: optionLabel,
}));

export default function UnpublishModal({
  modelId,
  versionId,
}: {
  modelId: number;
  versionId?: number;
}) {
  const dialog = useDialogContext();

  const queryUtils = trpc.useContext();
  const [reason, setReason] = useState<UnpublishReason | undefined>();
  const [customMessage, setCustomMessage] = useState<string>('');
  const [error, setError] = useState<string>('');

  const unpublishModelMutation = trpc.model.unpublish.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getById.invalidate({ id: modelId });
      await queryUtils.model.getAll.invalidate();
      dialog.onClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to unpublish',
        error: new Error(error.message),
        reason: 'An unexpected error occurred. Please try again later.',
      });
    },
  });
  const unpublishVersionMutation = trpc.modelVersion.unpublish.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getById.invalidate({ id: modelId });
      dialog.onClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to unpublish',
        error: new Error(error.message),
        reason: 'An unexpected error occurred. Please try again later.',
      });
    },
  });
  const handleUnpublish = () => {
    setError('');

    if (reason === 'other') {
      if (!customMessage) return setError('Required');
    }

    return versionId
      ? unpublishVersionMutation.mutate({ id: versionId, reason, customMessage })
      : unpublishModelMutation.mutate({ id: modelId, reason, customMessage });
  };

  const loading = unpublishModelMutation.isLoading || unpublishVersionMutation.isLoading;

  return (
    <Modal {...dialog} title="Unpublish as Violation">
      <Stack>
        <Radio.Group value={reason} onChange={(value) => setReason(value as UnpublishReason)}>
          <Stack>
            {reasonOptions.map((reason) => (
              <Radio key={reason.value} value={reason.value} label={reason.label} />
            ))}
          </Stack>
        </Radio.Group>
        {reason && (
          <>
            <Textarea
              name="customMessage"
              label="Reason"
              placeholder="Why is this being unpublished?"
              rows={2}
              value={customMessage}
              onChange={(event) => setCustomMessage(event.currentTarget.value)}
              error={error}
              withAsterisk={reason === 'other'}
            />
            <Group justify="flex-end">
              <Button onClick={handleUnpublish} loading={loading}>
                Unpublish
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
