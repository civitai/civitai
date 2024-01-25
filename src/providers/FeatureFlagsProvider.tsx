import { useLocalStorage } from '@mantine/hooks';
import produce from 'immer';
import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo, useState } from 'react';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { toggleableFeatures } from '~/server/services/feature-flags.service';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const FeatureFlagsCtx = createContext<FeatureAccess>({} as FeatureAccess);

export const useFeatureFlags = () => {
  const features = useContext(FeatureFlagsCtx);
  const [toggled, setToggled] = useLocalStorage<Partial<FeatureAccess>>({
    key: 'toggled-features',
    defaultValue: toggleableFeatures.reduce(
      (acc, feature) => ({ ...acc, [feature.key]: feature.default }),
      {} as Partial<FeatureAccess>
    ),
  });

  const session = useSession(); // Using useSession here cause of Provider order
  const queryUtils = trpc.useUtils();
  const { data: userFeatures = {} as FeatureAccess } = trpc.user.getFeatureFlags.useQuery(
    undefined,
    { cacheTime: Infinity, staleTime: Infinity, retry: 0, enabled: !!session.data }
  );
  const toggleFeatureFlagMutation = trpc.user.toggleFeature.useMutation({
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

  const handleToggle = (key: keyof FeatureAccess, value: boolean) => {
    setToggled((prev) => ({ ...prev, [key]: value }));
    toggleFeatureFlagMutation.mutate({ feature: key, value });
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
        ? userFeatures[featureAccessKey] ?? toggled[featureAccessKey] ?? toggleableFeature.default
        : toggleableFeature.default;
      return { ...acc, [key]: hasFeature && isToggled } as FeatureAccess;
    }, {} as FeatureAccess);
  }, [features, toggled, userFeatures]);

  if (!features) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');

  return {
    ...featuresWithToggled,
    toggles: {
      available: toggleableFeatures,
      values: { ...toggled, ...userFeatures },
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
