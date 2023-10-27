import {
  ActionIcon,
  Anchor,
  AspectRatio,
  Badge,
  Box,
  Card,
  Center,
  Checkbox,
  Container,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { TooltipProps } from '@mantine/core/lib/Tooltip/Tooltip';
import { useListState } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import {
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconTrash,
} from '@tabler/icons-react';
import produce from 'immer';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { ImageSort } from '~/server/common/enums';
import { ImageInclude, ImageMetaProps } from '~/server/schema/image.schema';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { ImageGetInfinite } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { splitUppercase, titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

// export const getServerSideProps = createServerSideProps({
//   useSession: true,
//   resolver: async ({ session }) => {
//     if (!session?.user?.isModerator || session.user?.bannedAt) {
//       return {
//         redirect: {
//           destination: '/',
//           permanent: false,
//         },
//       };
//     }
//   },
// });

// const REMOVABLE_TAGS = ['child', 'teen', 'baby', 'girl', 'boy'];
// const ADDABLE_TAGS = ['anime', 'cartoon', 'comics', 'manga', 'explicit nudity', 'suggestive'];

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
} as const;

type ImageReviewType = keyof typeof ImageReviewType;

export default function Images() {
  const { ref, inView } = useInView();
  // const queryUtils = trpc.useContext();
  // const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);
  const [type, setType] = useState<ImageReviewType | 'reported'>('minor');

  const viewingReported = type === 'reported';

  const filters = useMemo(
    () => ({
      needsReview: !viewingReported ? type : undefined,
      reportReview: viewingReported ? true : undefined,
      include: viewingReported ? (['report'] as ImageInclude[]) : undefined,
      sort: ImageSort.Newest,
    }),
    [type, viewingReported]
  );
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getInfinite.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const handleTypeChange = (value: ImageReviewType | 'reported') => {
    setType(value);
  };

  useEffect(deselectAll, [type, deselectAll]);

  useEffect(() => {
    if (inView) fetchNextPage();
  }, [fetchNextPage, inView]);

  const segments = [
    ...Object.entries(ImageReviewType).map(([key, value]) => ({ value: key, label: value })),
    { value: 'reported', label: 'Reported' },
  ];

  return (
    <Container size="xl" py="xl">
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
            top: 'calc(var(--mantine-header-height,0) + 16px)',
            marginBottom: -80,
            zIndex: 10,
          }}
        >
          <ModerationControls images={images} filters={filters} view={type} />
        </Paper>

        <Stack spacing={0} mb="lg">
          <Group>
            <Title order={1}>Images Needing Review</Title>
            <SegmentedControl size="sm" data={segments} onChange={handleTypeChange} value={type} />
          </Group>
          <Text color="dimmed">
            These are images that have been{' '}
            {viewingReported ? 'reported by users' : 'marked by our AI'} which needs further
            attention from the mods
          </Text>
        </Stack>

        {isLoading ? (
          <Center py="xl">
            <Loader size="xl" />
          </Center>
        ) : images.length ? (
          <MasonryGrid2
            data={images}
            isRefetching={isRefetching}
            isFetchingNextPage={isFetchingNextPage}
            hasNextPage={hasNextPage}
            fetchNextPage={fetchNextPage}
            columnWidth={300}
            filters={filters}
            render={(props) => <ImageGridItem {...props} />}
          />
        ) : (
          <NoContent mt="lg" message="There are no images that need review" />
        )}
        {!isLoading && hasNextPage && (
          <Group position="center" ref={ref}>
            <Loader />
          </Group>
        )}
      </Stack>
    </Container>
  );
}

function ModerationControls({
  images,
  filters,
  view,
}: {
  images: ImagesInfiniteModel[];
  filters: any;
  view: ImageReviewType | 'reported';
}) {
  const queryUtils = trpc.useContext();
  const viewingReported = view === 'reported';
  const selected = useStore((state) => Object.keys(state.selected).map(Number));
  const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);

  const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
    position: 'bottom',
    withArrow: true,
    withinPortal: true,
  };

  const moderateImagesMutation = trpc.image.moderate.useMutation({
    async onMutate({ ids, needsReview, delete: deleted }) {
      await queryUtils.image.getInfinite.cancel();
      queryUtils.image.getInfinite.setInfiniteData(
        filters,
        produce((data) => {
          if (!data?.pages?.length) return;

          for (const page of data.pages)
            for (const item of page.items) {
              if (ids.includes(item.id)) {
                item.needsReview =
                  deleted === true || needsReview === null ? null : item.needsReview;
              }
            }
        })
      );
    },
    onSuccess(_, input) {
      const actions: string[] = [];
      if (input.delete) actions.push('deleted');
      else if (!input.needsReview) actions.push('approved');
      else if (input.nsfw) actions.push('marked as NSFW');

      showSuccessNotification({ message: `The images have been ${actions.join(', ')}` });
    },
  });

  const reportMutation = trpc.report.bulkUpdateStatus.useMutation({
    async onMutate({ ids, status }) {
      await queryUtils.image.getInfinite.cancel();
      queryUtils.image.getInfinite.setInfiniteData(
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

  const handleDeleteSelected = () => {
    deselectAll();
    moderateImagesMutation.mutate(
      {
        ids: selected,
        delete: true,
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
    queryUtils.image.getInfinite.invalidate(filters);
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
      <ButtonTooltip label="Refresh" {...tooltipProps}>
        <ActionIcon variant="outline" onClick={handleRefresh} color="blue">
          <IconReload size="1.25rem" />
        </ActionIcon>
      </ButtonTooltip>
    </Group>
  );
}

function ImageGridItem({ data: image, width: itemWidth }: ImageGridItemProps) {
  const selected = useStore(useCallback((state) => state.selected[image.id] ?? false, [image.id]));
  const toggleSelected = useStore((state) => state.toggleSelected);

  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = itemWidth > 0 ? itemWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio);
    return Math.min(imageHeight, 600);
  }, [itemWidth, image.width, image.height]);

  const hasReport = !!image.report;
  const pendingReport = hasReport && image.report?.status === 'Pending';

  return (
    <Card
      shadow="sm"
      p="xs"
      sx={{ opacity: !image.needsReview && !pendingReport ? 0.2 : undefined }}
      withBorder
    >
      <Card.Section sx={{ height: `${height}px` }}>
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
        <ImageGuard
          images={[image]}
          render={(image) => (
            <Box
              sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}
              onClick={() => toggleSelected(image.id)}
            >
              <ImageGuard.ToggleImage
                sx={(theme) => ({
                  position: 'absolute',
                  top: theme.spacing.xs,
                  left: theme.spacing.xs,
                  zIndex: 10,
                })}
                position="static"
              />
              <ImageGuard.Unsafe>
                <AspectRatio ratio={(image.width ?? 1) / (image.height ?? 1)}>
                  <MediaHash {...image} />
                </AspectRatio>
              </ImageGuard.Unsafe>
              <ImageGuard.Safe>
                <EdgeMedia
                  src={image.url}
                  name={image.name ?? image.id.toString()}
                  alt={image.name ?? undefined}
                  type={image.type}
                  width={450}
                  placeholder="empty"
                />
                {image.postId && (
                  <Link href={`/posts/${image.postId}`} passHref>
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
                {image.meta && (
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
                )}
              </ImageGuard.Safe>
            </Box>
          )}
        />
      </Card.Section>
      {hasReport && (
        <Stack spacing={8} pt="xs">
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
    </Card>
  );
}

type ImageGridItemProps = {
  data: ImageGetInfinite[number];
  index: number;
  width: number;
};
