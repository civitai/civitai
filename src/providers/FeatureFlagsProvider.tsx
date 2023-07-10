import { createContext, useContext, useMemo, useState } from 'react';
import { toggleableFeatures } from '~/server/services/feature-flags.service';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { useLocalStorage } from '@mantine/hooks';

const FeatureFlagsCtx = createContext<FeatureAccess>({} as FeatureAccess);

export const useFeatureFlags = () => {
  const features = useContext(FeatureFlagsCtx);
  const toggleable = useMemo(
    () => toggleableFeatures.filter((x) => features[x.key as keyof FeatureAccess]),
    [features]
  );
  const [toggled, setToggled] = useLocalStorage<Partial<FeatureAccess>>({
    key: 'toggled-features',
    defaultValue: toggleable.reduce(
      (acc, feature) => ({ ...acc, [feature.key]: feature.default }),
      {}
    ),
  });

  const featuresWithToggled = useMemo(() => {
    return Object.keys(features).reduce((acc, key) => {
      const featureAccessKey = key as keyof FeatureAccess;
      const hasFeature = features[featureAccessKey];
      const featureIsToggleable = toggleableFeatures.find(
        (toggleableFeature) => toggleableFeature.key === key
      );

      // Non toggleable features will rely on our standard feature flag settings:
      if (!featureIsToggleable) {
        return {
          ...acc,
          [key]: hasFeature,
        };
      }

      const isToggled = toggled[featureAccessKey];
      return { ...acc, [key]: hasFeature && isToggled } as FeatureAccess;
    }, {} as FeatureAccess);
  }, [features, toggled]);

  if (!features) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');

  const setToggle = (key: keyof FeatureAccess, value: boolean) => {
    setToggled((prev) => ({ ...prev, [key]: value }));
  };

  return {
    ...featuresWithToggled,
    toggles: {
      available: toggleable,
      values: toggled,
      set: setToggle,
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
