import { Switch } from '@mantine/core';
import { useToggleFeatureFlag } from '~/hooks/useToggleFeatureFlag';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/** The same `civitaiLinkNav` setting as Preferences > Features, from inside the Link dialog. */
export function CivitaiLinkNavSwitch() {
  const features = useFeatureFlags();
  const toggleFlag = useToggleFeatureFlag();

  return (
    <Switch
      p="xs"
      size="xs"
      label="Show Civitai Link in the navigation bar"
      checked={!!features.civitaiLinkNav}
      onChange={(e) => toggleFlag('civitaiLinkNav', e.target.checked)}
    />
  );
}
