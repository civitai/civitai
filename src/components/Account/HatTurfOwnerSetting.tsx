import { Switch } from '@mantine/core';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';
import {
  HAT_TURF_OWNER_LABEL,
  useHatTurfOwnerSwitch,
} from '~/components/HatTurf/HatTurfOwnerToggle';

/** The owner's Hat Turf switch, as a row in the account settings' Creator pane. */
export function HatTurfOwnerSetting() {
  const owner = useHatTurfOwnerSwitch();
  if (!owner) return null;
  return (
    <SettingsSection title="Hat Turf on my images" id="hat-turf-owner">
      <SettingRow
        label={HAT_TURF_OWNER_LABEL}
        description={owner.description}
        control={<Switch aria-label={HAT_TURF_OWNER_LABEL} {...owner.switchProps} />}
      />
    </SettingsSection>
  );
}
