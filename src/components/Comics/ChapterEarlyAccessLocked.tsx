import { Alert, Anchor, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { chapterEarlyAccessLockedMessage } from '~/server/utils/early-access-helpers';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { creatorScoreFromSession } from '~/shared/utils/creator-score';

export function ChapterEarlyAccessLocked() {
  const currentUser = useCurrentUser();

  return (
    <Alert color="yellow" variant="light" icon={<IconLock size={16} />}>
      <Text size="xs">
        {chapterEarlyAccessLockedMessage(creatorScoreFromSession(currentUser))}{' '}
        <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
          See your journey
        </Anchor>
      </Text>
    </Alert>
  );
}
