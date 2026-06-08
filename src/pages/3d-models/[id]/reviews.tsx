import {
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconPencil, IconStar, IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import { keepPreviousData } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import type { InferGetServerSidePropsType } from 'next';
import { useMemo, useState } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import type { Model3DReviewModalProps } from '~/components/Model3D/Reviews/Model3DReviewModal';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';

/**
 * Model3D reviews page.
 *
 * Lists reviews for a Model3D via `trpc.model3d.reviews.getInfinite`. Each row
 * shows the reviewer, star rating, recommend badge, optional details, and any
 * images attached via the review's linked Post (Post.model3dReviewId @unique).
 *
 * The "Write a review" / "Edit your review" CTA opens the Model3DReviewModal
 * via dialogStore. If the current user has an existing review, the modal is
 * pre-filled and submits as an update.
 */

// Lazy-loaded review modal — only imported when the user clicks the CTA.
const Model3DReviewModal = dynamic<Model3DReviewModalProps>(
  () => import('~/components/Model3D/Reviews/Model3DReviewModal')
);

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, features }) => {
    // Gate at SSR to avoid a NotFound flash during hydration.
    if (!features?.model3dFeed) return { notFound: true };
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };
    return { props: removeEmpty(result.data) };
  },
});

const PAGE_SIZE = 20;

function Model3DReviewsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [page, setPage] = useState(1);

  const { data: model3d } = trpc.model3d.getById.useQuery({ id }, { enabled: features.model3dFeed });
  const { data: summary } = trpc.model3d.reviews.getSummary.useQuery(
    { model3dId: id },
    { enabled: features.model3dFeed }
  );
  const {
    data: reviewsData,
    isLoading,
    isFetching,
  } = trpc.model3d.reviews.getInfinite.useQuery(
    { model3dId: id, limit: PAGE_SIZE, page },
    { enabled: features.model3dFeed, placeholderData: keepPreviousData }
  );

  const reviews = reviewsData?.items ?? [];
  const totalPages = reviewsData?.totalPages ?? 1;
  const totalItems = reviewsData?.totalItems ?? 0;

  // Find the current user's review (if any) so the CTA can be "Edit your review"
  // and the modal can pre-fill. Reviews are unique on (model3dId, userId), so
  // there's at most one. We look in the first page only — if the user just
  // wrote a review they'll be at the top.
  const myReview = useMemo(() => {
    if (!currentUser) return undefined;
    return reviews.find((r) => r.userId === currentUser.id);
  }, [reviews, currentUser]);

  const openReviewModal = () => {
    if (!model3d) return;
    dialogStore.trigger({
      component: Model3DReviewModal,
      props: {
        model3dId: id,
        model3dName: model3d.name,
        existing: myReview
          ? {
              id: myReview.id,
              rating: myReview.rating,
              recommended: myReview.recommended,
              details: myReview.details ?? null,
              postId: myReview.post?.id ?? null,
            }
          : undefined,
      },
    });
  };

  // Feature flag is gated server-side in getServerSideProps — no client check
  // needed (and removing it avoids a NotFound flash during hydration).

  return (
    <>
      <Meta
        title={`Reviews · ${model3d?.name ?? `3D Model #${id}`} | Civitai`}
        description={`Community reviews for ${model3d?.name ?? 'this 3D model'} on Civitai.`}
        canonical={`/3d-models/${id}/reviews`}
        deIndex
      />
      <Container size="md">
        <Stack gap="md">
          <Stack gap={4}>
            <Anchor component={Link} href={`/3d-models/${id}`} size="sm">
              ← Back to {model3d?.name ?? `3D Model #${id}`}
            </Anchor>
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
              <Title order={1}>Reviews</Title>
              {currentUser && (
                <Button
                  onClick={openReviewModal}
                  leftSection={myReview ? <IconPencil size={16} /> : <IconStar size={16} />}
                >
                  {myReview ? 'Edit your review' : 'Write a review'}
                </Button>
              )}
            </Group>
          </Stack>

          {/* Summary */}
          <Card withBorder radius="md" p="md">
            {summary && summary.ratingCount > 0 ? (
              <Group gap="md" wrap="wrap" align="center">
                <Group gap="xs" align="center">
                  <IconThumbUp size={20} stroke={2} />
                  <Text size="lg" fw={700}>
                    {Math.round((summary.recommendedCount / summary.ratingCount) * 100)}%
                  </Text>
                </Group>
                <Text size="sm" c="dimmed">
                  · {summary.recommendedCount} of {summary.ratingCount}{' '}
                  {summary.ratingCount === 1 ? 'review' : 'reviews'} recommend this model
                </Text>
              </Group>
            ) : (
              <Text size="sm" c="dimmed">
                No reviews yet. Be the first to share your thoughts.
              </Text>
            )}
          </Card>

          {/* List */}
          {isLoading ? (
            <Center p="lg">
              <Loader />
            </Center>
          ) : reviews.length === 0 ? (
            <Card withBorder radius="md" p="xl">
              <Center>
                <Stack align="center" gap="sm" maw={420} ta="center">
                  <ThemeIcon variant="light" radius="xl" size="xl">
                    <IconStar size={28} stroke={1.5} />
                  </ThemeIcon>
                  <Title order={3}>No reviews yet</Title>
                  <Text c="dimmed" size="sm">
                    Try this model out and share your experience with the community.
                  </Text>
                  {currentUser && (
                    <Button
                      variant="light"
                      onClick={openReviewModal}
                      leftSection={<IconStar size={16} />}
                    >
                      Write a review
                    </Button>
                  )}
                </Stack>
              </Center>
            </Card>
          ) : (
            <Stack gap="sm">
              {reviews.map((review) => (
                <Card key={review.id} withBorder radius="md" p="md">
                  <Stack gap="sm">
                    <Group justify="space-between" wrap="wrap" gap="sm">
                      <UserAvatar
                        user={review.user}
                        withUsername
                        linkToProfile
                        subText={
                          <Text size="xs" c="dimmed">
                            {formatDate(review.createdAt)}
                          </Text>
                        }
                      />
                      <Group gap="xs">
                        {review.recommended ? (
                          <Badge
                            leftSection={<IconThumbUp size={12} />}
                            variant="light"
                            color="green"
                            size="sm"
                          >
                            Recommends
                          </Badge>
                        ) : (
                          <Badge
                            leftSection={<IconThumbDown size={12} />}
                            variant="light"
                            color="red"
                            size="sm"
                          >
                            Doesn&apos;t recommend
                          </Badge>
                        )}
                      </Group>
                    </Group>

                    {review.details && (
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {review.details}
                      </Text>
                    )}

                    {review.post?.images && review.post.images.length > 0 && (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                        {review.post.images.map((img) => (
                          <Link
                            key={img.id}
                            href={`/posts/${review.post?.id}`}
                            className="block overflow-hidden rounded-md border border-solid border-dark-4 transition-colors hover:border-blue-5"
                          >
                            <div className="relative aspect-square w-full bg-dark-7">
                              <EdgeMedia
                                src={img.url}
                                type={img.type}
                                name={img.name ?? undefined}
                                width={450}
                                anim={false}
                                className="size-full object-cover"
                              />
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </Stack>
                </Card>
              ))}

              {totalPages > 1 && (
                <>
                  <Divider />
                  <Group justify="space-between" align="center">
                    <Text size="sm" c="dimmed">
                      Page {page} of {totalPages} · {totalItems}{' '}
                      {totalItems === 1 ? 'review' : 'reviews'}
                    </Text>
                    <Group gap="xs">
                      <Button
                        variant="default"
                        disabled={page <= 1 || isFetching}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="default"
                        disabled={page >= totalPages || isFetching}
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      >
                        Next
                      </Button>
                    </Group>
                  </Group>
                </>
              )}
            </Stack>
          )}
        </Stack>
      </Container>
    </>
  );
}

export default Page(Model3DReviewsPage);
