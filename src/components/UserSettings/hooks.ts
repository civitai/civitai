import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';

export function useCurrentUserSettings() {
  const currentUser = useCurrentUser();
  const { data = {} } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });
  return data;
}

export function useMutateUserSettings({
  onSuccess,
  onError,
}: Parameters<typeof trpc.user.setSettings.useMutation>[0] = {}) {
  const queryUtils = trpc.useUtils();
  return trpc.user.setSettings.useMutation({
    async onMutate(data) {
      const previousData = queryUtils.user.getSettings.getData();
      queryUtils.user.getSettings.setData(undefined, (old) => ({ ...old, ...data }));
      return { previousData };
    },
    onSuccess,
    // v5.101: mutation callbacks are (error, variables, onMutateResult, context).
    async onError(error, data, onMutateResult, mutationContext) {
      queryUtils.user.getSettings.setData(undefined, onMutateResult?.previousData);
      if (!onError) {
        showErrorNotification({
          title: 'Failed to update user settings',
          error: new Error(error.message),
        });
      } else await onError?.(error, data, onMutateResult, mutationContext);
    },
  });
}
