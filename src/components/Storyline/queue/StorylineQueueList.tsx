import { Alert, Anchor, Badge, Button, Card, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconBolt, IconCheck, IconStar, IconX } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  StorylineChapterImage,
  type StorylineCoverImage,
} from '~/components/Storyline/StorylineChapterImage';
import { storylinePriceLabel } from '~/components/Storyline/storyline-ui';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { storylineLevelAllowed } from '~/shared/utils/storyline';
import { isStorylineVerdictLevel, STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { formatDate, recentOrDate } from '~/utils/date-helpers';

export type StorylineQueueRow = {
  id: number;
  amount: number;
  createdAt: Date | string;
  expiresAt: Date | string | null;
  placer: { id: number; username: string | null } | null;
  /**
   * `coverImage` is `null` when the post has no image, or its level is above what this site serves.
   */
  post: {
    id: number;
    title: string | null;
    nsfwLevel: number;
    coverImage?: StorylineCoverImage | null;
  };
  parentPost: { id: number; title: string | null };
  /**
   * `maxNsfwLevel` marks a row whose rating moved above the ceiling after it was sent. `takenDown`
   * holds the row: it cannot be answered until the storyline's takedown lifts.
   */
  storyline: { id: number; title: string; maxNsfwLevel?: number; takenDown?: boolean };
  /** Its chapter already has a main-path chapter after it, so accepting it starts a branch. */
  startsBranch?: boolean;
};

export type StorylineQueueAction = 'accept' | 'endorse' | 'decline';

/**
 * Endorse accepts the continuation and endorses its author, so their later continuations skip this
 * list.
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
        const unusable = isStorylineVerdictLevel(row.post.nsfwLevel);
        const overCeiling =
          ceiling != null &&
          !!row.post.nsfwLevel &&
          !unusable &&
          !storylineLevelAllowed({
            postLevel: row.post.nsfwLevel,
            maxNsfwLevel: ceiling,
          });
        const held = !!row.storyline.takenDown;
        const isBusy = (action: StorylineQueueAction) =>
          busy?.id === row.id && busy.action === action;

        return (
          <Card
            key={row.id}
            withBorder
            radius="lg"
            shadow="sm"
            className="bg-gray-0 dark:bg-dark-6"
            data-testid={`storyline-queue-row-${row.id}`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
              <Group wrap="nowrap" align="flex-start" gap="md" className="min-w-0 flex-1">
                {/* Not a link: the guard's blur toggle is a button. The title links to the post. */}
                <StorylineChapterImage
                  image={row.post.coverImage}
                  hidden={row.post.coverImage == null}
                  hiddenLabel="Preview not available on this site"
                  explain={false}
                  className="aspect-[3/4] w-24 shrink-0"
                />
                <Stack gap={4} className="min-w-0 flex-1">
                  <Text size="sm">
                    <Anchor
                      component={Link}
                      href={`/posts/${row.post.id}`}
                      fw={600}
                      target="_blank"
                    >
                      {row.post.title || 'Continuation'}
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
                    <Badge
                      size="sm"
                      radius="xl"
                      variant="light"
                      color={overCeiling || unusable ? 'red' : 'gray'}
                    >
                      {unusable
                        ? "Can't be used"
                        : row.post.nsfwLevel
                        ? getBrowsingLevelLabel(row.post.nsfwLevel)
                        : 'Not rated yet'}
                    </Badge>
                    {row.amount > 0 ? (
                      <Badge
                        size="sm"
                        radius="xl"
                        variant="light"
                        color="yellow"
                        leftSection={<IconBolt size={12} />}
                      >
                        {storylinePriceLabel(row.amount)}
                      </Badge>
                    ) : (
                      <Badge size="sm" radius="xl" variant="light" color="green">
                        {storylinePriceLabel(row.amount)}
                      </Badge>
                    )}
                    {row.startsBranch !== undefined && (
                      <Badge
                        size="sm"
                        radius="xl"
                        variant="light"
                        color={row.startsBranch ? 'orange' : 'violet'}
                        data-testid={`storyline-queue-path-${row.id}`}
                      >
                        {row.startsBranch ? 'Starts a branch' : 'Joins the main path'}
                      </Badge>
                    )}
                  </Group>
                  {held && (
                    <Text size="xs" c="red" data-testid={`storyline-queue-held-${row.id}`}>
                      This storyline is taken down. You can answer this once the takedown is lifted.
                    </Text>
                  )}
                  {unusable && (
                    <Text size="xs" c="red">
                      {STORYLINE_REFUSALS.cannotSubmit}.
                    </Text>
                  )}
                  {overCeiling && (
                    <Text size="xs" c="red">
                      Rated above this storyline&apos;s maximum of {getBrowsingLevelLabel(ceiling)}.
                    </Text>
                  )}
                  <Text size="xs" c="dimmed">
                    Sent {recentOrDate(row.createdAt)}
                    {row.expiresAt ? ` — expires ${formatDate(row.expiresAt)}` : ''}
                  </Text>
                </Stack>
              </Group>

              <div className="grid grid-cols-3 gap-1.5 sm:flex sm:w-32 sm:shrink-0 sm:flex-col">
                <Button
                  size="compact-sm"
                  fullWidth
                  leftSection={<IconCheck size={14} />}
                  loading={isBusy('accept')}
                  disabled={!!busy || held || overCeiling || unusable}
                  onClick={() => onAct(row, 'accept')}
                >
                  Accept
                </Button>
                <Tooltip
                  label="Approves this chapter and invites its author as a collaborator; they show once they accept"
                  multiline
                  w={260}
                  withinPortal
                >
                  <Button
                    size="compact-sm"
                    fullWidth
                    variant="light"
                    leftSection={<IconStar size={14} />}
                    loading={isBusy('endorse')}
                    disabled={!!busy || held || overCeiling || unusable || !row.placer}
                    onClick={() => onAct(row, 'endorse')}
                  >
                    Approve + invite
                  </Button>
                </Tooltip>
                <Button
                  size="compact-sm"
                  fullWidth
                  variant="default"
                  leftSection={<IconX size={14} />}
                  loading={isBusy('decline')}
                  disabled={!!busy || held}
                  onClick={() => onAct(row, 'decline')}
                >
                  Decline
                </Button>
              </div>
            </div>
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
