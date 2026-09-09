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

/**
 * Same query, but able to say "not resolved yet".
 *
 * `useCurrentUserSettings` defaults to `{}` while loading, which is non-null — enough to convince
 * `useSeededState` it has already seeded, so it never re-seeds when the real settings land. Any
 * editor that reads settings, holds them as local state and writes the whole object back must use
 * this instead, or it will save its defaults over the user's saved values on the degraded SSR
 * bootstrap path where the seed is genuinely absent at mount.
 */
export function useCurrentUserSettingsState() {
  const currentUser = useCurrentUser();
  const { data, isSuccess } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });
  // Signed out: nothing to wait for. Signed in: SSR seeds `initialData`, so this is normally true
  // on the first render.
  return { settings: data, isResolved: !currentUser || isSuccess };
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
