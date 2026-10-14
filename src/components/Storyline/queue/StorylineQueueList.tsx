import { Alert, Anchor, Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { IconCheck, IconStar, IconX } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { storylinePriceLabel, storylineRatingLabel } from '~/components/Storyline/storyline-ui';
import { storylineLevelAllowed } from '~/shared/utils/storyline';
import { daysFromNow, formatDate } from '~/utils/date-helpers';

export type StorylineQueueRow = {
  id: number;
  amount: number;
  createdAt: Date | string;
  expiresAt: Date | string | null;
  placer: { id: number; username: string | null } | null;
  post: { id: number; title: string | null; nsfwLevel: number };
  parentPost: { id: number; title: string | null };
  /** `maxNsfwLevel` marks a row whose rating moved above the ceiling after it was sent. */
  storyline: { id: number; title: string; maxNsfwLevel?: number };
};

export type StorylineQueueAction = 'accept' | 'endorse' | 'decline';

const A_DAY_MS = 24 * 60 * 60 * 1000;
const agedLabel = (at: Date | string) => {
  const value = new Date(at);
  return Date.now() - value.getTime() < A_DAY_MS ? daysFromNow(value) : formatDate(value);
};

/**
 * Continuations waiting on the viewer's storylines. Endorse accepts this one and endorses its
 * author, so their later continuations skip this list.
 */
export function StorylineQueueList({
  rows,
  hasMore,
  isFetchingMore,
  onLoadMore,
  onAct,
  busy,
}: {
  rows: StorylineQueueRow[];
  hasMore: boolean;
  isFetchingMore?: boolean;
  onLoadMore: () => void;
  onAct: (row: StorylineQueueRow, action: StorylineQueueAction) => void;
  /** The row and action in flight. Every button is disabled while one is. */
  busy: { id: number; action: StorylineQueueAction } | null;
}) {
  if (!rows.length && !hasMore)
    return (
      <Alert color="gray">
        <Text size="sm">Nothing is waiting for your review.</Text>
        <Text size="sm" c="dimmed" mt={4}>
          When someone continues one of your storylines it appears here for you to accept, endorse
          or decline. Continuations rated above a storyline&apos;s maximum rating cannot be
          submitted, so they never reach this list.
        </Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      {!rows.length && (
        <Text size="sm" c="dimmed">
          Nothing on this page can be shown. There are more waiting.
        </Text>
      )}

      {rows.map((row) => {
        const ceiling = row.storyline.maxNsfwLevel;
        const overCeiling =
          ceiling != null &&
          !!row.post.nsfwLevel &&
          !storylineLevelAllowed({
            postLevel: row.post.nsfwLevel,
            maxNsfwLevel: ceiling,
          });
        const isBusy = (action: StorylineQueueAction) =>
          busy?.id === row.id && busy.action === action;

        return (
          <Card key={row.id} withBorder data-testid={`storyline-queue-row-${row.id}`}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={4} className="min-w-0">
                <Text size="sm">
                  <Anchor component={Link} href={`/posts/${row.post.id}`} fw={600} target="_blank">
                    {row.post.title || 'Untitled post'}
                  </Anchor>{' '}
                  by{' '}
                  <Text span fw={600}>
                    {row.placer?.username ?? 'Someone'}
                  </Text>
                </Text>
                <Text size="xs" c="dimmed">
                  Continues{' '}
                  <Anchor
                    component={Link}
                    href={`/posts/${row.parentPost.id}`}
                    size="xs"
                    target="_blank"
                  >
                    {row.parentPost.title || 'your chapter'}
                  </Anchor>{' '}
                  in {row.storyline.title}
                </Text>
                <Group gap={6}>
                  <Badge size="sm" variant="light" color={overCeiling ? 'red' : 'gray'}>
                    {row.post.nsfwLevel
                      ? storylineRatingLabel(row.post.nsfwLevel)
                      : 'Not rated yet'}
                  </Badge>
                  <Badge size="sm" variant="light" color={row.amount > 0 ? 'yellow' : 'green'}>
                    {storylinePriceLabel(row.amount)}
                  </Badge>
                </Group>
                {overCeiling && (
                  <Text size="xs" c="red">
                    Rated above this storyline&apos;s maximum of {storylineRatingLabel(ceiling)}.
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  Sent {agedLabel(row.createdAt)}
                  {row.expiresAt ? ` — expires ${formatDate(row.expiresAt)}` : ''}
                </Text>
              </Stack>

              <Stack gap={6} className="w-32 shrink-0">
                <Button
                  size="compact-sm"
                  fullWidth
                  leftSection={<IconCheck size={14} />}
                  loading={isBusy('accept')}
                  disabled={!!busy || overCeiling}
                  onClick={() => onAct(row, 'accept')}
                >
                  Accept
                </Button>
                <Button
                  size="compact-sm"
                  fullWidth
                  variant="light"
                  leftSection={<IconStar size={14} />}
                  loading={isBusy('endorse')}
                  disabled={!!busy || overCeiling || !row.placer}
                  onClick={() => onAct(row, 'endorse')}
                >
                  Endorse
                </Button>
                <Button
                  size="compact-sm"
                  fullWidth
                  variant="default"
                  leftSection={<IconX size={14} />}
                  loading={isBusy('decline')}
                  disabled={!!busy}
                  onClick={() => onAct(row, 'decline')}
                >
                  Decline
                </Button>
              </Stack>
            </Group>
          </Card>
        );
      })}

      {hasMore && (
        <Button variant="default" loading={isFetchingMore} onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </Stack>
  );
}
