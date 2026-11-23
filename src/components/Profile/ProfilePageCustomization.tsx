import { getEdgeUrl } from '~/client-utils/edge-url';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  profileBarBackground,
  profileCardBackground,
} from '~/components/Profile/profile-card-color';
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
    { userId, browsingLevel },
    { enabled: !!features.profileRedesign }
  );
  if (!features.profileRedesign || !data) return null;

  const background =
    data.background && Flags.intersects(browsingLevel, data.background.nsfwLevel)
      ? data.background
      : null;
  const card = profileCardBackground(data.cardColor, data.cardOpacity);
  const bar = profileBarBackground(data.cardColor);
  if (!background && !card) return null;

  const rules = [
    card &&
      `:root{--profile-card-bg:${card}}[data-profile-card]{background-color:${card}!important}`,
    bar && `[data-subnav]{background-color:${bar}!important;backdrop-filter:blur(8px)}`,
    // As in the design: anchored at the top, behind a 50% scrim so the panels stay readable.
    background &&
      `[data-profile-content]{background-image:linear-gradient(rgba(14,15,18,.5),rgba(14,15,18,.5)),url(${JSON.stringify(
        getEdgeUrl(background.url, { width: 1920 })
      )});background-size:cover;background-position:center top;background-attachment:fixed}`,
  ].filter(Boolean);

  return <style>{rules.join('')}</style>;
}
