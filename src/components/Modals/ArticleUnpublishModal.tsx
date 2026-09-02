import { Button, Group, Radio, Stack, Textarea, Modal } from '@mantine/core';
import React, { useState } from 'react';

import type { ArticleUnpublishReason } from '~/server/common/moderation-helpers';
import { articleUnpublishReasons } from '~/server/common/moderation-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

const reasonOptions = Object.entries(articleUnpublishReasons).map(([key, { optionLabel }]) => ({
  value: key,
  label: optionLabel,
}));

export default function ArticleUnpublishModal({ articleId }: { articleId: number }) {
  const dialog = useDialogContext();

  const queryUtils = trpc.useUtils();
  const [reason, setReason] = useState<ArticleUnpublishReason | undefined>();
  const [customMessage, setCustomMessage] = useState<string>('');
  const [error, setError] = useState<string>('');

  const unpublishArticleMutation = trpc.article.unpublish.useMutation({
    onSuccess: async () => {
      await queryUtils.article.getById.invalidate({ id: articleId });
      await queryUtils.article.getInfinite.invalidate();
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

    return unpublishArticleMutation.mutate({ id: articleId, reason, customMessage });
  };

  const loading = unpublishArticleMutation.isPending;

  return (
    <Modal {...dialog} title="Unpublish Article">
      <Stack>
        <Radio.Group
          value={reason}
          onChange={(value) => setReason(value as ArticleUnpublishReason)}
        >
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
              label={reason === 'other' ? 'Reason (shown to the author)' : 'Reason (internal)'}
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
