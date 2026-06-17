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
  IconShare3,
  IconThumbDown,
  IconThumbUp,
  IconWand,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
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
import { Meta } from '~/components/Meta/Meta';
import { Model3DPermissionIndicator } from '~/components/PermissionIndicator/Model3DPermissionIndicator';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { Model3DComments } from '~/components/Model3D/Comments/Model3DComments';
import { Model3DActionsMenu } from '~/components/Model3D/Actions/Model3DActionsMenu';
import { Model3DGallery } from '~/components/Model3D/Gallery/Model3DGallery';
import type { Model3DReviewModalProps } from '~/components/Model3D/Reviews/Model3DReviewModal';
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

  const { data: model3d, isLoading, isRefetching } = trpc.model3d.getById.useQuery({ id });
  const { data: filesData } = trpc.model3d.getFiles.useQuery({ id }, { enabled: !!model3d });
  const { data: reviewSummary } = trpc.model3d.reviews.getSummary.useQuery({ model3dId: id });
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
      push('Rigging', params.enableRigging);
      push('Animation', params.enableAnimation);
      push('Texture prompt', params.texturePrompt);
    }
    return surfaced;
  }, [model3d?.generationParams]);

  if (isLoading) return <PageLoader />;
  if (!model3d) return <NotFound />;

  const isOwner = !!currentUser && currentUser.id === model3d.userId;
  const isModerator = !!currentUser?.isModerator;
  const canSeeDraft = isOwner || isModerator;
  const isDraft = model3d.status === Model3DStatus.Draft;
  const isUnpublished = model3d.status === Model3DStatus.Unpublished;

  // Format dropdown shows just the format + size — the filename is implicit
  // (we kick off the download with the resolved primary/variant filename) so
  // the download card stays compact.
  const formatOptions = files.map((f) => ({
    value: f.format,
    label: `${f.format.toUpperCase()} · ${(f.sizeKB / 1024).toFixed(1)} MB${
      f.isPrimary ? ' · primary' : ''
    }`,
  }));

  const tippedAmountTotal = (model3d.metric?.tippedAmountCount ?? 0) + tippedAmount;

  const ratingCount = reviewSummary?.ratingCount ?? 0;
  const recommendedCount = reviewSummary?.recommendedCount ?? 0;
  const recommendPct = ratingCount > 0 ? Math.round((recommendedCount / ratingCount) * 100) : null;

  const hasGenerationData = generationDetailItems.length > 0 || !!model3d.sourceImage;

  const license = model3d.license;

  return (
    <>
      <Meta
        title={`${model3d.name} | 3D Models | Civitai`}
        description={model3d.description?.slice(0, 200) ?? '3D model on Civitai'}
        canonical={`/3d-models/${model3d.id}`}
        images={model3d.thumbnailImage ?? undefined}
        deIndex={isDraft || isUnpublished}
      />
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
                <IconBadge
                  radius="sm"
                  size="lg"
                  color="green"
                  icon={<IconThumbUp size={18} />}
                >
                  <Text size="sm">{abbreviateNumber(recommendedCount)}</Text>
                </IconBadge>
                <IconBadge radius="sm" size="lg" icon={<IconDownload size={18} />}>
                  <Text size="sm">{abbreviateNumber(model3d.metric?.downloadCount ?? 0)}</Text>
                </IconBadge>
                <IconBadge radius="sm" size="lg" icon={<IconMessageCircle2 size={18} />}>
                  <Text size="sm">{abbreviateNumber(model3d.metric?.commentCount ?? 0)}</Text>
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
                <ShareButton url={`/3d-models/${model3d.id}`} title={model3d.name}>
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
          <ContainerGrid2 gutter="xl">
            {/* Main column — viewer (top, matches the body width) + about
                this model body + comments. */}
            <ContainerGrid2.Col span={{ base: 12, md: 8 }} order={{ base: 2, md: 1 }}>
              <Stack gap="md">
                <Card withBorder radius="md" p={0} className="overflow-hidden">
                  {primaryFile ? (
                    <Model3DViewer
                      // Use the resolved/presigned downloadUrl so the browser
                      // can actually fetch the GLB — the raw `url` may point
                      // at a bucket the public delivery worker doesn't
                      // authorize.
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

                {/* About this model — inline body, no card wrapper, no
                    "About this model" heading. Matches the model page. */}
                {model3d.description && (
                  <ContentClamp maxHeight={460}>
                    <RenderHtml html={model3d.description ?? ''} />
                  </ContentClamp>
                )}

                {/* Comments — limited to 5 initial entries with the
                    Load-More CTA already rendered by RootThreadProvider when
                    the page count exceeds `limit`. Negative top margin pulls
                    the divider+comments up so the divider+section start sit
                    closer to the description than the default Stack-gap-md. */}
                <Box id="comments" style={{ marginTop: -8 }}>
                  <Divider mb="sm" />
                  <Model3DComments model3dId={id} userId={model3d.user.id} />
                </Box>
              </Stack>
            </ContainerGrid2.Col>

            {/* Sidebar — Files / Generation Data / Creator / Reviews-preview
                / License. Lifted to the top of the page (visually) so it sits
                beside the viewer on desktop. On mobile (single column) it
                renders directly under the title block. */}
            <ContainerGrid2.Col span={{ base: 12, md: 4 }} order={{ base: 1, md: 2 }}>
              <Stack gap="md">
                {/* Files card — no title, just a format Select + a primary
                    Download button with the file size baked into the button.
                    Mirrors the model-detail download card. */}
                <Card withBorder radius="md" p="md">
                  {files.length === 0 ? (
                    <Text c="dimmed" size="sm">
                      No downloadable files available.
                    </Text>
                  ) : (
                    <Stack gap="xs">
                      <Select
                        data={formatOptions}
                        value={selectedFormat}
                        onChange={setSelectedFormat}
                        aria-label="File format"
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

                {/* Details — single Accordion mirroring model-detail
                    sidebar. Edge-to-edge rows: Reviews, Source image (if
                    any), then generation params. Reviews fold in here so we
                    don't need a standalone Reviews card. */}
                {(hasGenerationData || reviewSummary) && (
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
                )}

                {/* Creator card */}
                <SmartCreatorCard
                  user={model3d.user}
                  tipBuzzEntityId={id}
                  tipBuzzEntityType="Model3D"
                />

                {/* Compact license footer — mirrors the model page footer:
                    inline license name + tooltipped permission icons via
                    Model3DPermissionIndicator (which shares its visual with
                    Models' PermissionIndicator). No card wrapper. */}
                {license && (
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
                )}
                {license && model3d.licenseDetails && (
                  <Text size="xs" c="dimmed">
                    {model3d.licenseDetails}
                  </Text>
                )}
              </Stack>
            </ContainerGrid2.Col>
          </ContainerGrid2>

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
    </>
  );
}

export default Page(Model3DDetailsPage);
