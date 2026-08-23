import { Button, Checkbox, Group, Radio, Stack, Textarea, Modal } from '@mantine/core';
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

/**
 * Unpublish reasons that are also a statement about what the model IS, not just why it came down.
 *
 * Taking it down and flagging it were two separate trips through two different screens, and the
 * second one is the half that gets forgotten — an unflagged model keeps its rating, keeps generating,
 * and comes back the moment someone republishes it.
 *
 * `mature-real-person` is deliberately absent. It is the poi case, and unlike `minor` there is no
 * guarded server path to set `Model.poi` — no cascade to images, no locked properties, no snapshot,
 * no mod endpoint. Adding a bare `poi: true` write here would invent a moderation flag's semantics in
 * a modal. See docs/moderator-app/post-migration-backlog.md.
 */
const MINOR_REASONS = new Set<UnpublishReason>(['mature-underage', 'photo-real-underage']);

export default function UnpublishModal({
  modelId,
  versionId,
}: {
  modelId: number;
  versionId?: number;
}) {
  const dialog = useDialogContext();

  const queryUtils = trpc.useUtils();
  const [reason, setReason] = useState<UnpublishReason | undefined>();
  const [customMessage, setCustomMessage] = useState<string>('');
  const [error, setError] = useState<string>('');
  // Defaults ON: if the reason says the model depicts a minor, flagging it is the expected outcome and
  // opting out is the deliberate act.
  const [alsoFlagMinor, setAlsoFlagMinor] = useState(true);
  // Model-level unpublishes only. `setMinor` flags the whole MODEL, so offering it while taking down
  // one version would quietly act on every other version too — wider than the button says.
  const offerMinorFlag = !versionId && !!reason && MINOR_REASONS.has(reason);

  const setMinorMutation = trpc.model.setMinor.useMutation();

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
  const handleUnpublish = async () => {
    setError('');

    if (reason === 'other') {
      if (!customMessage) return setError('Required');
    }

    // BEFORE the unpublish. `setModelMinor` takes a snapshot of the model's pre-flag state and
    // propagates `minor` to its images; running it after the take-down would snapshot a model that is
    // already down. A failure here also stops the unpublish, which is the safer order — an unpublished
    // model nobody flagged is the outcome this whole toggle exists to prevent.
    if (offerMinorFlag && alsoFlagMinor) {
      try {
        await setMinorMutation.mutateAsync({ id: modelId, minor: true });
      } catch (e) {
        return showErrorNotification({
          title: 'Not unpublished — the model was not flagged',
          error:
            e instanceof Error ? e : new Error('Could not flag this model as depicting a minor'),
          reason: 'Nothing was changed. Untick the flag to unpublish without it.',
        });
      }
    }

    return versionId
      ? unpublishVersionMutation.mutate({ id: versionId, reason, customMessage })
      : unpublishModelMutation.mutate({ id: modelId, reason, customMessage });
  };

  const loading =
    unpublishModelMutation.isPending ||
    unpublishVersionMutation.isPending ||
    setMinorMutation.isPending;

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
            {offerMinorFlag && (
              <Checkbox
                checked={alsoFlagMinor}
                onChange={(event) => setAlsoFlagMinor(event.currentTarget.checked)}
                label="Also mark this model as depicting a minor"
                description="Locks its rating to SFW, propagates the flag to its images, and keeps it flagged if it is ever republished."
              />
            )}
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
