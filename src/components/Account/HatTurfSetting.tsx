import { Switch } from '@mantine/core';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';
import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useJoin } from '~/components/HatTurf/useHatTurf';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export const HAT_TURF_SETTING_LABEL = 'Take part in Hat Turf';
const HAT_TURF_SETTING_DESCRIPTION =
  "Place your team's hats on images and see everyone's. Hats you placed keep counting if you turn this off.";

/** In account settings, while Hat Turf runs on any surface this viewer can see. */
export function HatTurfSetting() {
  const user = useCurrentUser();
  const features = useFeatureFlags();
  const definition = usePlayableEventDecoration(
    'Image',
    !!user && (!!features.hatTurfImageDetail || !!features.hatTurfFeedCard)
  );
  const event = definition?.event;
  const { data: stock } = trpc.hatTurf.getStock.useQuery(
    { event: event ?? '' },
    { enabled: !!event, staleTime: 30_000 }
  );
  const setOptIn = useJoin();
  if (!event || !stock || stock.mode === 'off') return null;

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
