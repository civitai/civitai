import { Switch } from '@mantine/core';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';

const LABEL = 'Let creators feature my images in their model showcases';
const DESCRIPTION =
  'A creator can feature an image you made with their model. You are credited and notified, and you can remove it from any showcase at any time.';

/**
 * The author's consent for version showcases (on by default). Shown whatever the feature flag says:
 * featuring is per-creator, so an author must be able to opt out before any creator can feature
 * their work.
 */
export function VersionShowcaseOptOutSetting({ flat }: { flat?: boolean }) {
  const { hideFromVersionShowcases } = useCurrentUserSettings();
  const { mutate, isPending } = useMutateUserSettings();
  const control = (
    <Switch
      name="allowVersionShowcaseFeatures"
      aria-label={flat ? LABEL : undefined}
      label={flat ? undefined : LABEL}
      description={flat ? undefined : DESCRIPTION}
      checked={!(hideFromVersionShowcases ?? false)}
      disabled={isPending}
      onChange={(e) => mutate({ hideFromVersionShowcases: !e.target.checked })}
      styles={flat ? undefined : { track: { flex: '0 0 1em' } }}
    />
  );
  if (!flat) return control;
  return (
    <SettingsSection title="Model showcases">
      <SettingRow label={LABEL} description={DESCRIPTION} control={control} />
    </SettingsSection>
  );
}
