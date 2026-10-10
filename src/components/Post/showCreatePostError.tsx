import { Anchor } from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isDailyPostLimitMessage } from '~/server/schema/post.schema';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { showErrorNotification } from '~/utils/notifications';

export function showCreatePostError(
  message: string,
  { journey, title = 'Failed to create post' }: { journey: boolean; title?: string }
) {
  const linked = journey && isDailyPostLimitMessage(message);
  showErrorNotification({
    title,
    error: new Error(message),
    reason: linked ? (
      <>
        {message}{' '}
        <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
          See your journey
        </Anchor>
      </>
    ) : undefined,
    // Left open so the journey link can be reached before the notification closes.
    autoClose: linked ? false : undefined,
  });
}

/** `showCreatePostError` with the journey link only for viewers who have Creator Journey. */
export function useShowCreatePostError() {
  const journey = !!useFeatureFlags().creatorJourney;
  return (message: string, title?: string) => showCreatePostError(message, { journey, title });
}
