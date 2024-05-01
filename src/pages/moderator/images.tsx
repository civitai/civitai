import {
  ActionIcon,
  Anchor,
  AspectRatio,
  Badge,
  Box,
  Card,
  Center,
  Checkbox,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { TooltipProps } from '@mantine/core/lib/Tooltip/Tooltip';
import { showNotification } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconTrash,
  IconUserMinus,
  IconUserOff,
} from '@tabler/icons-react';
import produce from 'immer';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import PromptHighlight from '~/components/Image/PromptHighlight/PromptHighlight';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageModerationReviewQueueImage } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { splitUppercase, titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { getImageEntityUrl } from '~/utils/moderators/moderator.util';
import { Collection } from '~/components/Collection/Collection';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useReportCsamImages } from '~/components/Image/image.utils';
import { useInView } from '~/hooks/useInView';
import { useRouter } from 'next/router';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useMergedRef } from '@mantine/hooks';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';

type StoreState = {
  selected: Record<number, boolean>;
  getSelected: () => number[];
  toggleSelected: (value: number) => void;
  selectMany: (values: number[]) => void;
  deselectAll: () => void;
};

const useStore = create<StoreState>()(
  immer((set, get) => ({
    selected: {},
    getSelected: () => {
      const dict = get().selected;
      return Object.keys(dict).map(Number);
    },
    toggleSelected: (value) => {
      set((state) => {
        if (state.selected[value]) delete state.selected[value];
        else state.selected[value] = true;
      });
    },
    selectMany: (values) => {
      set((state) => {
        values.map((value) => {
          state.selected[value] = true;
        });
      });
    },
    deselectAll: () => {
      set((state) => {
        state.selected = {};
      });
    },
  }))
);

const ImageReviewType = {
  minor: 'Minors',
  poi: 'POI',
  reported: 'Reported',
  csam: 'CSAM',
} as const;

type ImageReviewType = keyof typeof ImageReviewType;

export default function Images() {
  // const queryUtils = trpc.useContext();
  // const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);
  const [type, setType] = useState<ImageReviewType>('minor');
  const [activeTag, setActiveNameTag] = useState<number | null>(null);
  const { csamReports } = useFeatureFlags();

  const viewingReported = type === 'reported';

  const filters = useMemo(
    () => ({
      needsReview: !viewingReported ? type : undefined,
      reportReview: viewingReported ? true : undefined,
      tagIds: activeTag ? [activeTag] : undefined,
    }),
    [type, viewingReported, activeTag]
  );
  const { data: nameTags } = trpc.image.getModeratorPOITags.useQuery(undefined, {
    enabled: type === 'poi',
  });
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getModeratorReviewQueue.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const handleTypeChange = (value: ImageReviewType) => {
    setType(value);
  };

  useEffect(deselectAll, [type, deselectAll]);

  const segments = Object.entries(ImageReviewType)
    .map(([key, value]) => ({
      value: key,
      label: value,
    }))
    .filter((x) => (!csamReports ? x.value !== 'csam' : true));

  return (
    <MasonryProvider columnWidth={310} maxColumnCount={7} maxSingleColumnWidth={450}>
      <MasonryContainer py="xl">
        <Stack>
          <Paper
            withBorder
            shadow="lg"
            p="xs"
            sx={{
              display: 'inline-flex',
              float: 'right',
              alignSelf: 'flex-end',
              marginRight: 6,
              position: 'sticky',
              top: 'var(--mantine-header-height,0)',
              marginBottom: -80,
              zIndex: 10,
            }}
          >
            <ModerationControls images={images} filters={filters} view={type} />
          </Paper>

          <Stack spacing={0} mb="lg">
            <Group>
              <Title order={1}>Images Needing Review</Title>
              <SegmentedControl
                size="sm"
                data={segments}
                onChange={handleTypeChange}
                value={type}
              />
            </Group>
            <Text color="dimmed">
              These are images that have been{' '}
              {viewingReported ? 'reported by users' : 'marked by our AI'} which needs further
              attention from the mods
            </Text>
          </Stack>

          {type === 'poi' && nameTags && (
            <Collection
              items={nameTags}
              limit={20}
              badgeProps={{ radius: 'xs', size: 'sm' }}
              renderItem={(tag) => {
                const isActive = activeTag === tag.id;

                return (
                  <Badge
                    component="a"
                    color={isActive ? 'blue' : 'gray'}
                    radius="xs"
                    size="sm"
                    px={8}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setActiveNameTag(isActive ? null : tag.id)}
                  >
                    <Text component="span" size="xs" weight={500}>
                      {tag.name}
                    </Text>{' '}
                    <Text component="span" size="xs" color="dimmed" weight={500}>
                      {tag.count}
                    </Text>
                  </Badge>
                );
              }}
              grouped
            />
          )}

          {isLoading ? (
            <Center py="xl">
              <Loader size="xl" />
            </Center>
          ) : images.length ? (
            <>
              <MasonryColumns
                data={images}
                imageDimensions={(data) => {
                  const width = data?.width ?? 450;
                  const height = data?.height ?? 450;
                  return { width, height };
                }}
                maxItemHeight={600}
                render={ImageGridItem}
                itemId={(data) => data.id}
              />
              {hasNextPage && (
                <InViewLoader
                  loadFn={fetchNextPage}
                  loadCondition={!isRefetching && hasNextPage}
                  style={{ gridColumn: '1/-1' }}
                >
                  <Center p="xl" sx={{ height: 36 }} mt="md">
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
            </>
          ) : (
            <NoContent mt="lg" message="There are no images that need review" />
          )}
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}

function ImageGridItem({ data: image, height }: ImageGridItemProps) {
  const selected = useStore(useCallback((state) => state.selected[image.id] ?? false, [image.id]));
  const toggleSelected = useStore((state) => state.toggleSelected);
  const theme = useMantineTheme();

  const hasReport = !!image.report;
  const pendingReport = hasReport && image.report?.status === 'Pending';
  const entityUrl = getImageEntityUrl(image);

  const { ref: inViewRef, inView } = useInView({ rootMargin: '200%' });
  const ref = useRef<HTMLElement>(null);
  const mergedRef = useMergedRef(inViewRef, ref);

  return (
    <MasonryCard
      shadow="sm"
      p={0}
      sx={{ opacity: !image.needsReview && !pendingReport ? 0.2 : undefined }}
      withBorder
      ref={mergedRef as any}
      style={{
        minHeight: height,
        outline: selected
          ? `3px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`
          : undefined,
      }}
    >
      <>
        <Card.Section sx={{ height: `${height}px` }}>
          {inView && (
            <>
              <Checkbox
                checked={selected}
                onChange={() => toggleSelected(image.id)}
                size="lg"
                sx={{
                  position: 'absolute',
                  top: 5,
                  right: 5,
                  zIndex: 9,
                }}
              />
              <ImageGuard2 image={image}>
                {(safe) => (
                  <Box
                    sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}
                    onClick={() => toggleSelected(image.id)}
                  >
                    <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                    {!safe ? (
                      <AspectRatio ratio={(image.width ?? 1) / (image.height ?? 1)}>
                        <MediaHash {...image} />
                      </AspectRatio>
                    ) : (
                      <>
                        <EdgeMedia
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          type={image.type}
                          width={450}
                          placeholder="empty"
                        />
                        {!!entityUrl && (
                          <Link href={entityUrl} passHref>
                            <ActionIcon
                              component="a"
                              variant="transparent"
                              style={{ position: 'absolute', bottom: '5px', left: '5px' }}
                              size="lg"
                              target="_blank"
                              onClick={(e) => {
                                e.stopPropagation();
                              }}
                            >
                              <IconExternalLink
                                color="white"
                                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                opacity={0.8}
                                strokeWidth={2.5}
                                size={26}
                              />
                            </ActionIcon>
                          </Link>
                        )}
                        {image.meta ? (
                          <ImageMetaPopover
                            meta={image.meta as ImageMetaProps}
                            generationProcess={image.generationProcess ?? 'txt2img'}
                          >
                            <ActionIcon
                              variant="transparent"
                              style={{ position: 'absolute', bottom: '5px', right: '5px' }}
                              size="lg"
                            >
                              <IconInfoCircle
                                color="white"
                                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                opacity={0.8}
                                strokeWidth={2.5}
                                size={26}
                              />
                            </ActionIcon>
                          </ImageMetaPopover>
                        ) : image.metadata?.profilePicture ? (
                          <Badge
                            variant="filled"
                            style={{ position: 'absolute', bottom: '10px', right: '5px' }}
                          >
                            Avatar
                          </Badge>
                        ) : null}
                      </>
                    )}
                  </Box>
                )}
              </ImageGuard2>
            </>
          )}
        </Card.Section>
        {hasReport && (
          <Stack spacing={8} p="xs">
            <Group position="apart" noWrap>
              <Stack spacing={2}>
                <Text size="xs" color="dimmed" inline>
                  Reported by
                </Text>
                <Link href={`/user/${image.report?.user.username}`} passHref>
                  <Anchor size="xs" target="_blank" lineClamp={1} inline>
                    {image.report?.user.username}
                  </Anchor>
                </Link>
              </Stack>
              <Stack spacing={2} align="flex-end">
                <Text size="xs" color="dimmed" inline>
                  Reported for
                </Text>
                <Badge size="sm">{splitUppercase(image.report?.reason ?? '')}</Badge>
              </Stack>
            </Group>
            <ContentClamp maxHeight={150}>
              {image.report?.details
                ? Object.entries(image.report.details).map(([key, value]) => (
                    <Text key={key} size="sm">
                      <Text weight="bold" span>
                        {titleCase(key)}:
                      </Text>{' '}
                      {value}
                    </Text>
                  ))
                : null}
            </ContentClamp>
          </Stack>
        )}
        {image.needsReview === 'minor' && (
          <PromptHighlight prompt={image.meta?.prompt}>
            {({ includesInappropriate, html }) =>
              !includesInappropriate ? (
                <></>
              ) : (
                <Card.Section p="xs">
                  <Text size="sm" lh={1.2} dangerouslySetInnerHTML={{ __html: html }} />
                </Card.Section>
              )
            }
          </PromptHighlight>
        )}
        {image.needsReview === 'poi' && !!image.names?.length && (
          <Card.Section p="xs">
            <Group spacing={4}>
              {image.names.map((name) => (
                <Badge key={name} size="sm">
                  {name}
                </Badge>
              ))}
            </Group>
          </Card.Section>
        )}
      </>
    </MasonryCard>
  );
}

type ImageGridItemProps = {
  data: ImageModerationReviewQueueImage;
  index: number;
  width: number;
  height: number;
};

function ModerationControls({
  images,
  filters,
  view,
}: {
  images: ImageModerationReviewQueueImage[];
  filters: any;
  view: ImageReviewType;
}) {
  const queryUtils = trpc.useUtils();
  const viewingReported = view === 'reported';
  const selected = useStore((state) => Object.keys(state.selected).map(Number));
  const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);
  const router = useRouter();

  const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
    position: 'bottom',
    withArrow: true,
    withinPortal: true,
  };

  const moderateImagesMutation = trpc.image.moderate.useMutation({
    async onMutate({ ids, needsReview, reviewAction }) {
      await queryUtils.image.getModeratorReviewQueue.cancel();
      queryUtils.image.getModeratorReviewQueue.setInfiniteData(
        filters,
        produce((data) => {
          if (!data?.pages?.length) return;

          for (const page of data.pages)
            for (const item of page.items) {
              if (ids.includes(item.id)) {
                item.needsReview =
                  reviewAction !== null || needsReview === null ? null : item.needsReview;
              }
            }
        })
      );
    },
    onSuccess(_, input) {
      const actions: string[] = [];
      if (input.reviewAction === 'delete') actions.push('deleted');
      else if (input.reviewAction === 'removeName') actions.push('name removed');
      else if (!input.needsReview) actions.push('approved');

      showSuccessNotification({ message: `The images have been ${actions.join(', ')}` });
    },
  });

  const createCsamReport = useReportCsamImages({
    async onSuccess() {
      await queryUtils.image.getModeratorReviewQueue.invalidate();
      deselectAll();
    },
  });

  const reportMutation = trpc.report.bulkUpdateStatus.useMutation({
    async onMutate({ ids, status }) {
      await queryUtils.image.getModeratorReviewQueue.cancel();
      queryUtils.image.getModeratorReviewQueue.setInfiniteData(
        filters,
        produce((data) => {
          if (!data?.pages?.length) return;

          for (const page of data.pages)
            for (const item of page.items) {
              if (item.report && ids.includes(item.report.id)) {
                item.report.status = status;
              }
            }
        })
      );
    },
    async onSuccess() {
      await queryUtils.report.getAll.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update',
        error: new Error(error.message),
        reason: 'Something went wrong while updating the reports. Please try again later.',
      });
    },
  });

  const handleRemoveNames = () => {
    deselectAll();
    moderateImagesMutation.mutate({
      ids: selected,
      reviewAction: 'removeName',
      reviewType: view,
    });
  };

  const handleNotPOI = () => {
    deselectAll();
    moderateImagesMutation.mutate({
      ids: selected,
      reviewAction: 'mistake',
      reviewType: view,
    });
  };

  const handleReportCsam = () => {
    if (view === 'csam') {
      const selectedImages = images.filter((x) => selected.includes(x.id));
      const userImages = selectedImages.reduce<Record<number, number[]>>(
        (acc, image) => ({ ...acc, [image.user.id]: [...(acc[image.user.id] ?? []), image.id] }),
        {}
      );
      for (const [userId, ids] of Object.entries(userImages)) {
        useCsamImageSelectStore.getState().setSelected(Number(userId), ids);
      }
      const userIds = Object.keys(userImages);
      router.push(`/moderator/csam/${userIds.join(',')}`);
    } else {
      createCsamReport.mutate({ imageIds: selected });
    }
  };

  const handleDeleteSelected = () => {
    deselectAll();
    moderateImagesMutation.mutate(
      {
        ids: selected,
        reviewAction: 'delete',
        reviewType: view,
      },
      {
        onSuccess() {
          if (viewingReported) {
            const selectedReports = images
              .filter((x) => selected.includes(x.id) && !!x.report)
              // Explicit casting cause we know report is defined
              .map((x) => x.report?.id as number);

            return reportMutation.mutate({ ids: selectedReports, status: 'Actioned' });
          }
        },
      }
    );
  };

  const handleSelectAll = () => {
    selectMany(images.map((x) => x.id));
    // if (selected.length === images.length) handleClearAll();
    // else selectedHandlers.setState(images.map((x) => x.id));
  };

  const handleClearAll = () => deselectAll();

  const handleApproveSelected = () => {
    deselectAll();
    if (viewingReported) {
      const selectedReports = images
        .filter((x) => selected.includes(x.id) && !!x.report)
        // Explicit casting cause we know report is defined
        .map((x) => x.report?.id as number);

      return reportMutation.mutate({ ids: selectedReports, status: 'Unactioned' });
    }

    return moderateImagesMutation.mutate({
      ids: selected,
      needsReview: null,
      reviewType: view,
    });
  };

  const handleRefresh = () => {
    handleClearAll();
    queryUtils.image.getModeratorReviewQueue.invalidate(filters);
    queryUtils.image.getModeratorPOITags.invalidate();
    showNotification({
      id: 'refreshing',
      title: 'Refreshing',
      message: 'Grabbing the latest data...',
      color: 'blue',
    });
  };

  return (
    <Group noWrap spacing="xs">
      <ButtonTooltip label="Select all" {...tooltipProps}>
        <ActionIcon
          variant="outline"
          onClick={handleSelectAll}
          disabled={selected.length === images.length}
        >
          <IconSquareCheck size="1.25rem" />
        </ActionIcon>
      </ButtonTooltip>
      <ButtonTooltip label="Clear selection" {...tooltipProps}>
        <ActionIcon variant="outline" disabled={!selected.length} onClick={handleClearAll}>
          <IconSquareOff size="1.25rem" />
        </ActionIcon>
      </ButtonTooltip>
      <PopConfirm
        message={`Are you sure you want to approve ${selected.length} image(s)?`}
        position="bottom-end"
        onConfirm={handleApproveSelected}
        withArrow
      >
        <ButtonTooltip label="Accept" {...tooltipProps}>
          <ActionIcon variant="outline" disabled={!selected.length} color="green">
            <IconCheck size="1.25rem" />
          </ActionIcon>
        </ButtonTooltip>
      </PopConfirm>
      {view === 'poi' && (
        <PopConfirm
          message={`Are you sure these ${selected.length} image(s) are not real people?`}
          position="bottom-end"
          onConfirm={handleNotPOI}
          withArrow
        >
          <ButtonTooltip label="Not POI" {...tooltipProps}>
            <ActionIcon variant="outline" disabled={!selected.length} color="green">
              <IconUserOff size="1.25rem" />
            </ActionIcon>
          </ButtonTooltip>
        </PopConfirm>
      )}
      {view === 'poi' && (
        <PopConfirm
          message={`Are you sure you want to remove the name on ${selected.length} image(s)?`}
          position="bottom-end"
          onConfirm={handleRemoveNames}
          withArrow
        >
          <ButtonTooltip label="Remove Name" {...tooltipProps}>
            <ActionIcon variant="outline" disabled={!selected.length} color="yellow">
              <IconUserMinus size="1.25rem" />
            </ActionIcon>
          </ButtonTooltip>
        </PopConfirm>
      )}
      <PopConfirm
        message={`Are you sure you want to delete ${selected.length} image(s)?`}
        position="bottom-end"
        onConfirm={handleDeleteSelected}
        withArrow
      >
        <ButtonTooltip label="Delete" {...tooltipProps}>
          <ActionIcon variant="outline" disabled={!selected.length} color="red">
            <IconTrash size="1.25rem" />
          </ActionIcon>
        </ButtonTooltip>
      </PopConfirm>

      <ButtonTooltip {...tooltipProps} label="Report CSAM">
        <ActionIcon
          variant="outline"
          disabled={!selected.length}
          onClick={handleReportCsam}
          color="orange"
        >
          <IconAlertTriangle size="1.25rem" />
        </ActionIcon>
      </ButtonTooltip>
      <ButtonTooltip label="Refresh" {...tooltipProps}>
        <ActionIcon variant="outline" onClick={handleRefresh} color="blue">
          <IconReload size="1.25rem" />
        </ActionIcon>
      </ButtonTooltip>
    </Group>
  );
}
