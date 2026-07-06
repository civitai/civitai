import {
  Accordion,
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
  Select,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import {
  IconBolt,
  IconCube,
  IconDownload,
  IconLicense,
  IconMessageCircle2,
  IconPhoto,
  IconShare3,
  IconThumbDown,
  IconThumbUp,
  IconWand,
} from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import type { InferGetServerSidePropsType } from 'next';
import React, { useEffect, useMemo, useState } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Collection } from '~/components/Collection/Collection';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Gated } from '~/components/Gated/Gated';
import { Model3DPermissionIndicator } from '~/components/PermissionIndicator/Model3DPermissionIndicator';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { Model3DComments } from '~/components/Model3D/Comments/Model3DComments';
import { Model3DActionsMenu } from '~/components/Model3D/Actions/Model3DActionsMenu';
import { Model3DThumbsUpButton } from '~/components/Model3D/ThumbsUp/Model3DThumbsUpButton';
import { Model3DGallery } from '~/components/Model3D/Gallery/Model3DGallery';
import type { Model3DReviewModalProps } from '~/components/Model3D/Reviews/Model3DReviewModal';
import type { Model3DViewableVariant } from '~/components/Model3D/Viewer/Model3DVariantViewer';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { EntityType, Model3DStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getModel3DUrl } from '~/utils/string-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// Dynamic, ssr-disabled import — three.js needs WebGL which only exists in the browser.
const Model3DVariantViewer = dynamic(
  () =>
    import('~/components/Model3D/Viewer/Model3DVariantViewer').then(
      (m) => m.Model3DVariantViewer
    ),
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

/**
 * Derive a coarse sentiment label from the recommend percentage. Inlined
 * here — no shared helper exists for this on the AI-model side (they show
 * raw thumbs counts instead of a sentiment band). Bands mirror the common
 * Steam-style scale, scaled down to fit the typical Civitai review volume.
 */
function sentimentLabel(recommendPct: number, ratingCount: number): string {
  if (ratingCount < 5) return 'Too few reviews';
  if (recommendPct >= 95) return 'Overwhelmingly positive';
  if (recommendPct >= 80) return 'Very positive';
  if (recommendPct >= 70) return 'Mostly positive';
  if (recommendPct >= 40) return 'Mixed';
  if (recommendPct >= 20) return 'Mostly negative';
  return 'Overwhelmingly negative';
}

function Model3DDetailsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  // Feature flag is gated server-side in getServerSideProps.
  useFeatureFlags();
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');
  const theme = useMantineTheme();
  // Single-column flat layout on mobile (Viewer → Files → Details →
  // Description → Creator → Comments → License) vs. the canonical
  // two-column layout on md+ (left: Viewer/Description/Comments,
  // right: Files/Details/Creator/License). Both layouts render the
  // same JSX expressions for each block, so the Viewer / Comments
  // tree only mounts once per pass — switching breakpoints (resize)
  // unmounts the old layout and mounts the new one, which is acceptable
  // for a rare event. `getInitialValueInEffect: false` means SSR +
  // first paint default to `false` (desktop) so we don't ship the
  // mobile single-column layout to large screens before hydration.
  const isMobile = useMediaQuery('(max-width: 991px)', false, {
    getInitialValueInEffect: false,
  });

  const { data: model3d, isLoading, isRefetching } = trpc.model3d.getById.useQuery({ id });
  const { data: filesData } = trpc.model3d.getFiles.useQuery({ id }, { enabled: !!model3d });
  const { data: reviewSummary } = trpc.model3d.reviews.getSummary.useQuery({ model3dId: id });

  // Canonicalize the URL to include the name slug once the model loads, so a
  // bare /3d-models/:id (direct hit, old link) upgrades to the pretty form
  // without a reload. Shallow → no getServerSideProps re-run. Query params
  // (e.g. ?highlight= from comment notifications) are preserved.
  const router = useRouter();
  useEffect(() => {
    if (!model3d?.name) return;
    const [path, qs] = router.asPath.split('?');
    const desired = getModel3DUrl({ id, name: model3d.name });
    if (path !== desired) {
      router.replace(qs ? `${desired}?${qs}` : desired, undefined, { shallow: true });
    }
  }, [id, model3d?.name, router]);
  const trackDownload = trpc.model3d.trackDownload.useMutation();
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model3D', entityId: id });

  const files = filesData?.files ?? [];
  const primaryFile = useMemo(() => files.find((f) => f.isPrimary) ?? files[0], [files]);

  // Files are keyed on the download Select by a compound `${variant}__${format}`
  // string — `format` alone collides as soon as the PolyGen workflow emits
  // both `base.glb` and `rigged.glb`. Existing rows pre-dating the variant
  // column default to "primary" via the migration, so the compound key is
  // safe across the upgrade window.
  const getFileKey = (f: { format: string; variant?: string | null }) =>
    `${f.variant ?? 'primary'}__${f.format}`;

  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  useEffect(() => {
    if (primaryFile && !selectedFileKey) setSelectedFileKey(getFileKey(primaryFile));
  }, [primaryFile, selectedFileKey]);

  const selectedFile =
    files.find((f) => getFileKey(f) === selectedFileKey) ?? primaryFile ?? null;

  const handleDownload = () => {
    if (!selectedFile?.downloadUrl) {
      showErrorNotification({
        title: 'Download unavailable',
        error: new Error('No download URL is available for the selected format.'),
      });
      return;
    }
    // Fire-and-forget ClickHouse download tracking (feeds Model3DMetric
    // .downloadCount → the "Most Downloaded" sort). Tracked per model, not
    // per file/format, so re-picking a format doesn't multiply the count.
    trackDownload.mutate({ id });

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

  // Generation Details — collect surfaced params as DescriptionTable rows.
  // Hook MUST run on every render — keep above the early returns below or
  // React throws "Rendered more hooks than during the previous render"
  // (model3d goes from undefined → defined across the loading transition).
  const generationDetailItems = useMemo(() => {
    const params = (model3d?.generationParams ?? null) as Record<string, unknown> | null;
    const surfaced: Array<[string, string]> = [];
    const push = (label: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return;
      if (typeof value === 'boolean') surfaced.push([label, value ? 'Yes' : 'No']);
      else if (typeof value === 'number') surfaced.push([label, value.toLocaleString()]);
      else surfaced.push([label, String(value)]);
    };
    if (params) {
      push('Prompt', params.prompt);
      push('Topology', params.topology);
      push('Target polycount', params.targetPolycount);
      push('Symmetry', params.symmetryMode);
      push('PBR materials', params.enablePbr);
      push('Mode', params.mode);
      push('Seed', params.seed);
      // `enableAnimation` reliably records whether the user *requested*
      // animation, but Meshy can silently fail to animate a mesh — the
      // request succeeds and returns only the base model, no animated /
      // walking / running variants (observed on model 56). So when
      // animation was requested we confirm against the actual output
      // files and, if none arrived, say so rather than printing a
      // misleading "Yes". `enableRigging` is intentionally not surfaced —
      // it's derived from `enableAnimation` at submit time and never
      // persisted with a real value in the params snapshot.
      if (params.enableAnimation === true) {
        const hasAnimationOutput = files.some((f) => {
          const variant = (f.variant ?? 'primary').replace(/-armature$/, '');
          return variant === 'animated' || variant === 'walking' || variant === 'running';
        });
        surfaced.push([
          'Animation',
          hasAnimationOutput ? 'Yes' : 'Requested — Unable to animate model',
        ]);
      } else {
        push('Animation', params.enableAnimation);
      }
      push('Texture prompt', params.texturePrompt);
    }
    return surfaced;
  }, [model3d?.generationParams, files]);

  if (isLoading) return <PageLoader />;
  if (!model3d) return <NotFound />;

  const isOwner = !!currentUser && currentUser.id === model3d.userId;
  const isModerator = !!currentUser?.isModerator;
  const canSeeDraft = isOwner || isModerator;
  const isDraft = model3d.status === Model3DStatus.Draft;
  const isUnpublished = model3d.status === Model3DStatus.Unpublished;

  // Capitalized human-readable variant label. The DB stores the variant
  // discriminator in kebab-case (e.g., "walking-armature"); this turns it
  // into "Walking armature" for the download Select. "primary" surfaces
  // as "Base" so the textured root mesh aligns with the queue card's
  // variant picker terminology.
  const formatVariantLabel = (variant: string | null | undefined) => {
    const v = variant ?? 'primary';
    if (v === 'primary') return 'Base';
    return v
      .split('-')
      .map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p))
      .join(' ');
  };

  // Files dropdown shows variant + format + size so the user can pick a
  // specific (variant, format) pair when the workflow emitted siblings
  // (e.g., base.glb + rigged.glb + animated.glb all coexist under one
  // Model3D after my variant migration).
  const formatOptions = files.map((f) => ({
    value: getFileKey(f),
    label: `${formatVariantLabel(f.variant)} · ${f.format.toUpperCase()} · ${(
      f.sizeKB / 1024
    ).toFixed(1)} MB${f.isPrimary ? ' · primary' : ''}`,
  }));

  // Viewable variants for the inline three.js viewer — GLB only (GLTFLoader
  // doesn't speak FBX) and armature-only meshes filtered out (they'd
  // render as empty space with no visible geometry). Embedded animations
  // on walking/running play automatically via the viewer's AnimationMixer.
  const viewableVariants: Model3DViewableVariant[] = files
    .filter(
      (f) =>
        f.format.toLowerCase() === 'glb' && !(f.variant ?? 'primary').endsWith('-armature')
    )
    .map((f) => ({
      key: getFileKey(f),
      label: formatVariantLabel(f.variant),
      url: f.downloadUrl ?? f.url,
      format: f.format,
      sizeKB: f.sizeKB,
    }));
  const initialViewerKey = primaryFile ? getFileKey(primaryFile) : undefined;

  const tippedAmountTotal = (model3d.metric?.tippedAmountCount ?? 0) + tippedAmount;

  const ratingCount = reviewSummary?.ratingCount ?? 0;
  const recommendedCount = reviewSummary?.recommendedCount ?? 0;
  const recommendPct = ratingCount > 0 ? Math.round((recommendedCount / ratingCount) * 100) : null;

  const hasGenerationData = generationDetailItems.length > 0 || !!model3d.sourceImage;

  const license = model3d.license;

  return (
    // Gate access on green: NSFW 3D models redirect to civitai.red (same
    // behaviour Model/Article/Comic/etc. use). `Gated` owns the Meta tag
    // when it renders, so the page no longer emits `<Meta>` directly —
    // that keeps the paywall structured-data + .paywalled-content wrapper
    // contract intact for verified-bot rendering.
    <Gated
      contentNsfwLevel={model3d.nsfwLevel ?? 0}
      meta={{
        title: `${model3d.name} | 3D Models | Civitai`,
        description: model3d.description?.slice(0, 200) ?? '3D model on Civitai',
        canonical: getModel3DUrl({ id: model3d.id, name: model3d.name }),
        images: model3d.thumbnailImage ?? undefined,
        deIndex: isDraft || isUnpublished,
      }}
    >
      <Container size="xl" pos="relative" className="pb-8">
        <LoadingOverlay visible={isRefetching} />

        <Stack gap="md">
          {/* Mod-takedown appeal CTA — surfaces when the owner sees their own
              Unpublished/Deleted Model3D. Mirrors the Image appeal pattern. */}
          {isOwner && (isUnpublished || model3d.status === Model3DStatus.Deleted) && (
            <AlertWithIcon
              icon={<IconCube />}
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

          {/* Header — mirrors models/[id] structure:
              • title + metric chips on a single line
              • Share + unified context menu to the right
              • underneath: Updated date | tags
              No License badge here (it moves to the sidebar) and no creator
              row (the sidebar card surfaces the creator). */}
          <Stack gap={4}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Group className="flex-1" gap="xs" align="center" wrap="wrap">
                <Title order={1} lineClamp={2} className="break-words">
                  {model3d.name}
                </Title>
                {/* Stat row mirrors models/[id]: ThumbsUp · Download · Comments
                    · Buzz. The thumbs-up badge surfaces positive-review count
                    (`recommendedCount`); the % chip is folded into the Details
                    card so we don't double-surface the same signal. */}
                <Model3DThumbsUpButton
                  model3dId={id}
                  recommendedCount={recommendedCount}
                  userReview={model3d.userReview ?? null}
                  variant="detail"
                />
                <IconBadge radius="sm" size="lg" icon={<IconDownload size={18} />}>
                  <Text size="sm">{abbreviateNumber(model3d.metric?.downloadCount ?? 0)}</Text>
                </IconBadge>
                <IconBadge radius="sm" size="lg" icon={<IconMessageCircle2 size={18} />}>
                  <Text size="sm">{abbreviateNumber(model3d.metric?.commentCount ?? 0)}</Text>
                </IconBadge>
                <IconBadge radius="sm" size="lg" icon={<IconPhoto size={18} />}>
                  <Text size="sm">{abbreviateNumber(model3d.metric?.imageCount ?? 0)}</Text>
                </IconBadge>
                {/* Single buzz surface: the metrics-row badge IS the tip CTA. */}
                <InteractiveTipBuzzButton
                  toUserId={model3d.user.id}
                  entityType="Model3D"
                  entityId={id}
                >
                  <IconBadge
                    radius="sm"
                    size="lg"
                    style={{ cursor: 'pointer' }}
                    icon={<IconBolt size={18} className="text-yellow-7" fill="currentColor" />}
                  >
                    <Text size="sm">{abbreviateNumber(tippedAmountTotal)}</Text>
                  </IconBadge>
                </InteractiveTipBuzzButton>
                {model3d.status !== Model3DStatus.Published && canSeeDraft && (
                  <Badge color="yellow" variant="light">
                    {model3d.status}
                  </Badge>
                )}
              </Group>

              <Group gap={4} align="center" wrap="nowrap">
                <ShareButton
                  url={getModel3DUrl({ id: model3d.id, name: model3d.name })}
                  title={model3d.name}
                >
                  <LegacyActionIcon variant="light" size="lg" aria-label="Share">
                    <IconShare3 size={20} />
                  </LegacyActionIcon>
                </ShareButton>
                {/* Single menu trigger — Report is folded into this menu for
                    any logged-in non-owner / non-mod user (Model3DActionsMenu
                    defaults `showReport={true}`). */}
                <Model3DActionsMenu
                  model3d={{
                    id: model3d.id,
                    userId: model3d.userId,
                    status: model3d.status,
                    nsfw: model3d.nsfw,
                    tosViolation: model3d.tosViolation,
                    poi: model3d.poi,
                    minor: model3d.minor,
                    unlisted: model3d.unlisted,
                    nsfwLevel: model3d.nsfwLevel ?? 0,
                    lockedProperties: model3d.lockedProperties ?? [],
                    thumbnailImageId: model3d.thumbnailImageId,
                  }}
                />
              </Group>
            </Group>
            <Group gap={4} wrap="wrap" align="center">
              <Text size="xs" c="dimmed">
                Updated: {formatDate(model3d.updatedAt)}
              </Text>
              {!!model3d.tags?.length && <Divider orientation="vertical" />}
              <Collection
                items={model3d.tags ?? []}
                renderItem={(tag) => (
                  <Link
                    legacyBehavior
                    href={`/tag/${encodeURIComponent(tag.name.toLowerCase())}`}
                    passHref
                  >
                    <Badge
                      component="a"
                      size="sm"
                      color="gray"
                      variant={colorScheme === 'dark' ? 'filled' : undefined}
                      className="cursor-pointer"
                    >
                      {tag.name}
                    </Badge>
                  </Link>
                )}
              />
            </Group>
          </Stack>

          {/* Two-column body — viewer + main content in the left column,
              sidebar (files / generation data / creator / reviews-preview /
              license) on the right. Mirrors the regular model page two-column
              structure so a user moving between the two doesn't feel
              disoriented. */}
          {/* Page body. Each block below is rendered ONCE into a const and
              dispatched into either the mobile flat Stack (single column)
              or the desktop two-column grid (Viewer + Description +
              Comments on the left, Files + Details + Creator + License on
              the right). Switching layout doesn't double-mount the Viewer
              or the Comments thread because only one of the two branches
              evaluates per render. On resize the layout swaps (one
              unmount + one mount), which is acceptable for an edge-case
              user action. */}
          {(() => {
            const viewerBlock = (
              <Card withBorder radius="md" p={0} className="overflow-hidden">
                {viewableVariants.length > 0 ? (
                  <Model3DVariantViewer
                    // Use the resolved/presigned downloadUrl so the browser
                    // can actually fetch the GLB — the raw `url` may point
                    // at a bucket the public delivery worker doesn't
                    // authorize. The wrapper exposes a top-left Select to
                    // switch between Base / Rigged / Animated / Walking /
                    // Running variants; walking/running auto-play their
                    // embedded animations via the viewer's AnimationMixer.
                    variants={viewableVariants}
                    initialKey={initialViewerKey}
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
            );

            const filesBlock = (
              <Card withBorder radius="md" p="md">
                {files.length === 0 ? (
                  <Text c="dimmed" size="sm">
                    No downloadable files available.
                  </Text>
                ) : (
                  <Stack gap="xs">
                    <Select
                      data={formatOptions}
                      value={selectedFileKey}
                      onChange={setSelectedFileKey}
                      aria-label="File variant + format"
                    />
                    <Button
                      leftSection={<IconDownload size={16} />}
                      onClick={handleDownload}
                      disabled={!selectedFile}
                      fullWidth
                    >
                      Download{' '}
                      {selectedFile && (
                        <Text span ml={4}>
                          ({(selectedFile.sizeKB / 1024).toFixed(2)} MB)
                        </Text>
                      )}
                    </Button>
                  </Stack>
                )}
              </Card>
            );

            const detailsBlock = (hasGenerationData || reviewSummary) ? (
                  <Accordion
                    variant="separated"
                    multiple
                    defaultValue={['details']}
                    styles={(t) => ({
                      content: { padding: 0 },
                      label: { padding: 0 },
                      item: {
                        overflow: 'hidden',
                        borderColor:
                          colorScheme === 'dark' ? t.colors.dark[4] : t.colors.gray[3],
                        boxShadow: t.shadows.sm,
                      },
                      control: {
                        padding: t.spacing.sm,
                        gap: t.spacing.md,
                      },
                    })}
                  >
                    <Accordion.Item value="details">
                      <Accordion.Control>
                        <Group justify="space-between">
                          Details
                          <Button
                            size="compact-xs"
                            variant="light"
                            leftSection={<IconWand size={12} />}
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              openReviewModal();
                            }}
                          >
                            Write a review
                          </Button>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel p={0}>
                        <Stack
                          gap={0}
                          style={{
                            backgroundColor:
                              colorScheme === 'dark' ? '#1f2023' : theme.colors.gray[0],
                          }}
                        >
                          {/* Reviews row */}
                          <Group
                            justify="space-between"
                            px="md"
                            py={10}
                            style={{
                              borderBottom: `1px solid ${
                                colorScheme === 'dark'
                                  ? theme.colors.dark[4]
                                  : theme.colors.gray[3]
                              }`,
                            }}
                          >
                            <Text size="sm" c="dimmed">
                              Reviews
                            </Text>
                            {recommendPct !== null ? (
                              <Anchor
                                component={Link}
                                href={`/3d-models/${id}/reviews`}
                                underline="hover"
                              >
                                <Group gap={6} wrap="nowrap" align="center">
                                  {recommendPct >= 50 ? (
                                    <IconThumbUp size={14} />
                                  ) : (
                                    <IconThumbDown size={14} />
                                  )}
                                  <Text size="sm" fw={500}>
                                    {sentimentLabel(recommendPct, ratingCount)}
                                  </Text>
                                  <Badge size="sm" variant="light" color="gray">
                                    {recommendPct}% · {abbreviateNumber(ratingCount)}
                                  </Badge>
                                </Group>
                              </Anchor>
                            ) : (
                              <Anchor
                                component={Link}
                                href={`/3d-models/${id}/reviews`}
                                size="sm"
                              >
                                No reviews yet
                              </Anchor>
                            )}
                          </Group>

                          {model3d.sourceImage && (
                            <Group
                              align="flex-start"
                              justify="space-between"
                              px="md"
                              py={10}
                              style={{
                                borderBottom: `1px solid ${
                                  colorScheme === 'dark'
                                    ? theme.colors.dark[4]
                                    : theme.colors.gray[3]
                                }`,
                              }}
                            >
                              <Text size="sm" c="dimmed">
                                Source image
                              </Text>
                              <Link
                                href={`/images/${model3d.sourceImage.id}`}
                                className="block w-[120px] overflow-hidden rounded-md border border-solid border-dark-4"
                              >
                                <EdgeMedia
                                  src={model3d.sourceImage.url}
                                  name={model3d.sourceImage.name ?? undefined}
                                  type={
                                    (model3d.sourceImage.type as
                                      | 'image'
                                      | 'video'
                                      | 'audio'
                                      | undefined) ?? undefined
                                  }
                                  width={240}
                                  anim={false}
                                  className="size-full object-cover"
                                />
                              </Link>
                            </Group>
                          )}

                          {generationDetailItems.map(([label, value], i) => (
                            <Group
                              key={label}
                              justify="space-between"
                              px="md"
                              py={10}
                              style={{
                                borderBottom:
                                  i === generationDetailItems.length - 1
                                    ? 'none'
                                    : `1px solid ${
                                        colorScheme === 'dark'
                                          ? theme.colors.dark[4]
                                          : theme.colors.gray[3]
                                      }`,
                              }}
                            >
                              <Text size="sm" c="dimmed">
                                {label}
                              </Text>
                              <Text size="sm" ta="right" style={{ wordBreak: 'break-word' }}>
                                {value}
                              </Text>
                            </Group>
                          ))}
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
            ) : null;

            const descriptionBlock = model3d.description ? (
              <ContentClamp maxHeight={460}>
                <RenderHtml html={model3d.description ?? ''} />
              </ContentClamp>
            ) : null;

            const creatorBlock = (
              <SmartCreatorCard
                user={model3d.user}
                tipBuzzEntityId={id}
                tipBuzzEntityType="Model3D"
              />
            );

            const commentsBlock = (
              <Box id="comments">
                <Divider mb="sm" />
                <Model3DComments model3dId={id} userId={model3d.user.id} />
              </Box>
            );

            const licenseBlock = license ? (
              <Stack gap={4}>
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                  <Group gap={4} wrap="wrap" align="center" style={{ flex: 1, minWidth: 0 }}>
                    <IconLicense size={16} />
                    <Text size="xs" c="dimmed" style={{ lineHeight: 1.1 }}>
                      License:
                    </Text>
                    <Text size="xs" c="dimmed" style={{ lineHeight: 1.1 }}>
                      {license.name}
                    </Text>
                  </Group>
                  <Model3DPermissionIndicator license={license} size={24} />
                </Group>
                {model3d.licenseDetails && (
                  <Text size="xs" c="dimmed">
                    {model3d.licenseDetails}
                  </Text>
                )}
              </Stack>
            ) : null;

            // Mobile: single flat Stack in the order the user actually
            // wants — Viewer, Files, Details, Description, Creator,
            // Comments, License. No two-column grid means each item flows
            // tightly under the previous one without any row-alignment
            // gaps.
            if (isMobile) {
              return (
                <Stack gap="md">
                  {viewerBlock}
                  {filesBlock}
                  {detailsBlock}
                  {descriptionBlock}
                  {creatorBlock}
                  {commentsBlock}
                  {licenseBlock}
                </Stack>
              );
            }

            // Desktop: original two-column layout. Two independent Stacks
            // mean each column flows tightly with its own internal
            // spacing — no row-aligned gaps between left/right items.
            return (
              <ContainerGrid2 gutter="xl">
                <ContainerGrid2.Col span={{ base: 12, md: 8 }}>
                  <Stack gap="md">
                    {viewerBlock}
                    {descriptionBlock}
                    {commentsBlock}
                  </Stack>
                </ContainerGrid2.Col>
                <ContainerGrid2.Col span={{ base: 12, md: 4 }}>
                  <Stack gap="md">
                    {filesBlock}
                    {detailsBlock}
                    {creatorBlock}
                    {licenseBlock}
                  </Stack>
                </ContainerGrid2.Col>
              </ContainerGrid2>
            );
          })()}

        </Stack>
      </Container>
      {/* Community gallery — rendered OUTSIDE the size="xl" Container so the
          masonry can claim the full page width and pack 6–7 cards across on
          wide screens (matching the model-detail page bottom gallery). */}
      <Box id="gallery" mt="md">
        <Model3DGallery
          model3d={{ id, userId: model3d.userId, minor: model3d.minor }}
        />
      </Box>
    </Gated>
  );
}

export default Page(Model3DDetailsPage);
