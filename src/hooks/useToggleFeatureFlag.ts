import produce from 'immer';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Flips one per-user toggleable feature flag, patching the `user.getFeatureFlags` cache first so
 *  every switch bound to `useFeatureFlags()` moves together and rolling back if the write fails. */
export function useToggleFeatureFlag() {
  const queryUtils = trpc.useUtils();
  const { mutate } = trpc.user.toggleFeature.useMutation({
    async onMutate(payload) {
      await queryUtils.user.getFeatureFlags.cancel();
      const prevData = queryUtils.user.getFeatureFlags.getData();

      queryUtils.user.getFeatureFlags.setData(
        undefined,
        produce((old) => {
          if (!old) return;
          old[payload.feature] = payload.value ?? !old[payload.feature];
        })
      );

      return { prevData };
    },
    async onSuccess() {
      await queryUtils.user.getFeatureFlags.invalidate();
    },
    onError(_error, _payload, context) {
      showErrorNotification({
        title: 'Failed to toggle feature',
        error: new Error('Something went wrong, please try again later.'),
      });
      queryUtils.user.getFeatureFlags.setData(undefined, context?.prevData);
    },
  });

  return (key: keyof FeatureAccess, value: boolean) => mutate({ feature: key, value });
}
