import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  milestoneLandingHref,
  parseMilestoneShareToken,
} from '~/shared/constants/creator-journey.constants';
import { trpc } from '~/utils/trpc';

/**
 * On the profile, sends a visitor who opened a shared milestone link (`?milestone=`) on to the
 * Achievements tab, once the milestone is known to be shareable. The query matches the layout's, key and
 * `enabled` both, so it reads the server-rendered answer rather than fetching again.
 */
export function useMilestoneLanding(user: { id: number } | null | undefined) {
  const router = useRouter();
  const features = useFeatureFlags();
  const milestone = parseMilestoneShareToken(router.query.milestone);
  const { data: shareable } = trpc.creatorJourney.isMilestoneShareable.useQuery(
    { userId: user?.id ?? 0, milestone: milestone ?? 'spark' },
    { enabled: !!user && !!milestone }
  );
  const href = milestoneLandingHref({
    username: router.query.username as string,
    milestone,
    shareable,
    journeyOn: !!features.creatorJourney,
  });

  useEffect(() => {
    if (href) router.replace(href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href]);
}
