import { SettingSwitch } from '~/components/Account/SettingsLayout';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export const SHOWCASE_OPT_OUT_LABEL = 'Hide me from the Creator Showcase';
const SHOWCASE_OPT_OUT_DESCRIPTION =
  'Leaves you out of Mythic, the Hall of Fame and New Supernovas. Your badges still show on your profile.';

export function useShowcaseOptOut(options: { onHidden?: () => void } = {}) {
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const mutation = useMutateUserSettings({
    async onSuccess(_, { hideFromCreatorShowcase }) {
      if (hideFromCreatorShowcase) {
        // The showcase reads a replica, so a refetch right after the write can still list the viewer.
        const others = <T extends { user: { id: number } }>(rows: T[]) =>
          rows.filter((row) => row.user.id !== currentUser?.id);
        utils.creatorJourney.getShowcase.setData(
          undefined,
          (old) =>
            old && {
              newSupernovas: others(old.newSupernovas),
              legends: others(old.legends),
              mythics: others(old.mythics),
            }
        );
        options.onHidden?.();
      } else await utils.creatorJourney.getShowcase.invalidate();
      await utils.creatorJourney.getLegendStatus.invalidate();
    },
  });
  return {
    setHidden: (hidden: boolean) => mutation.mutate({ hideFromCreatorShowcase: hidden }),
    isPending: mutation.isPending,
  };
}

export function ShowcaseOptOutSetting({ flat }: { flat?: boolean }) {
  const features = useFeatureFlags();
  const { hideFromCreatorShowcase } = useCurrentUserSettings();
  const { setHidden, isPending } = useShowcaseOptOut();
  if (!features.creatorJourney) return null;

  return (
    <SettingSwitch
      name="hideFromCreatorShowcase"
      sectionTitle="Creator Showcase"
      label={SHOWCASE_OPT_OUT_LABEL}
      description={SHOWCASE_OPT_OUT_DESCRIPTION}
      checked={hideFromCreatorShowcase ?? false}
      disabled={isPending}
      onChange={setHidden}
      flat={flat}
    />
  );
}
