import { Alert, Anchor, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { storylinePriceLabel } from '~/components/Storyline/storyline-ui';
import type { StorylineContinuationStatus } from '~/shared/utils/storyline-placement';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const statusBadge: Record<StorylineContinuationStatus, { label: string; color: string }> = {
  pending: { label: "Waiting for the owner's approval", color: 'yellow' },
  approved: { label: 'Accepted, in the story', color: 'green' },
  declined: { label: 'Declined', color: 'red' },
  expired: { label: 'Expired', color: 'gray' },
  removed: { label: 'No longer available', color: 'gray' },
};

/** The continuations you have sent to other people's storylines, newest first. */
export function StorylineSentList() {
  const query = trpc.placement.getMyStorylineContinuations.useInfiniteQuery(
    {},
    { retry: false, getNextPageParam: (page) => page.nextCursor ?? undefined }
  );
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );

  if (query.isError)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load your sent continuations. Refresh to try again.</Text>
      </Alert>
    );

  if (!rows.length)
    return (
      <Alert color="gray">
        <Text size="sm">You haven&apos;t sent a continuation to anyone&apos;s storyline yet.</Text>
      </Alert>
    );

  return (
    <Stack gap="md" data-testid="storyline-sent-list">
      {rows.map((row) => {
        const badge =
          row.status === 'pending' && row.awaitingReadiness
            ? { label: 'Waiting for your post to finish rating', color: 'yellow' }
            : statusBadge[row.status];
        return (
          <Card key={row.id} withBorder data-testid="storyline-sent-row">
            <Stack gap={6}>
              <Group gap="xs">
                <Badge size="sm" variant="light" color={badge.color}>
                  {badge.label}
                </Badge>
                {row.amount > 0 && (
                  <Text size="xs" c="dimmed">
                    {storylinePriceLabel(row.amount)}
                  </Text>
                )}
              </Group>
              <Text size="sm">
                <Anchor component={Link} href={`/posts/${row.postId}`} inherit>
                  Your post
                </Anchor>{' '}
                continues{' '}
                <Anchor component={Link} href={`/posts/${row.parentPostId}`} inherit>
                  this chapter
                </Anchor>
              </Text>
              <Text size="xs" c="dimmed">
                Sent {formatDate(row.createdAt)}
                {row.status === 'pending' && row.expiresAt
                  ? ` · expires ${formatDate(row.expiresAt)} if not answered`
                  : ''}
              </Text>
            </Stack>
          </Card>
        );
      })}
      {query.hasNextPage && (
        <Button
          variant="default"
          loading={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </Stack>
  );
}
