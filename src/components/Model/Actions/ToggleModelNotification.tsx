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
              // Carry an EXPLICIT direction (setTo) derived from the button intent,
              // never a blind server-side toggle. isOn=true → the user wants OFF
              // (set Mute, which also overrides a follow-based auto-watch); isOn=false
              // → the user wants ON (set Notify). With setTo the server sets the row
              // to exactly this state, so even if the store fabricated "off" for a
              // genuinely-ON model (the #3034 error-path un-stick), a click can no
              // longer silently DELETE the existing Notify — it's an idempotent
              // subscribe. The optimistic write below is therefore the guaranteed
              // outcome, not a guess, so the store never ends up lying vs the server.
              toggleNotifyModelMutation.mutate({
                modelId,
                type: isOn ? ModelEngagementType.Mute : ModelEngagementType.Notify,
                setTo: true,
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
