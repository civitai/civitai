import { Switch } from '@mantine/core';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useJoin, useTurfGate } from '~/components/HatTurf/useHatTurf';

export const HAT_TURF_SETTING_LABEL = 'Take part in Hat Turf';
const HAT_TURF_SETTING_DESCRIPTION =
  "Place your team's hats on images and see everyone's. Hats you placed keep counting if you turn this off.";
export const SHOW_HATS_SETTING_LABEL = 'Show hats';
const SHOW_HATS_SETTING_DESCRIPTION =
  "The hats placed on images, everyone's and yours. Off hides them on this device; the standings and the hat button stay, and placing a hat shows them again while you place.";

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
      {/* A viewer with Hat Turf on feeds only has no image page switch, so it is here too. */}
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
