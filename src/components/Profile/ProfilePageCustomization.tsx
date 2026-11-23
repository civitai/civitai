import { getEdgeUrl } from '~/client-utils/edge-url';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { profileCardBackground } from '~/components/Profile/profile-card-color';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Flags } from '~/shared/utils/flags';
import { trpc } from '~/utils/trpc';

/**
 * A member's page background and card colour (profile redesign), as page-scoped CSS: cards read
 * `--profile-card-bg`, and the content column carries the background. The background shows only
 * within the viewer's browsing level; there is no blur to reveal it behind.
 */
export function ProfilePageCustomization({ userId }: { userId: number }) {
  const features = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();
  const { data } = trpc.userProfile.customization.useQuery(
    { userId },
    { enabled: !!features.profileRedesign }
  );
  if (!features.profileRedesign || !data) return null;

  const background =
    data.background && Flags.intersects(browsingLevel, data.background.nsfwLevel)
      ? data.background
      : null;
  const card = profileCardBackground(data.cardColor, data.cardOpacity);
  if (!background && !card) return null;

  const rules = [
    card &&
      `:root{--profile-card-bg:${card}}[data-profile-card]{background-color:${card}!important}`,
    background &&
      `[data-profile-content]{background-image:url(${JSON.stringify(
        getEdgeUrl(background.url, { width: 1920 })
      )});background-size:cover;background-position:center;background-attachment:fixed}`,
  ].filter(Boolean);

  return <style>{rules.join('')}</style>;
}
