import type { ActionIconProps } from '@mantine/core';
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconBellCheck, IconBellPlus } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useEngagedModelMembership } from '~/hooks/useEngagedModelMembership';
import { applyNotifyToggled } from '~/store/engaged-models.optimistic';
import { restoreMembership, snapshotMembership } from '~/store/engaged-models.store';
import { ModelEngagementType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ToggleModelNotification({
  modelId,
  userId,
  ...actionIconProps
}: ActionIconProps & { modelId: number; userId: number }) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  // PR2: per-visible-set membership for this single model (Notify/Mute).
  const { isEngaged: isModelEngaged, isKnown } = useEngagedModelMembership(modelId);
  const { data: following = [] } = trpc.user.getFollowingUsers.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const isWatching = isModelEngaged('Notify');
  const isMuted = isModelEngaged('Mute');
  const alreadyFollowing = following.includes(userId);
  const isOn = (alreadyFollowing || isWatching) && !isMuted;

  const toggleNotifyModelMutation = trpc.user.toggleNotifyModel.useMutation({
    onMutate() {
      // Optimistic store update + snapshot for rollback.
      const snapshot = snapshotMembership(modelId);
      applyNotifyToggled(modelId, !isOn);
      return { snapshot };
    },
    async onSuccess() {
      // Keep the legacy getEngagedModels cache in sync for still-on-old-endpoint feeds.
      await queryUtils.user.getEngagedModels.invalidate();
    },
    onError(error, _vars, context) {
      if (context?.snapshot) restoreMembership(modelId, context.snapshot);
      showErrorNotification({
        title: 'Failed to update notification settings',
        error,
      });
    },
  });

  return (
    <Tooltip
      label={
        isOn
          ? 'Stop getting notifications for this model'
          : 'Get a notification when there is a new update on this model'
      }
    >
      {/* Need div to keep ref with tooltip */}
      <div>
        <LoginRedirect reason="notify-model">
          <LegacyActionIcon
            variant="light"
            {...actionIconProps}
            color={isOn ? 'success' : undefined}
            onClick={() => {
              // F1: block the toggle until membership is known — a cold store reads
              // as not-engaged and would fire the OPPOSITE of the user's intent.
              if (!isKnown) return;
              toggleNotifyModelMutation.mutate({
                modelId,
                type: isOn ? ModelEngagementType.Mute : undefined,
              });
            }}
            loading={toggleNotifyModelMutation.isPending || !isKnown}
          >
            {isOn ? <IconBellCheck size={20} /> : <IconBellPlus size={20} />}
          </LegacyActionIcon>
        </LoginRedirect>
      </div>
    </Tooltip>
  );
}
