import { ActionIcon, Tooltip } from '@mantine/core';
import { ModelEngagementType } from '@prisma/client';
import { IconBellCheck, IconBellPlus } from '@tabler/icons-react';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function ToggleModelNotification({ modelId, userId }: { modelId: number; userId: number }) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const {
    data: { Notify: watchedModels = [], Mute: mutedModels = [] } = { Notify: [], Mute: [] },
  } = trpc.user.getEngagedModels.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const { data: following = [] } = trpc.user.getFollowingUsers.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });

  const toggleNotifyModelMutation = trpc.user.toggleNotifyModel.useMutation({
    async onMutate({ modelId }) {
      await queryUtils.user.getEngagedModels.cancel();

      const previousEngaged = queryUtils.user.getEngagedModels.getData() ?? {
        Notify: [],
        Hide: [],
        Mute: [],
        Recommended: [],
      };
      const previousModel = queryUtils.model.getById.getData({ id: modelId });
      const shouldRemove = previousEngaged.Notify?.find((id) => id === modelId);
      // Update the favorite count
      queryUtils.model.getById.setData({ id: modelId }, (model) => {
        // TODO.review: set correct value
        if (model?.rank) model.rank.favoriteCountAllTime += shouldRemove ? -1 : 1;
        return model;
      });
      // Remove from favorites list
      queryUtils.user.getEngagedModels.setData(
        undefined,
        ({ Notify = [], ...old } = { Notify: [], Hide: [], Mute: [], Recommended: [] }) => {
          if (shouldRemove) return { Notify: Notify.filter((id) => id !== modelId), ...old };
          return { Notify: [...Notify, modelId], ...old };
        }
      );

      return { previousEngaged, previousModel };
    },
    async onSuccess() {
      await queryUtils.model.getAll.invalidate({ favorites: true });
    },
    onError(_error, _variables, context) {
      queryUtils.user.getEngagedModels.setData(undefined, context?.previousEngaged);
      if (context?.previousModel?.id)
        queryUtils.model.getById.setData(
          { id: context?.previousModel?.id },
          context?.previousModel
        );
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
            size="xl"
            variant="light"
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
