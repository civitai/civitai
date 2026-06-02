import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Rating,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconCube,
  IconDownload,
  IconFlag,
  IconPencil,
  IconShare3,
  IconStar,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import type { InferGetServerSidePropsType } from 'next';
import { useEffect, useMemo, useState } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { Model3DComments } from '~/components/Model3D/Comments/Model3DComments';
import { Model3DModMenu } from '~/components/Model3D/Moderation/Model3DModMenu';
import { GenerationDetails } from '~/components/Model3D/GenerationDetails/GenerationDetails';
import { MakesUsesRail } from '~/components/Model3D/MakesUses/MakesUsesRail';
import type { Model3DReviewModalProps } from '~/components/Model3D/Reviews/Model3DReviewModal';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { EntityType, Model3DStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// Dynamic, ssr-disabled import — three.js needs WebGL which only exists in the browser.
const Model3DViewer = dynamic(
  () => import('~/components/Model3D/Viewer/Model3DViewer').then((m) => m.Model3DViewer),
  {
    ssr: false,
    loading: () => (
      <Center mih={420}>
        <Loader />
      </Center>
    ),
  }
);

// Lazy-loaded review modal — only imported when the user clicks "Write a review".
const Model3DReviewModal = dynamic<Model3DReviewModalProps>(
  () => import('~/components/Model3D/Reviews/Model3DReviewModal')
);

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, features }) => {
    // Gate at SSR — avoids a flash of <NotFound /> while FeatureFlagsProvider's
    // user-features tRPC query is still in flight on the client.
    if (!features?.model3dFeed) return { notFound: true };
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };
    return { props: removeEmpty(result.data) };
  },
});

function Model3DDetailsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  const { data: model3d, isLoading, isRefetching } = trpc.model3d.getById.useQuery({ id });
  const { data: filesData } = trpc.model3d.getFiles.useQuery({ id }, { enabled: !!model3d });
  const { data: reviewSummary } = trpc.model3d.reviews.getSummary.useQuery({ model3dId: id });
  // Top 3 reviews shown inline. Full pagination lives on /3d-models/[id]/reviews.
  const { data: previewReviewsData } = trpc.model3d.reviews.getInfinite.useQuery({
    model3dId: id,
    limit: 3,
    page: 1,
  });
  const previewReviews = previewReviewsData?.items ?? [];
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model3D', entityId: id });

  const files = filesData?.files ?? [];
  const primaryFile = useMemo(() => files.find((f) => f.isPrimary) ?? files[0], [files]);

  const [selectedFormat, setSelectedFormat] = useState<string | null>(null);
  useEffect(() => {
    if (primaryFile && !selectedFormat) setSelectedFormat(primaryFile.format);
  }, [primaryFile, selectedFormat]);

  const selectedFile = files.find((f) => f.format === selectedFormat) ?? primaryFile ?? null;

  const handleDownload = () => {
    if (!selectedFile?.downloadUrl) {
      showErrorNotification({
        title: 'Download unavailable',
        error: new Error('No download URL is available for the selected format.'),
      });
      return;
    }
    // Trigger download via anchor — `download` hint preserves the filename when
    // the browser respects it; signed URL handles auth.
    const a = document.createElement('a');
    a.href = selectedFile.downloadUrl;
    a.download = selectedFile.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showSuccessNotification({
      title: 'Download started',
      message: `Downloading ${selectedFile.name}`,
    });
  };

  const openReviewModal = () => {
    if (!model3d) return;
    dialogStore.trigger({
      component: Model3DReviewModal,
      props: {
        model3dId: id,
        model3dName: model3d.name,
      },
    });
  };

  if (isLoading) return <PageLoader />;
  if (!model3d) return <NotFound />;

  const isOwner = !!currentUser && currentUser.id === model3d.userId;
  const isModerator = !!currentUser?.isModerator;
  const canSeeDraft = isOwner || isModerator;
  const isDraft = model3d.status === Model3DStatus.Draft;
  const isUnpublished = model3d.status === Model3DStatus.Unpublished;

  const formatOptions = files.map((f) => ({
    value: f.format,
    label: `${f.format.toUpperCase()} · ${(f.sizeKB / 1024).toFixed(1)} MB${
      f.isPrimary ? ' · primary' : ''
    }`,
  }));

  const tippedAmountTotal = (model3d.metric?.tippedAmountCount ?? 0) + tippedAmount;

  // Feature flag is gated server-side in getServerSideProps — no client check
  // needed (and removing it avoids a NotFound flash during hydration).

  return (
    <>
      <Meta
        title={`${model3d.name} | 3D Models | Civitai`}
        description={model3d.description?.slice(0, 200) ?? '3D model on Civitai'}
        canonical={`/3d-models/${model3d.id}`}
        images={model3d.thumbnailImage ?? undefined}
        deIndex={isDraft || isUnpublished}
      />
      <Container size="xl" pos="relative">
        <LoadingOverlay visible={isRefetching} />

        <Stack gap="md">
          {/* Mod-takedown appeal CTA — surfaces when the owner sees their own
              Unpublished/Deleted Model3D. Mirrors the Image appeal pattern. */}
          {isOwner && (isUnpublished || model3d.status === Model3DStatus.Deleted) && (
            <AlertWithIcon
              icon={<IconAlertTriangle />}
              color="yellow"
              iconColor="yellow"
              title="Removed by moderators"
              radius="md"
            >
              This 3D model has been {isUnpublished ? 'unpublished' : 'removed'} by our moderators.
              We can make mistakes — if you believe this was done in error,{' '}
              <Anchor
                type="button"
                onClick={() =>
                  dialogStore.trigger({
                    component: AppealDialog,
                    props: { entityId: model3d.id, entityType: EntityType.Model3D },
                  })
                }
              >
                appeal this removal
              </Anchor>
              .
            </AlertWithIcon>
          )}

          {/* Header */}
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={4} style={{ flex: 1 }}>
              <Title order={1}>{model3d.name}</Title>
              <Group gap="sm" wrap="wrap">
                <UserAvatar user={model3d.user} withUsername linkToProfile />
                <Divider orientation="vertical" />
                {model3d.license?.name && (
                  <Badge variant="light" color="gray">
                    License: {model3d.license.name}
                  </Badge>
                )}
                {model3d.status !== Model3DStatus.Published && canSeeDraft && (
                  <Badge color="yellow" variant="light">
                    {model3d.status}
                  </Badge>
                )}
                {!!model3d.tags?.length && (
                  <Group gap={4}>
                    {model3d.tags.map((t) => (
                      <Badge key={t.id} variant="outline" size="sm">
                        {t.name}
                      </Badge>
                    ))}
                  </Group>
                )}
              </Group>
            </Stack>

            <Group gap={4} align="center" wrap="nowrap">
              {(isOwner || isModerator) && (
                <Button
                  component={Link}
                  href={`/3d-models/${id}/edit`}
                  variant="default"
                  size="xs"
                  leftSection={<IconPencil size={14} />}
                >
                  Edit
                </Button>
              )}
              {isModerator && (
                <Model3DModMenu
                  model3d={{
                    id: model3d.id,
                    status: model3d.status,
                    nsfw: model3d.nsfw,
                    tosViolation: model3d.tosViolation,
                    poi: model3d.poi,
                    minor: model3d.minor,
                    unlisted: model3d.unlisted,
                    nsfwLevel: model3d.nsfwLevel ?? 0,
                    lockedProperties: model3d.lockedProperties ?? [],
                  }}
                />
              )}
              <InteractiveTipBuzzButton
                toUserId={model3d.user.id}
                entityType="Model3D"
                entityId={id}
              >
                <IconBadge
                  radius="sm"
                  style={{ cursor: 'pointer' }}
                  color="gray"
                  size="lg"
                  h={28}
                  icon={<IconBolt />}
                >
                  <Text size="sm">{abbreviateNumber(tippedAmountTotal)}</Text>
                </IconBadge>
              </InteractiveTipBuzzButton>
              <ShareButton url={`/3d-models/${model3d.id}`} title={model3d.name}>
                <LegacyActionIcon variant="subtle" color="gray" aria-label="Share">
                  <IconShare3 />
                </LegacyActionIcon>
              </ShareButton>
              <LegacyActionIcon
                variant="subtle"
                color="gray"
                aria-label="Report"
                onClick={() =>
                  openReportModal({
                    entityType: ReportEntity.Model3D,
                    entityId: model3d.id,
                  })
                }
              >
                <IconFlag />
              </LegacyActionIcon>
            </Group>
          </Group>

          {/* Viewer pulled out of the grid so it sits full-width above on both
              mobile and desktop. This lets us reorder the remaining columns so
              that on mobile (single column) the sidebar (files / gen details /
              creator / reviews) appears directly under the viewer, with the
              main column content (description / makes-uses / comments) below. */}
          <Card withBorder radius="md" p={0} className="overflow-hidden">
            {primaryFile ? (
              <Model3DViewer
                // Use the resolved/presigned downloadUrl so the browser can
                // actually fetch the GLB — the raw `url` may point at a
                // bucket the public delivery worker doesn't authorize.
                url={primaryFile.downloadUrl ?? primaryFile.url}
                format={primaryFile.format}
                sizeKB={primaryFile.sizeKB}
              />
            ) : (
              <Box className="flex min-h-[420px] items-center justify-center bg-dark-7 p-6">
                <Stack align="center" gap="xs" maw={420} ta="center">
                  <IconCube size={48} stroke={1.5} />
                  <Text fw={600}>No files yet</Text>
                  <Text size="sm" c="dimmed">
                    The 3D files for this model are still being processed.
                  </Text>
                </Stack>
              </Box>
            )}
          </Card>

          {/* Body grid: main column + sidebar on desktop, stacked on mobile.
              Sidebar Col is FIRST in DOM order so on mobile (single column) it
              renders directly under the viewer. On md+ the `order` prop swaps
              the columns visually so the main column is on the left. */}
          <ContainerGrid2 gutter="xl">
            {/* Sidebar — files dropdown + generation details + creator + reviews preview */}
            <ContainerGrid2.Col span={{ base: 12, md: 4 }} order={{ base: 1, md: 2 }}>
              <Stack gap="md">
                {/* Files dropdown + download */}
                <Card withBorder radius="md" p="md">
                  <Stack gap="xs">
                    <Title order={4}>Files</Title>
                    {files.length === 0 ? (
                      <Text c="dimmed" size="sm">
                        No downloadable files available.
                      </Text>
                    ) : (
                      <Stack gap="xs">
                        <Select
                          label="Format"
                          data={formatOptions}
                          value={selectedFormat}
                          onChange={setSelectedFormat}
                        />
                        <Button
                          leftSection={<IconDownload size={16} />}
                          onClick={handleDownload}
                          disabled={!selectedFile}
                          fullWidth
                        >
                          Download
                        </Button>
                        {selectedFile && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {selectedFile.name} · {(selectedFile.sizeKB / 1024).toFixed(2)} MB
                          </Text>
                        )}
                      </Stack>
                    )}
                  </Stack>
                </Card>

                {/* Generation Details */}
                <GenerationDetails
                  params={model3d.generationParams}
                  sourceImage={model3d.sourceImage ?? undefined}
                />

                {/* Creator card */}
                <SmartCreatorCard
                  user={model3d.user}
                  tipBuzzEntityId={id}
                  tipBuzzEntityType="Model3D"
                />

                {/* Inline reviews preview */}
                <Card withBorder radius="md" p="md">
                  <Stack gap="sm">
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="xs">
                        <IconStar size={18} />
                        <Title order={4}>Reviews</Title>
                      </Group>
                      <Button
                        size="xs"
                        onClick={openReviewModal}
                        leftSection={<IconStar size={12} />}
                      >
                        Write a review
                      </Button>
                    </Group>

                    {reviewSummary && reviewSummary.ratingCount > 0 ? (
                      <Group gap="sm" align="center">
                        <Rating value={reviewSummary.ratingAvg} fractions={2} readOnly size="sm" />
                        <Text size="xs" c="dimmed">
                          {reviewSummary.ratingAvg.toFixed(2)} · {reviewSummary.ratingCount}{' '}
                          {reviewSummary.ratingCount === 1 ? 'review' : 'reviews'}
                        </Text>
                      </Group>
                    ) : (
                      <Text size="xs" c="dimmed">
                        No reviews yet — be the first.
                      </Text>
                    )}

                    {previewReviews.length > 0 && (
                      <Stack gap="sm">
                        {previewReviews.map((review) => (
                          <Box key={review.id} className="rounded-md bg-gray-1 p-2 dark:bg-dark-6">
                            <Stack gap={4}>
                              <Group gap="xs" justify="space-between" wrap="nowrap">
                                <UserAvatarSimple
                                  id={review.user.id}
                                  username={review.user.username}
                                  profilePicture={review.user.profilePicture}
                                  deletedAt={review.user.deletedAt}
                                  cosmetics={review.user.cosmetics}
                                />
                                <Text size="xs" c="dimmed">
                                  {formatDate(review.createdAt)}
                                </Text>
                              </Group>
                              <Group gap="xs" align="center">
                                <Rating value={review.rating} readOnly size="xs" />
                                {review.recommended && (
                                  <Badge color="green" size="xs" variant="light">
                                    Recommends
                                  </Badge>
                                )}
                              </Group>
                              {review.details && (
                                <Text size="xs" lineClamp={3}>
                                  {review.details}
                                </Text>
                              )}
                              {review.post?.images && review.post.images.length > 0 && (
                                <Group gap={4}>
                                  {review.post.images.slice(0, 3).map((img) => (
                                    <Link
                                      key={img.id}
                                      href={`/posts/${review.post?.id}`}
                                      className="block aspect-square w-9 overflow-hidden rounded-sm border border-solid border-dark-4 bg-dark-7"
                                    >
                                      <EdgeMedia
                                        src={img.url}
                                        type={img.type}
                                        name={img.name ?? undefined}
                                        width={144}
                                        anim={false}
                                        className="size-full object-cover"
                                      />
                                    </Link>
                                  ))}
                                  {review.post.images.length > 3 && (
                                    <Box className="flex h-9 w-9 items-center justify-center rounded-sm bg-dark-5 text-xs text-white">
                                      +{review.post.images.length - 3}
                                    </Box>
                                  )}
                                </Group>
                              )}
                            </Stack>
                          </Box>
                        ))}
                      </Stack>
                    )}

                    <Anchor
                      component={Link}
                      href={`/3d-models/${id}/reviews`}
                      size="sm"
                      ta="center"
                    >
                      See all reviews →
                    </Anchor>
                  </Stack>
                </Card>
              </Stack>
            </ContainerGrid2.Col>

            {/* Main column — description, makes/uses, comments */}
            <ContainerGrid2.Col span={{ base: 12, md: 8 }} order={{ base: 2, md: 1 }}>
              <Stack gap="md">
                {/* Description */}
                {model3d.description && (
                  <Card withBorder radius="md" p="md">
                    <Stack gap="xs">
                      <Title order={3}>About this model</Title>
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {model3d.description}
                      </Text>
                    </Stack>
                  </Card>
                )}

                {/* Makes & Uses */}
                <MakesUsesRail model3dId={id} />

                <Divider />

                {/* Comments */}
                <div id="comments">
                  <Model3DComments model3dId={id} userId={model3d.user.id} />
                </div>
              </Stack>
            </ContainerGrid2.Col>
          </ContainerGrid2>
        </Stack>
      </Container>
    </>
  );
}

export default Page(Model3DDetailsPage);
