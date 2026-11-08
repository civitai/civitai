import { Anchor } from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { showErrorNotification } from '~/utils/notifications';
import { getRateLimit, withRetryText } from '~/utils/rate-limit';

type PostError = string | { message: string };

export function showCreatePostError(
  error: PostError,
  { journey, title = 'Failed to create post' }: { journey: boolean; title?: string }
) {
  const message = typeof error === 'string' ? error : error.message;
  const rateLimit = getRateLimit(error);
  const linked = journey && rateLimit?.id === 'posts.daily';
  showErrorNotification({
    title,
    error: typeof error === 'string' ? new Error(error) : error,
    reason: linked ? (
      <>
        {withRetryText(message, rateLimit)}{' '}
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
  return (error: PostError, title?: string) => showCreatePostError(error, { journey, title });
}
