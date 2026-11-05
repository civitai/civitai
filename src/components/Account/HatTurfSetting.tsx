import { Switch } from '@mantine/core';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useJoin, useTurfGate } from '~/components/HatTurf/useHatTurf';

export const HAT_TURF_SETTING_LABEL = 'Take part in Hat Turf';
const HAT_TURF_SETTING_DESCRIPTION =
  "Place your team's hats on images and see everyone's. Hats you placed keep counting if you turn this off.";
export const SHOW_HATS_SETTING_LABEL = 'Show hats';
const SHOW_HATS_SETTING_DESCRIPTION =
  'Hats, team standings and the hat button on images. Off, images show none of Hat Turf, on this device.';

/** In account settings, while Hat Turf runs on any surface this viewer can see. */
export function HatTurfSetting() {
  const { event, stock } = useTurfGate();
  const setOptIn = useJoin();
  const showHats = useHatTurfStore((state) => state.showHats);
  const setShowHats = useHatTurfStore((state) => state.setShowHats);
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
      {/* With hats off, cards drop the gear too, and the image page may not run Hat Turf. */}
      <SettingRow
        label={SHOW_HATS_SETTING_LABEL}
        description={SHOW_HATS_SETTING_DESCRIPTION}
        control={
          <Switch
            name="hatTurfShowHats"
            aria-label={SHOW_HATS_SETTING_LABEL}
            checked={showHats}
            onChange={(e) => setShowHats(e.currentTarget.checked)}
            data-testid="hat-turf-show-hats-setting"
          />
        }
      />
    </SettingsSection>
  );
}
