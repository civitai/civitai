import { Switch } from '@mantine/core';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isShowcaseLive, SHOWCASE_EVENT } from '~/shared/constants/showcase-hat.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const SHOWCASE_HAT_TOGGLE_LABEL = 'Show my event hat on my avatar';
const SHOWCASE_HAT_TOGGLE_DESCRIPTION =
  'Turn this off to take the event hat off your avatar. You keep your hats and can turn it back on any time.';

/**
 * The on/off switch for the showcase hat, one state shared by every place that draws it. `shown`
 * is undefined until the setting loads.
 */
export function useShowcaseHatToggle() {
  const event = SHOWCASE_EVENT.name;
  const utils = trpc.useUtils();
  const { data } = trpc.event.getMyShowcaseHat.useQuery({ event });
  const { mutate, isPending } = trpc.event.setShowcaseHat.useMutation({
    onSuccess: async (result) => {
      utils.event.getMyShowcaseHat.setData({ event }, result);
      await Promise.all([
        utils.user.getCreator.invalidate(),
        utils.userProfile.get.invalidate(),
        utils.event.getTeamRoster.invalidate(),
        utils.event.getMyShowcaseHatArt.invalidate({ event }),
      ]);
    },
    onError: (error) => showErrorNotification({ title: 'Could not save', error }),
  });
  return {
    shown: data ? !data.off : undefined,
    setShown: (shown: boolean) => mutate({ event, off: !shown }),
    isPending,
  };
}

function ShowcaseHatSwitch({ hideLabel }: { hideLabel?: boolean }) {
  const { shown, setShown, isPending } = useShowcaseHatToggle();
  return (
    <Switch
      name="showcaseHat"
      aria-label={hideLabel ? SHOWCASE_HAT_TOGGLE_LABEL : undefined}
      label={hideLabel ? undefined : SHOWCASE_HAT_TOGGLE_LABEL}
      checked={shown ?? false}
      disabled={shown === undefined || isPending}
      onChange={(e) => setShown(e.target.checked)}
      data-testid="showcase-hat-toggle"
    />
  );
}

/** Inside the hat picker. */
export function ShowcaseHatPickerToggle() {
  return <ShowcaseHatSwitch />;
}

/** In account settings, only while the showcase event runs and only for someone who owns a hat. */
export function ShowcaseHatSetting() {
  const user = useCurrentUser();
  const live = isShowcaseLive();
  const { data: hats } = trpc.event.getMyHats.useQuery(
    { event: SHOWCASE_EVENT.name },
    { enabled: !!user && live }
  );
  if (!user || !live || !hats?.length) return null;
  return (
    <SettingsSection title="Event hat">
      <SettingRow
        label={SHOWCASE_HAT_TOGGLE_LABEL}
        description={SHOWCASE_HAT_TOGGLE_DESCRIPTION}
        control={<ShowcaseHatSwitch hideLabel />}
      />
    </SettingsSection>
  );
}
