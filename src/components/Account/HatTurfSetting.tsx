import { Switch } from '@mantine/core';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';
import { useJoin, useTurfGate } from '~/components/HatTurf/useHatTurf';

export const HAT_TURF_SETTING_LABEL = 'Take part in Hat Turf';
const HAT_TURF_SETTING_DESCRIPTION =
  "Place your team's hats on images and see everyone's. Hats you placed keep counting if you turn this off.";

/** In account settings, while Hat Turf runs on any surface this viewer can see. */
export function HatTurfSetting() {
  const { event, stock } = useTurfGate();
  const setOptIn = useJoin();
  if (!event || !stock) return null;

  return (
    <SettingsSection title="Hat Turf" id="hat-turf">
      <SettingRow
        label={HAT_TURF_SETTING_LABEL}
        description={HAT_TURF_SETTING_DESCRIPTION}
        control={
          <Switch
            name="hatTurfOptIn"
            aria-label={HAT_TURF_SETTING_LABEL}
            checked={stock.optedIn}
            disabled={setOptIn.isPending}
            onChange={(e) => setOptIn.mutate({ event, optedIn: e.currentTarget.checked })}
            data-testid="hat-turf-setting-toggle"
          />
        }
      />
    </SettingsSection>
  );
}
