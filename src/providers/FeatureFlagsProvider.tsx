import produce from 'immer';
import { createContext, useContext, useMemo, useState } from 'react';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { toggleableFeatures } from '~/server/services/feature-flags.service';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const FeatureFlagsCtx = createContext<FeatureAccess>({} as FeatureAccess);

export const useFeatureFlags = () => {
  const features = useContext(FeatureFlagsCtx);

  const queryUtils = trpc.useUtils();
  const { data: userFeatures = {} as FeatureAccess } = trpc.user.getFeatureFlags.useQuery(
    undefined,
    { cacheTime: Infinity, staleTime: Infinity }
  );
  const toggleFeatureFlagMutation = trpc.user.toggleFeature.useMutation({
    async onMutate(payload) {
      await queryUtils.user.getFeatureFlags.cancel();
      const prevData = queryUtils.user.getFeatureFlags.getData();

      queryUtils.user.getFeatureFlags.setData(
        undefined,
        produce((old) => {
          if (!old) return;
          old[payload.feature] = !old[payload.feature];
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
  const handleToggle = (key: keyof FeatureAccess) => {
    toggleFeatureFlagMutation.mutate({ feature: key });
  };

  const featuresWithToggled = useMemo(() => {
    return Object.keys(features).reduce((acc, key) => {
      const featureAccessKey = key as keyof FeatureAccess;
      const hasFeature = features[featureAccessKey];
      const toggleableFeature = toggleableFeatures.find(
        (toggleableFeature) => toggleableFeature.key === key
      );

      // Non toggleable features will rely on our standard feature flag settings:
      if (!toggleableFeature) {
        return {
          ...acc,
          [key]: hasFeature,
        };
      }

      const isToggled = userFeatures
        ? userFeatures[featureAccessKey] ?? toggleableFeature.default
        : toggleableFeature.default;
      return { ...acc, [key]: hasFeature && isToggled } as FeatureAccess;
    }, {} as FeatureAccess);
  }, [features, userFeatures]);

  if (!features) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');

  return {
    ...featuresWithToggled,
    toggles: {
      available: toggleableFeatures,
      values: userFeatures,
      set: handleToggle,
    },
  };
};
export const FeatureFlagsProvider = ({
  children,
  flags: initialFlags,
}: {
  children: React.ReactNode;
  flags: FeatureAccess;
}) => {
  const [flags] = useState(initialFlags);
  return <FeatureFlagsCtx.Provider value={flags}>{children}</FeatureFlagsCtx.Provider>;
};
