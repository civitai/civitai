import { Alert, Anchor, Badge, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import Link from 'next/link';

import { ReviewThread } from '~/components/Apps/ReviewThread';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { parseReviewSubjectId, reviewThreadModeratorUrl } from '~/shared/utils/app-review-thread';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

/** One row of `appListings.listRepliesAwaitingModerator`. */
export type ReplyAwaitingRow = {
  subjectId: string;
  kind: 'version' | 'listing';
  slug: string;
  routedToQueue: boolean;
  excerpt: string;
  lastMessageAt: Date | string;
};

/**
 * The queue's Replies tab: every submission whose latest message is its developer's, oldest
 * first. "Waiting in the queue" is a reply nobody individual was notified of (the reviewer is
 * gone, no longer a moderator, or the review was automated). Every thread opens here, inline
 * (`?thread=<id>`), including one on a withdrawn version request, whose review page 404s.
 * Rendered only while `features.appReviewReplies` is on.
 */
export function ReviewRepliesQueue({ threadId }: { threadId?: string | null }) {
  const features = useFeatureFlags();
  const enabled = !!features?.appReviewReplies;
  const query = trpc.appListings.listRepliesAwaitingModerator.useQuery(undefined, {
    enabled,
    retry: false,
  });
  if (!enabled) return null;

  const openThread = parseReviewSubjectId(threadId);
  const rows = (query.data ?? []) as ReplyAwaitingRow[];

  return (
    <Stack gap="md" data-testid="review-replies-queue">
      {openThread && (
        <Paper withBorder p="md" radius="md" data-testid="review-replies-open-thread">
          <Stack gap="sm">
            <Text fw={600}>Conversation on {openThread.id}</Text>
            <ReviewThread subjectId={openThread.id} />
          </Stack>
        </Paper>
      )}
      {query.error ? (
        <Alert color="red" variant="light">
          {query.error.message}
        </Alert>
      ) : query.isLoading ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Loading replies…
          </Text>
        </Group>
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="review-replies-empty">
          No developer replies are waiting.
        </Text>
      ) : (
        rows.map((row) => (
          <Paper
            key={row.subjectId}
            withBorder
            p="sm"
            radius="md"
            data-testid={`review-replies-row-${row.subjectId}`}
          >
            <Stack gap={4}>
              <Group gap="xs" wrap="wrap">
                <Text fw={600}>{row.slug}</Text>
                <Badge size="xs" variant="light" color={row.kind === 'version' ? 'blue' : 'grape'}>
                  {row.kind === 'version' ? 'App version' : 'Listing'}
                </Badge>
                <Badge size="xs" variant="filled" color={row.routedToQueue ? 'orange' : 'gray'}>
                  {row.routedToQueue ? 'Waiting in the queue' : 'Sent to the reviewer'}
                </Badge>
                <Text size="xs" c="dimmed">
                  {formatDate(row.lastMessageAt, 'MMM D, YYYY h:mm A')}
                </Text>
              </Group>
              <Text size="sm" c="dimmed" lineClamp={2}>
                {row.excerpt}
              </Text>
              <Anchor component={Link} href={reviewThreadModeratorUrl(row.subjectId)} size="sm">
                Open conversation
              </Anchor>
            </Stack>
          </Paper>
        ))
      )}
    </Stack>
  );
}
