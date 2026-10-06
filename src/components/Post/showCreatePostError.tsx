import { Anchor } from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';
import { isDailyPostLimitMessage } from '~/server/schema/post.schema';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { showErrorNotification } from '~/utils/notifications';

export function showCreatePostError(message: string) {
  const atDailyLimit = isDailyPostLimitMessage(message);
  showErrorNotification({
    title: 'Failed to create post',
    error: new Error(message),
    reason: atDailyLimit ? (
      <>
        {message}{' '}
        <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
          See your journey
        </Anchor>
      </>
    ) : undefined,
    // Left open so the journey link can be reached before the notification closes.
    autoClose: atDailyLimit ? false : undefined,
  });
}
