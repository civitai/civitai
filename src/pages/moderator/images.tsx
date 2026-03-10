import {
  Anchor,
  AspectRatio,
  Badge,
  Card,
  Center,
  Checkbox,
  Group,
  Indicator,
  Loader,
  Paper,
  Popover,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { Radio, RadioGroup } from '@headlessui/react';
import type { TooltipProps } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconExternalLink,
  IconFilter,
  IconInfoCircle,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconTrash,
  IconUserMinus,
  IconUserOff,
} from '@tabler/icons-react';
import produce from 'immer';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelsGrouped } from '~/components/BrowsingLevel/BrowsingLevelsGrouped';

import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useReportCsamImages } from '~/components/Image/image.utils';
import PromptHighlight from '~/components/Image/PromptHighlight/PromptHighlight';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { RuleDefinitionPopover } from '~/components/Moderation/RuleDefinitionPopover';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { dialogStore } from '~/components/Dialog/dialogStore';
import TosViolationDialog from '~/components/Dialog/Common/TosViolationDialog';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { useInView } from '~/hooks/useInView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { MAX_APPEAL_MESSAGE_LENGTH } from '~/server/common/constants';
import { ModReviewType, NsfwLevel } from '~/server/common/enums';
import { resolveAppealSchema } from '~/server/schema/report.schema';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import type { ImageModerationReviewQueueImage } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { getImageEntityUrl } from '~/utils/moderators/moderator.util';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { getDisplayName, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import clsx from 'clsx';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ReviewTagsInput } from '~/components/Tags/ReviewTagsInput';
import * as z from 'zod';
import { isDefined } from '~/utils/type-guards';

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

export default function Images() {
  // const queryUtils = trpc.useUtils();
  // const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);
  const [type, setType] = useState<ModReviewType>(ModReviewType.Minor);
  const [tagFilters, setTagFilters] = useState({
    filtersOpened: false,
    include: [] as number[],
    exclude: [] as number[],
  });
  const { csamReports, appealReports } = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();

  const viewingReported = type === ModReviewType.Reported;

  const filters = useMemo(
    () => ({
      needsReview: !viewingReported ? type : undefined,
      reportReview: viewingReported ? true : undefined,
      tagIds: tagFilters.include,
      excludedTagIds: tagFilters.exclude,
      browsingLevel,
    }),
    [type, viewingReported, browsingLevel, tagFilters.include, tagFilters.exclude]
  );
  // const { data: nameTags } = trpc.image.getModeratorPOITags.useQuery(undefined, {
  //   enabled: type === 'poi',
  // });
  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    trpc.image.getModeratorReviewQueue.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const handleTypeChange = (value: ModReviewType) => {
    setType(value);
    setTagFilters({ filtersOpened: false, include: [], exclude: [] });
  };

  useEffect(deselectAll, [type, deselectAll]);

  const { data: counts } = trpc.image.getModeratorReviewQueueCounts.useQuery();

  const segments = Object.entries(ModReviewType)
    // filter out csam and appeal if not enabled
    .filter(([, value]) => {
      if (value === ModReviewType.CSAM) return csamReports;
      if (value === ModReviewType.Appeals) return appealReports;
      return true;
    })
    .map(([key, value]) => ({
      value,
      label: getDisplayName(key),
      // label: (
      //   <Indicator label={counts?.[key]} showZero={false} dot={false} offset={-4}>
      //     <span>{value}</span>
      //   </Indicator>
      // ),
    }));

  return (
    <MasonryProvider columnWidth={310} maxColumnCount={7} maxSingleColumnWidth={450}>
      <MasonryContainer py="xl">
        <Stack>
          <Paper
            withBorder
            shadow="lg"
            p="xs"
            style={{
              display: 'inline-flex',
              float: 'right',
              alignSelf: 'flex-end',
              marginRight: 6,
              position: 'sticky',
              top: 'var(--header-height,0)',
              marginBottom: -80,
              zIndex: 30,
            }}
          >
            <ModerationControls
              images={images}
              filters={filters}
              view={type}
              rightSection={
                <Popover
                  width={300}
                  onChange={(opened) =>
                    setTagFilters((prev) => ({ ...prev, filtersOpened: opened }))
                  }
                >
                  <Popover.Target>
                    <Indicator
                      disabled={!tagFilters.include.length && !tagFilters.exclude.length}
                      inline
                    >
                      <LegacyActionIcon
                        radius="xl"
                        variant={tagFilters.filtersOpened ? 'light' : undefined}
                      >
                        <IconFilter size="1.25rem" />
                      </LegacyActionIcon>
                    </Indicator>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <Stack>
                      <ReviewTagsInput
                        label="Include Tags"
                        reviewType={type}
                        defaultValue={tagFilters.include}
                        onChange={(value) => setTagFilters((prev) => ({ ...prev, include: value }))}
                        comboboxProps={{ withinPortal: false }}
                      />
                      <ReviewTagsInput
                        label="Exclude Tags"
                        reviewType={type}
                        defaultValue={tagFilters.exclude}
                        onChange={(value) => setTagFilters((prev) => ({ ...prev, exclude: value }))}
                        comboboxProps={{ withinPortal: false }}
                      />
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
              }
            />
          </Paper>

          <div className="mb-4 flex flex-col items-start">
            <Group>
              <Title order={1}>Images Needing Review</Title>
              {/* <SegmentedControl
                size="sm"
                data={segments}
                onChange={(type) => handleTypeChange(type as ImageReviewType)}
                value={type}
              /> */}
            </Group>
            <Text c="dimmed">
              These are images that have been{' '}
              {viewingReported ? 'reported by users' : 'marked by our AI'} which needs further
              attention from the mods
            </Text>
            <RadioGroup value={type} onChange={handleTypeChange} className="mt-2 flex gap-2">
              {segments.map(({ label, value }) => (
                <RadioInput
                  key={value}
                  value={value}
                  label={label}
                  indicator={counts?.[value] ?? 0}
                />
              ))}
            </RadioGroup>
          </div>

          {/* {type === 'poi' && nameTags && (
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
                    <Text component="span" size="xs" fw={500}>
                      {tag.name}
                    </Text>{' '}
                    <Text component="span" size="xs" c="dimmed" fw={500}>
                      {tag.count}
                    </Text>
                  </Badge>
                );
              }}
              grouped
            />
          )} */}

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
                  <Center p="xl" style={{ height: 36 }} mt="md">
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

  const hasReport = !!image.report;
  const hasAppeal = !!image.appeal;
  const pendingReport = hasReport && image.report?.status === 'Pending';
  const entityUrl = getImageEntityUrl(image);

  const { ref: inViewRef, inView } = useInView();
  const ref = useRef<HTMLElement>(null);
  const mergedRef = useMergedRef(inViewRef, ref);

  return (
    <Card
      shadow="sm"
      withBorder
      ref={mergedRef}
      style={(theme) => ({
        minHeight: height,
        outline: selected
          ? `3px solid ${
              theme.colors[theme.primaryColor][
                typeof theme.primaryShade === 'number'
                  ? theme.primaryShade
                  : theme.primaryShade.dark
              ]
            }`
          : undefined,
        opacity: !image.needsReview && !pendingReport ? 0.2 : undefined,
      })}
    >
      <Card.Section style={{ height: `${height}px` }} className="relative">
        {inView && (
          <>
            <Checkbox
              checked={selected}
              onChange={() => toggleSelected(image.id)}
              size="lg"
              className="absolute right-2 top-2 z-10"
            />

            <ImageGuard2 image={image}>
              {(safe) => (
                <div className="relative h-full" onClick={() => toggleSelected(image.id)}>
                  <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                  {!safe ? (
                    <AspectRatio ratio={(image.width ?? 1) / (image.height ?? 1)}>
                      <MediaHash {...image} />
                    </AspectRatio>
                  ) : (
                    <EdgeMedia
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      alt={image.name ?? undefined}
                      type={image.type}
                      width={450}
                      style={{ height: '100%' }}
                      placeholder="empty"
                    />
                  )}
                </div>
              )}
            </ImageGuard2>
            {!!entityUrl && (
              <LegacyActionIcon
                component={Link}
                href={`${entityUrl}?moderator`}
                variant="transparent"
                style={{ position: 'absolute', bottom: '5px', left: '5px' }}
                size="lg"
                target="_blank"
              >
                <IconExternalLink
                  color="white"
                  filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                  opacity={0.8}
                  strokeWidth={2.5}
                  size={26}
                />
              </LegacyActionIcon>
            )}
            {image.meta ? (
              <ImageMetaPopover meta={image.meta}>
                <LegacyActionIcon
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
                </LegacyActionIcon>
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
      </Card.Section>
      {hasReport && (
        <Stack gap={8} p="xs" style={{ cursor: 'auto', color: 'initial' }}>
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={2}>
              <Text size="xs" c="dimmed" inline>
                Reported by
              </Text>
              <Group gap={4}>
                <Link
                  href={image.report?.user.username ? `/user/${image.report?.user.username}` : '#'}
                  legacyBehavior
                  passHref
                >
                  <Anchor size="xs" target="_blank" lineClamp={1} inline>
                    {image.report?.user.username}
                  </Anchor>
                </Link>
                {(image.report?.count ?? 0) > 1 && (
                  <Badge size="xs" color="red">
                    +{(image.report?.count ?? 0) - 1}
                  </Badge>
                )}
              </Group>
            </Stack>
            <Stack gap={2} align="flex-end">
              <Text size="xs" c="dimmed" inline>
                Reported for
              </Text>
              <Badge size="sm">{splitUppercase(image.report?.reason ?? '')}</Badge>
            </Stack>
          </Group>
          {image.acceptableMinor && (
            <Badge variant="light" color="pink">
              Acceptable Minor
            </Badge>
          )}
          <ContentClamp maxHeight={150}>
            {image.report?.details
              ? Object.entries(image.report.details).map(([key, value]) => (
                  <Text key={key} size="sm">
                    <Text fw="bold" span className="capitalize">
                      {splitUppercase(key)}:
                    </Text>{' '}
                    {value}
                  </Text>
                ))
              : null}
          </ContentClamp>
        </Stack>
      )}
      {image.needsReview === 'minor' && (
        <PromptHighlight prompt={image.meta?.prompt} negativePrompt={image.meta?.negativePrompt}>
          {({ includesInappropriate, html }) =>
            !includesInappropriate ? (
              <></>
            ) : (
              <Stack>
                {image.acceptableMinor && (
                  <Badge variant="light" color="pink">
                    Acceptable Minor
                  </Badge>
                )}
                <Card.Section p="xs" mt={0} style={{ cursor: 'auto', color: 'initial' }}>
                  <RenderHtml className="break-words text-sm leading-[1.2]" html={html} />
                </Card.Section>
              </Stack>
            )
          }
        </PromptHighlight>
      )}
      {image.reviewTags.length > 0 && (
        <Card.Section p="xs" sx={{ cursor: 'auto', color: 'initial' }}>
          <Group gap={4}>
            {image.reviewTags.map((tag) => (
              <Badge key={tag.id} size="sm">
                {tag.name}
              </Badge>
            ))}
          </Group>
        </Card.Section>
      )}
      {/* {image.needsReview === 'poi' && !!image.names?.length && (
          <Card.Section p="xs" sx={{ cursor: 'auto', color: 'initial' }}>
            <Group spacing={4}>
              {image.names.map((name) => (
                <Badge key={name} size="sm">
                  {name}
                </Badge>
              ))}
            </Group>
          </Card.Section>
        )} */}
      {image.needsReview === 'tag' && !!image.tags && (
        <Card.Section p="xs" style={{ cursor: 'auto', color: 'initial' }}>
          <Group gap={4}>
            {image.tags
              .filter((x) => x.nsfwLevel === NsfwLevel.Blocked)
              .map(({ name }) => (
                <Badge key={name} size="sm">
                  {name}
                </Badge>
              ))}
          </Group>
        </Card.Section>
      )}
      {image.needsReview === 'appeal' && hasAppeal && (
        <Card.Section p="xs">
          <Stack gap={8} style={{ cursor: 'auto', color: 'initial' }}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Text size="xs" c="dimmed" inline>
                  Appealed by
                </Text>
                <Link
                  href={image.appeal?.user.username ? `/user/${image.appeal?.user.username}` : '#'}
                  legacyBehavior
                  passHref
                >
                  <Anchor size="xs" target="_blank" lineClamp={1} inline>
                    {image.appeal?.user.username}
                  </Anchor>
                </Link>
              </Stack>
              <Stack gap={2} align="flex-end">
                <Text size="xs" c="dimmed" inline>
                  Created at
                </Text>
                {image.appeal?.createdAt ? (
                  <Text size="xs">{formatDate(image.appeal?.createdAt)}</Text>
                ) : null}
              </Stack>
            </Group>
            {image.appeal?.moderator && (
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed" inline>
                    Moderated by
                  </Text>
                  <Text size="xs" lineClamp={1} inline>
                    {image.appeal?.moderator.username}
                  </Text>
                </Stack>
                <Stack gap={2} align="flex-end">
                  <Text size="xs" c="dimmed" inline>
                    Removed at
                  </Text>
                  {image.removedAt ? <Text size="xs">{formatDate(image.removedAt)}</Text> : null}
                </Stack>
              </Group>
            )}
            {image.tosReason ? (
              <Badge size="sm" color="pink">
                Removed for: {getDisplayName(image.tosReason)}
              </Badge>
            ) : null}
            <ContentClamp maxHeight={150}>
              {image.appeal?.reason ? <Text size="sm">{image.appeal.reason}</Text> : null}
            </ContentClamp>
          </Stack>
        </Card.Section>
      )}
      {image.needsReview === 'modRule' && image.metadata?.ruleReason && (
        <Card.Section p="xs">
          <Stack>
            <Text>{image.metadata.ruleReason}</Text>
            {image.metadata.ruleId && (
              <RuleDefinitionPopover ruleId={image.metadata.ruleId} entityType="Image" />
            )}
          </Stack>
        </Card.Section>
      )}
    </Card>
  );
}

type ImageGridItemProps = {
  data: ImageModerationReviewQueueImage;
  index: number;
  width: number;
  height: number;
};

const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
  position: 'bottom',
  withArrow: true,
  withinPortal: true,
};

function ModerationControls({
  images,
  filters,
  view,
  rightSection,
}: {
  images: ImageModerationReviewQueueImage[];
  filters: MixedObject;
  view: ModReviewType;
  rightSection?: React.ReactNode;
}) {
  const queryUtils = trpc.useUtils();
  const viewingReported = view === ModReviewType.Reported;
  const selected = useStore((state) => Object.keys(state.selected).map(Number));
  const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);
  const router = useRouter();

  const moderateImagesMutation = trpc.image.moderate.useMutation({
    async onMutate({ ids, reviewAction }) {
      await queryUtils.image.getModeratorReviewQueue.cancel();
      queryUtils.image.getModeratorReviewQueue.setInfiniteData(
        filters,
        produce((data) => {
          if (!data?.pages?.length) return;
          for (const page of data.pages)
            for (const item of page.items) {
              if (ids.includes(item.id)) item.needsReview = null;
            }
        })
      );
    },
  });

  const reportCsamImages = useReportCsamImages({
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

  const handleReportCsam = () => {
    if (view === ModReviewType.CSAM) {
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
      reportCsamImages.mutate({ imageIds: selected });
    }
  };

  function handlModerateImage(reviewAction: 'block' | 'unblock') {
    deselectAll();
    moderateImagesMutation.mutate(
      {
        ids: selected,
        reviewAction,
      },
      {
        onSuccess(_, input) {
          showSuccessNotification({ message: `The images have been ${input.reviewAction}ed` });
          if (viewingReported) {
            const selectedReports = images
              .map((x) => (selected.includes(x.id) ? x.report?.id : undefined))
              .filter(isDefined);
            return reportMutation.mutate({
              ids: selectedReports,
              status: input.reviewAction === 'block' ? 'Actioned' : 'Unactioned',
            });
          }
        },
      }
    );
  }

  const handleUnblockSelected = () => handlModerateImage('unblock');

  const handleSelectAll = () => {
    selectMany(images.map((x) => x.id));
    // if (selected.length === images.length) handleClearAll();
    // else selectedHandlers.setState(images.map((x) => x.id));
  };

  const handleClearAll = () => deselectAll();

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
    <div className="flex flex-col items-center gap-2">
      <div className="flex w-full items-center justify-between gap-2">
        <Group wrap="nowrap" gap="xs" justify="center" className="flex-1">
          <ButtonTooltip label="Select all" {...tooltipProps}>
            <LegacyActionIcon
              variant="outline"
              onClick={handleSelectAll}
              disabled={selected.length === images.length}
            >
              <IconSquareCheck size="1.25rem" />
            </LegacyActionIcon>
          </ButtonTooltip>
          <ButtonTooltip label="Clear selection" {...tooltipProps}>
            <LegacyActionIcon
              variant="outline"
              disabled={!selected.length}
              onClick={handleClearAll}
            >
              <IconSquareOff size="1.25rem" />
            </LegacyActionIcon>
          </ButtonTooltip>
          {view === ModReviewType.Appeals ? (
            <AppealActions selected={selected} filters={filters} />
          ) : (
            <PopConfirm
              message={`Are you sure you want to approve ${selected.length} image(s)?`}
              position="bottom-end"
              onConfirm={handleUnblockSelected}
              withArrow
              withinPortal
            >
              <ButtonTooltip label="Accept" {...tooltipProps}>
                <LegacyActionIcon variant="outline" disabled={!selected.length} color="green">
                  <IconCheck size="1.25rem" />
                </LegacyActionIcon>
              </ButtonTooltip>
            </PopConfirm>
          )}

          {view !== ModReviewType.Appeals && (
            <ButtonTooltip label="Delete" {...tooltipProps}>
              <LegacyActionIcon
                variant="outline"
                disabled={!selected.length}
                color="red"
                onClick={() => {
                  dialogStore.trigger({
                    component: TosViolationDialog,
                    props: {
                      title: 'Delete Selected Images',
                      message: `Are you sure you want to delete ${selected.length} image(s)?`,
                      onConfirm: async (violationType, violationDetails) => {
                        deselectAll();
                        moderateImagesMutation.mutate(
                          {
                            ids: selected,
                            reviewAction: 'block',
                            violationType,
                            violationDetails,
                          },
                          {
                            onSuccess() {
                              showSuccessNotification({
                                message: `The images have been blocked`,
                              });
                              if (viewingReported) {
                                const selectedReports = images
                                  .map((x) => (selected.includes(x.id) ? x.report?.id : undefined))
                                  .filter(isDefined);
                                return reportMutation.mutate({
                                  ids: selectedReports,
                                  status: 'Actioned',
                                });
                              }
                            },
                          }
                        );
                      },
                    },
                  });
                }}
              >
                <IconTrash size="1.25rem" />
              </LegacyActionIcon>
            </ButtonTooltip>
          )}

          <ButtonTooltip {...tooltipProps} label="Report CSAM">
            <LegacyActionIcon
              variant="outline"
              disabled={!selected.length}
              onClick={handleReportCsam}
              color="orange"
            >
              <IconAlertTriangle size="1.25rem" />
            </LegacyActionIcon>
          </ButtonTooltip>
          <ButtonTooltip label="Refresh" {...tooltipProps}>
            <LegacyActionIcon variant="outline" onClick={handleRefresh} color="blue">
              <IconReload size="1.25rem" />
            </LegacyActionIcon>
          </ButtonTooltip>
        </Group>
        {rightSection}
      </div>
      <BrowsingLevelsGrouped gap={4} size="xs" />
    </div>
  );
}

function AppealActions({ selected, filters }: { selected: number[]; filters: MixedObject }) {
  const queryUtils = trpc.useUtils();
  const deselectAll = useStore((state) => state.deselectAll);

  const [resolvedMessage, setResolvedMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const resolveAppealMutation = trpc.report.resolveAppeal.useMutation({
    async onMutate({ ids }) {
      await queryUtils.image.getModeratorReviewQueue.cancel();
      queryUtils.image.getModeratorReviewQueue.setInfiniteData(
        filters,
        produce((data) => {
          if (!data?.pages?.length) return;

          for (const page of data.pages)
            for (const item of page.items) {
              if (ids.includes(item.id)) {
                item.needsReview = null;
              }
            }
        })
      );
    },
    onSuccess: (_, { status }) => {
      showSuccessNotification({ message: `The images have been ${status.toLowerCase()}` });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to resolve appeal',
        error: new Error(error.message),
      });
    },
  });

  const handleResolveAppeal = (status: AppealStatus) => {
    deselectAll();
    resolveAppealMutation.mutate({
      ids: selected,
      status,
      entityType: EntityType.Image,
      resolvedMessage,
    });
  };

  const handleResolvedMessageChange = (message: string) => {
    const result = resolveAppealSchema.pick({ resolvedMessage: true }).safeParse({
      resolvedMessage,
    });
    if (!result.success) {
      setError(z.prettifyError(result.error) ?? 'Invalid resolved message');
    } else {
      setError('');
    }

    setResolvedMessage(message);
  };

  return (
    <>
      <PopConfirm
        message={
          <ConfirmResolvedAppeal
            status={AppealStatus.Approved}
            onChange={handleResolvedMessageChange}
            itemCount={selected.length}
            error={error}
          />
        }
        position="bottom-end"
        onConfirm={() => handleResolveAppeal(AppealStatus.Approved)}
        onCancel={() => setResolvedMessage('')}
        withArrow
        withinPortal
      >
        <ButtonTooltip label="Approve" {...tooltipProps}>
          <LegacyActionIcon variant="outline" disabled={!selected.length} color="green">
            <IconCheck size="1.25rem" />
          </LegacyActionIcon>
        </ButtonTooltip>
      </PopConfirm>
      <PopConfirm
        message={
          <ConfirmResolvedAppeal
            status={AppealStatus.Rejected}
            onChange={handleResolvedMessageChange}
            itemCount={selected.length}
            error={error}
          />
        }
        position="bottom-end"
        onConfirm={() => handleResolveAppeal(AppealStatus.Rejected)}
        onCancel={() => setResolvedMessage('')}
        withArrow
        withinPortal
      >
        <ButtonTooltip label="Reject" {...tooltipProps}>
          <LegacyActionIcon variant="outline" disabled={!selected.length} color="red">
            <IconBan size="1.25rem" />
          </LegacyActionIcon>
        </ButtonTooltip>
      </PopConfirm>
    </>
  );
}

function ConfirmResolvedAppeal({
  status,
  onChange,
  itemCount,
  error,
}: {
  status: AppealStatus;
  onChange: (message: string) => void;
  itemCount?: number;
  error?: string;
}) {
  return (
    <Stack gap="xs">
      <Text size="sm">
        Are you sure you want to {status === AppealStatus.Approved ? 'approve' : 'reject'}{' '}
        {itemCount} image(s)?
      </Text>
      <Textarea
        label="Resolved message"
        description="This message will be sent to the user who appealed the image"
        error={error}
        onChange={(e) => onChange(e.currentTarget.value)}
        minRows={2}
        maxRows={5}
        maxLength={MAX_APPEAL_MESSAGE_LENGTH}
        autosize
      />
    </Stack>
  );
}

function RadioInput({
  value,
  label,
  disabled,
  indicator,
}: {
  value: any;
  label: React.ReactNode;
  disabled?: boolean;
  indicator?: number;
}) {
  return (
    <Indicator label={indicator ?? 0} size={16} zIndex={10} color="red" disabled={!indicator}>
      <Radio
        value={value}
        disabled={disabled}
        className={clsx(
          !disabled ? 'cursor-pointer focus:outline-none' : 'cursor-not-allowed opacity-25',
          'flex flex-1 items-center justify-center rounded-md  p-2 text-sm font-semibold ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
          'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
          'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
        )}
      >
        {label}
      </Radio>
    </Indicator>
  );
}
