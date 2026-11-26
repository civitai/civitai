import { Group, Text } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import {
  APP_REVIEW_TEAM_NAME,
  decisionReviewerByline,
  type DecisionReviewer,
} from '~/server/notifications/app-review-attribution';

/** Who decided a submission, as its developer sees it — `decisionReviewer` on the server. */
export type DecisionReviewerView = DecisionReviewer;

/**
 * "Reviewed by @name, Civitai App Review", with the reviewer's avatar linking to their profile;
 * "Reviewed by Civitai App Review" when the account is gone. Renders nothing for an entry
 * nobody has decided, or for a projection that does not carry the reviewer.
 */
export function ReviewerByline({
  reviewer,
  testId,
}: {
  reviewer: DecisionReviewerView | null | undefined;
  testId?: string;
}) {
  const byline = decisionReviewerByline(reviewer);
  if (!byline) return null;
  if (byline.kind === 'team') {
    return (
      <Text size="xs" c="dimmed" data-testid={testId}>
        Reviewed by {APP_REVIEW_TEAM_NAME}
      </Text>
    );
  }
  return (
    <Group gap={4} wrap="nowrap" data-testid={testId}>
      <Text size="xs" c="dimmed">
        Reviewed by
      </Text>
      <Group gap={0} wrap="nowrap">
        <UserAvatar
          user={{ username: byline.username, image: byline.image }}
          size="xs"
          withUsername
          linkToProfile
        />
        <Text size="xs" c="dimmed">
          ,
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        {APP_REVIEW_TEAM_NAME}
      </Text>
    </Group>
  );
}
