import {
  Avatar,
  Badge,
  Button,
  Group,
  SegmentedControl,
  Spoiler,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';

import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

import { browsingLevels, getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { ReportStatus } from '~/shared/utils/prisma/enums';

import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';

type ReviewItem = inferRouterOutputs<AppRouter>['article']['getRatingReviews']['items'][number];

interface LevelOption {
  value: string;
  label: string;
}

interface LevelChipProps {
  label: string;
  level: number | null;
  highlight?: boolean;
  dashed?: boolean;
}

// Mirror the labels used by the moderator dashboard's status filter dropdown
// (src/pages/moderator/article-rating-review.tsx) so badge text and filter
// text agree. Raw enum values (`Actioned` / `Unactioned`) would otherwise leak
// into the UI and read as a different set of states than the filter offers.
const statusLabel: Record<ReportStatus, string> = {
  [ReportStatus.Pending]: 'Pending',
  [ReportStatus.Actioned]: 'Approved',
  [ReportStatus.Unactioned]: 'Rejected',
  [ReportStatus.Processing]: 'Processing',
};

export type ArticleRatingReviewCardProps = {
  review: ReviewItem;
  // Pass-through of the active list query input so the mutation can do an
  // optimistic local removal instead of a full-list invalidate (mods open
  // 50+ cards per session — invalidate per-resolve thrashes the cache).
  queryInput: { limit: number; status: ReportStatus };
};

const levelOptions: LevelOption[] = browsingLevels.map((level) => ({
  value: String(level),
  label: getBrowsingLevelLabel(level),
}));

export function ArticleRatingReviewCard({
  review,
  queryInput,
}: ArticleRatingReviewCardProps) {
  const { article, user } = review;
  const isResolved = review.status !== ReportStatus.Pending;

  const [selectedLevel, setSelectedLevel] = useState<string>(
    String(review.appliedLevel ?? review.suggestedLevel)
  );
  const [modComment, setModComment] = useState<string>(review.modComment ?? '');
  const [resolvedLocal, setResolvedLocal] = useState<boolean>(isResolved);

  const utils = trpc.useUtils();
  const { mutate, isPending } = trpc.article.resolveRatingReview.useMutation({
    onSuccess: (_, variables) => {
      setResolvedLocal(true);
      showSuccessNotification({
        message:
          variables.status === ReportStatus.Actioned
            ? 'Rating review approved'
            : 'Rating review rejected',
      });
      // Optimistically drop the resolved review from the active page cache
      // for the current filter. Skipping the full invalidate keeps the page
      // smooth for moderators resolving many reviews in a session.
      utils.article.getRatingReviews.setInfiniteData(queryInput, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== review.id),
          })),
        };
      });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message), title: 'Failed to resolve review' });
    },
  });

  const handleApprove = () => {
    mutate({
      reviewId: review.id,
      status: ReportStatus.Actioned,
      appliedLevel: Number(selectedLevel),
      modComment: modComment.trim() || undefined,
    });
  };

  const handleDismiss = () => {
    mutate({
      reviewId: review.id,
      status: ReportStatus.Unactioned,
      modComment: modComment.trim() || undefined,
    });
  };

  const dismissDisabled = isPending || resolvedLocal;
  const approveDisabled = isPending || resolvedLocal;

  const articleHref = `/articles/${article.id}`;
  const userHref = user.username ? `/user/${user.username}` : undefined;

  return (
    <div
      className={clsx('flex flex-col gap-4 rounded-md border p-4 card md:flex-row', {
        'opacity-60': resolvedLocal,
      })}
    >
      {/* Cover */}
      <div className="shrink-0">
        <Link href={articleHref} target="_blank">
          {article.cover ? (
            <EdgeMedia2
              src={article.cover}
              type="image"
              width={240}
              style={{
                width: 120,
                height: 160,
                objectFit: 'cover',
                borderRadius: 6,
                display: 'block',
              }}
              alt={article.title}
            />
          ) : (
            <div
              style={{
                width: 120,
                height: 160,
                borderRadius: 6,
                background: 'var(--mantine-color-dark-5)',
              }}
            />
          )}
        </Link>
      </div>

      {/* Body */}
      <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Tooltip label="Open article in new tab" withArrow position="top-start">
              <Text
                component={Link}
                href={articleHref}
                target="_blank"
                fw={600}
                size="lg"
                lineClamp={2}
                className="inline-flex cursor-pointer items-center gap-1 text-blue-4 hover:text-blue-3 hover:underline"
                style={{ wordBreak: 'break-word' }}
              >
                {article.title}
                <IconExternalLink size={16} stroke={2} className="shrink-0" />
              </Text>
            </Tooltip>
            <Group gap={6} wrap="nowrap">
              <Avatar src={user.image ?? undefined} size={20} radius="xl" />
              {userHref ? (
                <Text component={Link} href={userHref} target="_blank" size="sm" c="dimmed">
                  {user.username ?? `User #${user.id}`}
                </Text>
              ) : (
                <Text size="sm" c="dimmed">
                  {user.username ?? `User #${user.id}`}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                · {new Date(review.createdAt).toLocaleString()}
              </Text>
            </Group>
          </Stack>
          <Badge
            color={
              review.status === ReportStatus.Actioned
                ? 'teal'
                : review.status === ReportStatus.Unactioned
                ? 'red'
                : 'yellow'
            }
            variant="light"
          >
            {statusLabel[review.status as ReportStatus] ?? review.status}
          </Badge>
        </Group>

        {/* Level chip row */}
        <div className="grid grid-cols-3 gap-2">
          <LevelChip label="System" level={review.currentLevel} />
          <LevelChip label="Owner suggested" level={review.suggestedLevel} highlight />
          <LevelChip label="Mod applied" level={review.appliedLevel} dashed />
        </div>

        {/* Owner comment */}
        {review.userComment ? (
          <Stack gap={4}>
            <Text size="xs" c="dimmed" fw={500}>
              Owner comment
            </Text>
            <Spoiler maxHeight={48} showLabel="Show more" hideLabel="Show less">
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {review.userComment}
              </Text>
            </Spoiler>
          </Stack>
        ) : (
          <Text size="xs" c="dimmed" fs="italic">
            No comment from owner
          </Text>
        )}

        {/* Action row */}
        {!resolvedLocal ? (
          <Stack gap="xs">
            <SegmentedControl
              value={selectedLevel}
              onChange={setSelectedLevel}
              data={levelOptions}
              fullWidth
              size="sm"
            />
            <Textarea
              placeholder="Optional moderator comment (visible to owner)"
              value={modComment}
              onChange={(e) => setModComment(e.currentTarget.value)}
              minRows={2}
              autosize
              maxLength={1000}
            />
            <Text size="xs" c="dimmed">
              Approving locks the rating at this level until a moderator clears it. Owner edits
              won&apos;t drop the rating below it automatically — but a re-dispute will auto-approve
              if a rescan agrees.
            </Text>
            <Group justify="flex-end" gap="xs">
              <Button
                color="red"
                variant="filled"
                disabled={dismissDisabled}
                loading={isPending}
                onClick={handleDismiss}
              >
                Reject
              </Button>
              <Button
                color="teal"
                disabled={approveDisabled}
                onClick={handleApprove}
                loading={isPending}
              >
                Approve as {getBrowsingLevelLabel(Number(selectedLevel))}
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap={4}>
            <Text size="xs" c="dimmed" fw={500}>
              Moderator note
            </Text>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {review.modComment?.trim() || (
                <Text component="span" size="sm" c="dimmed" fs="italic">
                  No note
                </Text>
              )}
            </Text>
          </Stack>
        )}
      </Stack>
    </div>
  );
}

function LevelChip({ label, level, highlight, dashed }: LevelChipProps) {
  const hasValue = level !== null && level !== undefined && level > 0;
  return (
    <div
      style={{
        border: dashed
          ? '1px dashed var(--mantine-color-dark-3)'
          : '1px solid var(--mantine-color-dark-4)',
        borderRadius: 6,
        padding: '6px 8px',
        background: highlight ? 'var(--mantine-color-blue-light)' : undefined,
      }}
    >
      <Text size="xs" c="dimmed" fw={500} lh={1.1}>
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {hasValue ? getBrowsingLevelLabel(level as number) : '—'}
      </Text>
    </div>
  );
}
