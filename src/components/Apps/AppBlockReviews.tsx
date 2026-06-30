import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Rating,
  Stack,
  Switch,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconLogin,
  IconMoodSmile,
  IconPlugConnected,
  IconStarFilled,
  IconThumbDown,
  IconThumbUp,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SubscriptionRecord } from '~/server/schema/blocks/subscription.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const DETAILS_MAX = 10000;

type AppBlockReviewsProps = {
  appBlockId: string;
  /** Aggregate from getAppDetail. avgRating is null for a 0-review app. */
  avgRating: number | null;
  reviewCount: number;
  /**
   * The viewer's subscriptions for THIS app (already filtered by the page). The
   * write form is gated on at least one ENABLED install — this matches the
   * server gate (an enabled BlockUserSubscription is required). Pass an empty
   * array when the viewer has none / is anon.
   */
  subscriptions: SubscriptionRecord[];
};

/**
 * F-E marketplace REVIEWS — user-facing UI for the App Blocks 5-star review
 * system. Pure UI + query wiring over the (already-tested, audited) backend
 * procs: `blocks.upsertReview`, `blocks.listReviews`, `blocks.getMyReview`.
 *
 * GATING (mirrors the server gates; the server is the source of truth — these
 * are display-only short-circuits):
 *   - The whole section is rendered ONLY behind the page's `appBlocks` flag
 *     (the page already returns <NotFound/> when the flag is off, but we guard
 *     here too so the component can never render dark).
 *   - The WRITE FORM shows only when the viewer is (a) signed in AND (b) has at
 *     least one ENABLED install for this app. The "no self-review" gate has no
 *     client-visible owner signal in PublicAppDetail, so it is enforced on the
 *     server — if an owner somehow installs + tries to review, the upsert 403s
 *     and we surface the friendly "You cannot review your own app" message.
 *   - When the form is gated off we render an explanatory PROMPT instead of
 *     nothing, so the path to reviewing is discoverable: a "sign in to review"
 *     affordance for anon viewers (LoginRedirect, mirroring the install CTA on
 *     AppBlockCard), or an "install this app to leave a review" message for a
 *     signed-in viewer with no enabled install. This only makes the EXISTING
 *     requirement VISIBLE — the install requirement is still enforced (the
 *     server is the source of truth). There is no client-side owner signal, so
 *     the owner sees the generic install prompt; the server still 403s their
 *     self-review.
 *
 * SECURITY: review `details` is rendered as PLAIN TEXT via React's default
 * escaping (a `<Text>` child) — NEVER dangerouslySetInnerHTML. `details` is not
 * sanitized server-side (audit MEDIUM), so the escaping is the control.
 */
export function AppBlockReviews({
  appBlockId,
  avgRating,
  reviewCount,
  subscriptions,
}: AppBlockReviewsProps) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  const hasEnabledInstall = useMemo(
    () => subscriptions.some((s) => s.appBlockId === appBlockId && s.enabled),
    [subscriptions, appBlockId]
  );
  const canReview = !!features.appBlocks && !!currentUser && hasEnabledInstall;

  // Don't render the section at all if the page itself is gated off.
  if (!features.appBlocks) return null;

  return (
    <Stack gap="lg">
      <ReviewSummary avgRating={avgRating} reviewCount={reviewCount} />
      {canReview ? (
        <ReviewForm appBlockId={appBlockId} />
      ) : (
        <ReviewPrompt signedIn={!!currentUser} />
      )}
      <ReviewList appBlockId={appBlockId} viewerUserId={currentUser?.id} />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Prompt — shown in place of the form when the viewer can't review yet, so the
// path to reviewing is discoverable instead of silently empty. Anon → sign-in
// affordance; signed-in-but-no-install → install requirement made visible.
// ---------------------------------------------------------------------------

function ReviewPrompt({ signedIn }: { signedIn: boolean }) {
  if (!signedIn) {
    return (
      <Card withBorder radius="md" p="md">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Text size="sm" c="dimmed">
            Sign in to leave a review.
          </Text>
          <LoginRedirect reason="perform-action">
            <Button size="xs" variant="light" leftSection={<IconLogin size={14} />}>
              Sign in
            </Button>
          </LoginRedirect>
        </Group>
      </Card>
    );
  }

  // Signed in, but no enabled install for this app — surface the install
  // requirement (the server enforces it; this just makes it visible). There is
  // no client-side owner signal, so the app owner sees this too; their
  // self-review is still blocked server-side.
  return (
    <Card withBorder radius="md" p="md">
      <Group gap="xs" align="center" wrap="nowrap">
        <ThemeIcon variant="light" size="sm" radius="xl">
          <IconPlugConnected size={12} />
        </ThemeIcon>
        <Text size="sm" c="dimmed">
          Install this app to leave a review.
        </Text>
      </Group>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary — avg stars + count. Renders even at 0 reviews.
// ---------------------------------------------------------------------------

function ReviewSummary({
  avgRating,
  reviewCount,
}: {
  avgRating: number | null;
  reviewCount: number;
}) {
  const hasReviews = reviewCount > 0 && avgRating != null;
  return (
    <Stack gap={4}>
      <Title order={4}>Reviews</Title>
      {hasReviews ? (
        <Group gap="xs" align="center">
          <Text fw={600} size="xl" lh={1}>
            {avgRating.toFixed(1)}
          </Text>
          <Rating value={avgRating} fractions={10} readOnly />
          <Text c="dimmed" size="sm">
            ({reviewCount.toLocaleString()} review{reviewCount === 1 ? '' : 's'})
          </Text>
        </Group>
      ) : (
        <Text c="dimmed" size="sm">
          No reviews yet
        </Text>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Write / edit form — gated by the caller. Pre-fills from getMyReview so the
// SAME form edits an existing review (the backend upserts on (user, app)).
// ---------------------------------------------------------------------------

function ReviewForm({ appBlockId }: { appBlockId: string }) {
  const queryUtils = trpc.useUtils();
  const { data: myReview, isLoading: loadingMine } = trpc.blocks.getMyReview.useQuery({
    appBlockId,
  });

  const [rating, setRating] = useState(0);
  const [recommended, setRecommended] = useState(true);
  const [details, setDetails] = useState('');

  // Seed the form from the viewer's existing review once it loads. Keyed on the
  // review id so a fresh load (or switching apps) reseeds, but typing isn't
  // clobbered on every render.
  useEffect(() => {
    if (myReview) {
      setRating(myReview.rating);
      setRecommended(myReview.recommended);
      setDetails(myReview.details ?? '');
    }
  }, [myReview?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const { mutate, isPending } = trpc.blocks.upsertReview.useMutation({
    onSuccess: async (res) => {
      if (res.isFirstReview) {
        showSuccessNotification({
          title: 'Review posted',
          message: 'Thanks for your review! +25 Buzz',
        });
      } else {
        showSuccessNotification({ message: 'Review updated' });
      }
      await Promise.all([
        queryUtils.blocks.getMyReview.invalidate({ appBlockId }),
        queryUtils.blocks.listReviews.invalidate({ appBlockId }),
        // The aggregate (avgRating/reviewCount) lives on getAppDetail; refresh it
        // so the summary reflects the new/changed review.
        queryUtils.blocks.getAppDetail.invalidate({ appBlockId }),
      ]);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not post review',
        error: new Error(error.message),
      });
    },
  });

  const handleSubmit = () => {
    if (rating < 1) {
      showErrorNotification({
        title: 'Pick a rating',
        error: new Error('Select a star rating (1–5) before posting.'),
      });
      return;
    }
    mutate({
      appBlockId,
      rating,
      recommended,
      details: details.trim() ? details : null,
    });
  };

  const isEditing = !!myReview;
  const overLimit = details.length > DETAILS_MAX;

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <Text fw={600}>{isEditing ? 'Edit your review' : 'Write a review'}</Text>
          {loadingMine && <Loader size="xs" />}
        </Group>

        <Group gap="xs" align="center">
          <Text size="sm">Rating</Text>
          <Rating value={rating} onChange={setRating} size="lg" />
        </Group>

        <Switch
          checked={recommended}
          onChange={(e) => setRecommended(e.currentTarget.checked)}
          label="I recommend this app"
          thumbIcon={
            recommended ? (
              <IconThumbUp size={12} stroke={3} />
            ) : (
              <IconThumbDown size={12} stroke={3} />
            )
          }
        />

        <Stack gap={2}>
          <Textarea
            label="Details (optional)"
            placeholder="What did you think of this app?"
            value={details}
            onChange={(e) => setDetails(e.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={10}
            maxLength={DETAILS_MAX}
            error={overLimit ? `Max ${DETAILS_MAX.toLocaleString()} characters` : undefined}
          />
          <Text size="xs" c={overLimit ? 'red' : 'dimmed'} ta="right">
            {details.length.toLocaleString()} / {DETAILS_MAX.toLocaleString()}
          </Text>
        </Stack>

        <Group justify="flex-end">
          <Button
            onClick={handleSubmit}
            loading={isPending}
            disabled={rating < 1 || overLimit}
            leftSection={<IconStarFilled size={16} />}
          >
            {isEditing ? 'Update review' : 'Post review'}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// List — keyset/infinite. Renders details as ESCAPED PLAIN TEXT.
// ---------------------------------------------------------------------------

function ReviewList({
  appBlockId,
  viewerUserId,
}: {
  appBlockId: string;
  viewerUserId?: number;
}) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.blocks.listReviews.useInfiniteQuery(
      { appBlockId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  if (isLoading) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }

  if (items.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        Be the first to review this app.
      </Text>
    );
  }

  return (
    <Stack gap="md">
      {items.map((review) => (
        <div key={review.id}>
          <ReviewRow review={review} isViewer={review.userId === viewerUserId} />
          <Divider mt="md" />
        </div>
      ))}
      {hasNextPage && (
        <Group justify="center">
          <Button
            variant="default"
            onClick={() => fetchNextPage()}
            loading={isFetchingNextPage}
          >
            Load more
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function ReviewRow({
  review,
  isViewer,
}: {
  review: {
    id: number;
    userId: number;
    rating: number;
    recommended: boolean;
    details: string | null;
    createdAt: Date;
  };
  isViewer: boolean;
}) {
  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" align="center" wrap="wrap">
          <UserAvatar userId={review.userId} size="sm" withUsername linkToProfile />
          {isViewer && (
            <Badge size="xs" variant="light" color="blue">
              Your review
            </Badge>
          )}
          <Text c="dimmed" size="xs">
            <DaysFromNow date={review.createdAt} />
          </Text>
        </Group>
        <Group gap="xs" align="center">
          <Rating value={review.rating} readOnly size="sm" />
          {review.recommended ? (
            <Group gap={4} align="center">
              <ThemeIcon variant="light" color="green" size="sm" radius="xl">
                <IconMoodSmile size={12} />
              </ThemeIcon>
              <Text size="xs" c="green">
                Recommends
              </Text>
            </Group>
          ) : (
            <Group gap={4} align="center">
              <ThemeIcon variant="light" color="red" size="sm" radius="xl">
                <IconThumbDown size={12} />
              </ThemeIcon>
              <Text size="xs" c="red">
                Doesn&apos;t recommend
              </Text>
            </Group>
          )}
        </Group>
        {/* PLAIN TEXT ONLY — React escapes this. NEVER dangerouslySetInnerHTML:
            `details` is not sanitized server-side. */}
        {review.details && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {review.details}
          </Text>
        )}
      </Stack>
    </Group>
  );
}
