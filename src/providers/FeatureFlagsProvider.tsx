import { createContext, useContext, useEffect, useMemo, useState } from 'react';
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

  useEffect(() => {
    const toToggle: Partial<FeatureAccess> = {};
    for (const feature of toggleable) {
      if (
        toggled[feature.key as keyof FeatureAccess] === undefined &&
        feature.default !== undefined
      )
        toToggle[feature.key] = feature.default;
    }
    if (Object.keys(toToggle).length > 0) setToggled((prev) => ({ ...prev, ...toToggle }));
  }, [toggleable, toggled, setToggled]);

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

      const isToggled = toggled[featureAccessKey] ?? toggleableFeature.default;
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
