import { ActionIcon, ActionIconProps, Tooltip } from '@mantine/core';
import { ModelEngagementType } from '@prisma/client';
import { IconBellCheck, IconBellPlus } from '@tabler/icons-react';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ToggleModelNotification({
  modelId,
  userId,
  ...actionIconProps
}: ActionIconProps & { modelId: number; userId: number }) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const {
    data: { Notify: watchedModels = [], Mute: mutedModels = [] } = { Notify: [], Mute: [] },
  } = trpc.user.getEngagedModels.useQuery(undefined, { enabled: !!currentUser });
  const { data: following = [] } = trpc.user.getFollowingUsers.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const toggleNotifyModelMutation = trpc.user.toggleNotifyModel.useMutation({
    async onSuccess() {
      await queryUtils.user.getEngagedModels.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update notification settings',
        error,
      });
    },
  });

  const isWatching = watchedModels.includes(modelId);
  const isMuted = mutedModels.includes(modelId);
  const alreadyFollowing = following.some((user) => userId == user.id);
  const isOn = (alreadyFollowing || isWatching) && !isMuted;

  return (
    <Tooltip
      label={
        isOn
          ? 'Stop getting notifications for this model'
          : 'Get notification when there is a new update on this model'
      }
    >
      {/* Need div to keep ref with tooltip */}
      <div>
        <LoginRedirect reason="notify-model">
          <ActionIcon
            variant="light"
            {...actionIconProps}
            color={isOn ? 'success' : undefined}
            onClick={() =>
              toggleNotifyModelMutation.mutate({
                modelId,
                type: isOn ? ModelEngagementType.Mute : undefined,
              })
            }
            loading={toggleNotifyModelMutation.isLoading}
          >
            {isOn ? <IconBellCheck size={20} /> : <IconBellPlus size={20} />}
          </ActionIcon>
        </LoginRedirect>
      </div>
    </Tooltip>
  );
}
