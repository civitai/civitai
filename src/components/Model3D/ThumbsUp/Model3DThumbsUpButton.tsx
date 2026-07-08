import { Badge, Text } from '@mantine/core';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export type Model3DUserReview = { id: number; recommended: boolean } | null;

/**
 * Clickable gold thumbs-up for a 3D model — the "recommend" toggle, mirroring
 * the AI-model thumbs-up. Clicking recommends (`reviews.upsert`); clicking
 * again removes it (`reviews.delete`).
 *
 * The displayed count is optimistic-local: on the feed card `recommendedCount`
 * comes from the periodic metrics job, so a refetch would otherwise clobber a
 * fresh tap with a stale number. We seed once and own the value locally after
 * that; `onSettled` invalidation keeps *other* surfaces correct on next load.
 */
export function Model3DThumbsUpButton({
  model3dId,
  recommendedCount,
  userReview,
  variant = 'card',
}: {
  model3dId: number;
  recommendedCount: number;
  userReview: Model3DUserReview;
  /**
   * `card` → pill chip matching ModelCard's thumbs-up (ThumbsUpIcon 20, fz 16).
   * `detail` → IconBadge matching the /3d-models/[id] stat row (icon 18, sm),
   * gray like its siblings and gold once the viewer has recommended.
   */
  variant?: 'card' | 'detail';
}) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const [recommended, setRecommended] = useState(userReview?.recommended === true);
  const [reviewId, setReviewId] = useState<number | null>(userReview?.id ?? null);
  const [count, setCount] = useState(recommendedCount);
  const prev = useRef<{ recommended: boolean; reviewId: number | null; count: number } | null>(null);

  const invalidate = () => {
    void utils.model3d.getInfinite.invalidate();
    void utils.model3d.getById.invalidate({ id: model3dId });
    void utils.model3d.reviews.getSummary.invalidate({ model3dId });
  };
  const revert = () => {
    if (!prev.current) return;
    setRecommended(prev.current.recommended);
    setReviewId(prev.current.reviewId);
    setCount(prev.current.count);
  };

  const upsert = trpc.model3d.reviews.upsert.useMutation({
    onSuccess: (review) => setReviewId(review?.id ?? reviewId),
    onError: (e) => {
      revert();
      showErrorNotification({ title: 'Could not thumbs up', error: new Error(e.message) });
    },
    onSettled: invalidate,
  });
  const remove = trpc.model3d.reviews.delete.useMutation({
    onError: (e) => {
      revert();
      showErrorNotification({ title: 'Could not remove thumbs up', error: new Error(e.message) });
    },
    onSettled: invalidate,
  });

  const isPending = upsert.isPending || remove.isPending;

  const handleClick = (e: React.MouseEvent) => {
    // The button lives inside the card's <Link>, so stop the navigation.
    e.preventDefault();
    e.stopPropagation();
    if (!currentUser || isPending) return;

    prev.current = { recommended, reviewId, count };
    if (recommended && reviewId) {
      setRecommended(false);
      setCount((c) => Math.max(0, c - 1));
      remove.mutate({ id: reviewId });
    } else {
      setRecommended(true);
      setCount((c) => c + 1);
      upsert.mutate({ model3dId, recommended: true });
    }
  };

  const title = recommended ? 'Remove your thumbs up' : 'Thumbs up this model';

  const badge =
    variant === 'detail' ? (
      // Match the /3d-models/[id] stat row: same IconBadge shell (radius sm,
      // size lg) as its Download/Comments/Images siblings — gray by default,
      // gold once the viewer has recommended.
      <IconBadge
        radius="sm"
        size="lg"
        color={recommended ? 'yellow' : 'gray'}
        icon={<ThumbsUpIcon size={18} filled={recommended} strokeWidth={2} />}
        onClick={handleClick}
        style={{ cursor: 'pointer', opacity: isPending ? 0.6 : 1 }}
        tooltip={title}
      >
        <Text size="sm">{abbreviateNumber(count)}</Text>
      </IconBadge>
    ) : (
      // Feed card: pill chip that mirrors ModelCard's thumbs-up (ThumbsUpIcon
      // 20 / strokeWidth 2.5, count fz 16 / fw 500). Rendered as a role=button
      // span — not a native <button> — because it lives inside the card's <a>.
      <Badge
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') handleClick(e as unknown as React.MouseEvent);
        }}
        className={clsx(cardClasses.statChip, cardClasses.chip)}
        classNames={{ label: 'flex items-center gap-2' }}
        variant="light"
        radius="xl"
        pl={6}
        pr={8}
        style={{ cursor: 'pointer', opacity: isPending ? 0.6 : 1 }}
        title={title}
      >
        <Text c={recommended ? 'yellow.5' : 'yellow.8'} lh={1} span mt={2}>
          <ThumbsUpIcon size={20} filled={recommended} strokeWidth={2.5} />
        </Text>
        <Text fz={16} fw={500} lh={1} span>
          {abbreviateNumber(count)}
        </Text>
      </Badge>
    );

  // Signed-out: keep the same affordance but route the click to login.
  if (!currentUser) return <LoginRedirect reason="create-review">{badge}</LoginRedirect>;
  return badge;
}
