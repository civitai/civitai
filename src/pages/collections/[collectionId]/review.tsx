import {
  ActionIcon,
  Badge,
  Box,
  Center,
  Checkbox,
  Chip,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { TooltipProps } from '@mantine/core/lib/Tooltip/Tooltip';
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
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { CollectionItemStatus, CollectionType } from '@prisma/client';
import { CollectionItemExpanded } from '~/server/services/collection.service';
import { useRouter } from 'next/router';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { FeedCard } from '~/components/Cards/FeedCard';
import { getCollectionItemReviewData } from '~/components/Collections/collection.utils';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import Link from 'next/link';
import { BackButton } from '~/components/BackButton/BackButton';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { formatDate } from '~/utils/date-helpers';

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

const ReviewCollection = () => {
  const router = useRouter();
  const { collectionId: collectionIdString } = router.query;
  const collectionId = Number(collectionIdString);

  // const queryUtils = trpc.useContext();
  // const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);
  const [statuses, setStatuses] = useState<CollectionItemStatus[]>([CollectionItemStatus.REVIEW]);

  const filters = useMemo(
    () => ({
      collectionId: collectionId,
      statuses,
      forReview: true,
    }),
    [collectionId, statuses]
  );
  const { data, isLoading, isRefetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.collection.getAllCollectionItems.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  const collectionItems = useMemo(
    () => data?.pages.flatMap((x) => x.collectionItems) ?? [],
    [data?.pages]
  );

  const handleStatusToggle = (value: string[]) => {
    setStatuses(value as CollectionItemStatus[]);
    deselectAll();
  };

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
            marginBottom: -60,
            zIndex: 1000,
          }}
        >
          <ModerationControls collectionItems={collectionItems} filters={filters} />
        </Paper>

        <Stack spacing="sm" mb="lg">
          <Group spacing="xs">
            <BackButton url={`/collections/${collectionId}`} />
            <Title order={1}>Collection items that need review</Title>
          </Group>
          <Text color="dimmed">
            You are reviewing items on the collection that are either pending review or have been
            rejected. You can change the status of these to be accepted or rejected.
          </Text>
          <Group>
            <Chip.Group value={statuses} onChange={handleStatusToggle} multiple>
              <Chip value={CollectionItemStatus.REVIEW}>Review</Chip>
              <Chip value={CollectionItemStatus.REJECTED}>Rejected</Chip>
              <Chip value={CollectionItemStatus.ACCEPTED}>Accepted</Chip>
            </Chip.Group>
          </Group>
        </Stack>

        {isLoading ? (
          <Center py="xl">
            <Loader size="xl" />
          </Center>
        ) : collectionItems.length ? (
          <MasonryGrid2
            data={collectionItems}
            isRefetching={isRefetching}
            isFetchingNextPage={isFetchingNextPage}
            hasNextPage={hasNextPage}
            fetchNextPage={fetchNextPage}
            columnWidth={300}
            filters={filters}
            render={(props) => {
              return <CollectionItemGridItem {...props} />;
            }}
          />
        ) : (
          <NoContent mt="lg" message="There are no images that need review" />
        )}
      </Stack>
    </Container>
  );
};

export default ReviewCollection;

const CollectionItemGridItem = ({ data: collectionItem }: CollectionItemGridItemProps) => {
  const router = useRouter();
  const selected = useStore(
    useCallback((state) => state.selected[collectionItem.id] ?? false, [collectionItem.id])
  );
  const toggleSelected = useStore((state) => state.toggleSelected);
  const { classes: sharedClasses, cx } = useCardStyles({ aspectRatio: 1 });
  const reviewData = getCollectionItemReviewData(collectionItem);
  const badgeColor = {
    [CollectionItemStatus.ACCEPTED]: 'green',
    [CollectionItemStatus.REJECTED]: 'red',
    [CollectionItemStatus.REVIEW]: 'yellow',
  };

  return (
    <FeedCard>
      <Box className={sharedClasses.root} onClick={() => toggleSelected(collectionItem.id)}>
        <Stack
          sx={{
            position: 'absolute',
            top: 5,
            right: 5,
            zIndex: 11,
          }}
        >
          <Group>
            {reviewData.url && (
              <Link href={reviewData.url} passHref>
                <ActionIcon
                  component="a"
                  variant="transparent"
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
            <Checkbox checked={selected} readOnly size="lg" />
          </Group>
          {reviewData.baseModel && <Badge variant="filled">{reviewData.baseModel}</Badge>}
        </Stack>
        {reviewData.image && (
          <ImageGuard
            images={[reviewData.image]}
            connect={{ entityId: collectionItem.id, entityType: 'collectionItem' }}
            render={(image) => (
              <ImageGuard.Content>
                {({ safe }) => {
                  // Small hack to prevent blurry landscape images
                  const originalAspectRatio =
                    image.width && image.height ? image.width / image.height : 1;
                  return (
                    <>
                      <Group
                        spacing={4}
                        position="apart"
                        className={cx(sharedClasses.contentOverlay, sharedClasses.top)}
                        noWrap
                      >
                        <Group spacing={4}>
                          <ImageGuard.ToggleConnect position="static" />
                          {collectionItem.status && (
                            <Badge variant="filled" color={badgeColor[collectionItem.status]}>
                              {collectionItem.status}
                            </Badge>
                          )}
                        </Group>
                      </Group>
                      {safe ? (
                        <EdgeMedia
                          src={image.url ?? ''}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          type={image.type}
                          width={
                            originalAspectRatio > 1
                              ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
                              : DEFAULT_EDGE_IMAGE_WIDTH
                          }
                          placeholder="empty"
                          className={sharedClasses.image}
                          loading="lazy"
                        />
                      ) : (
                        <MediaHash {...image} />
                      )}
                      {reviewData.meta && (
                        <ImageMetaPopover
                          meta={reviewData.meta as ImageMetaProps}
                          generationProcess={reviewData.meta.generationProcess ?? 'txt2img'}
                        >
                          <ActionIcon
                            variant="transparent"
                            style={{
                              position: 'absolute',
                              bottom: '5px',
                              right: '5px',
                              zIndex: 999,
                            }}
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
                    </>
                  );
                }}
              </ImageGuard.Content>
            )}
          />
        )}
        {reviewData.cover && (
          <>
            <Group
              spacing={4}
              position="apart"
              className={cx(sharedClasses.contentOverlay, sharedClasses.top)}
              noWrap
            >
              <Group spacing={4}>
                {collectionItem.status && (
                  <Badge variant="filled" color={badgeColor[collectionItem.status]}>
                    {collectionItem.status}
                  </Badge>
                )}
              </Group>
            </Group>
            <EdgeMedia
              placeholder="empty"
              className={sharedClasses.image}
              loading="lazy"
              width={DEFAULT_EDGE_IMAGE_WIDTH}
              src={reviewData.cover}
            />
          </>
        )}
        <Stack
          className={cx(
            sharedClasses.contentOverlay,
            sharedClasses.bottom,
            sharedClasses.gradientOverlay
          )}
          spacing="sm"
        >
          {reviewData.title && (
            <Text size="xl" weight={700} lineClamp={2} inline>
              {reviewData.title}
            </Text>
          )}
          {reviewData.user && reviewData.user.id !== -1 && (
            <UnstyledButton
              sx={{ color: 'white' }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();

                router.push(`/user/${reviewData.user?.username}`);
              }}
            >
              <UserAvatar
                user={reviewData.user}
                avatarProps={{ radius: 'md', size: 32 }}
                subText={
                  reviewData.createdAt ? (
                    <Text size="sm">Added to collection: {formatDate(reviewData.createdAt)}</Text>
                  ) : undefined
                }
              />
            </UnstyledButton>
          )}
        </Stack>
      </Box>
    </FeedCard>
  );
};

type CollectionItemGridItemProps = {
  data: CollectionItemExpanded;
  index: number;
  width: number;
};

function ModerationControls({
  collectionItems,
  filters,
}: {
  collectionItems: CollectionItemExpanded[];
  filters: { collectionId: number; statuses: CollectionItemStatus[]; forReview: boolean };
}) {
  const queryUtils = trpc.useContext();
  const selected = useStore((state) => Object.keys(state.selected).map(Number));
  const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);

  const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
    position: 'bottom',
    withArrow: true,
    withinPortal: true,
  };

  const updateCollectionItemsStatusMutation =
    trpc.collection.updateCollectionItemsStatus.useMutation({
      async onMutate({ collectionItemIds, status }) {
        await queryUtils.collection.getAllCollectionItems.cancel();

        queryUtils.collection.getAllCollectionItems.setInfiniteData(
          filters,
          produce((data) => {
            if (!data?.pages?.length) return;

            for (const page of data.pages)
              for (const item of page.collectionItems) {
                if (collectionItemIds.includes(item.id)) {
                  item.status = status;
                }
              }
          })
        );
      },
      onSuccess() {
        showSuccessNotification({ message: `The items have been reviewed` });
      },
    });

  const handleRejectSelected = () => {
    deselectAll();
    updateCollectionItemsStatusMutation.mutate({
      collectionItemIds: selected,
      status: CollectionItemStatus.REJECTED,
      collectionId: filters.collectionId,
    });
  };

  const handleSelectAll = () => {
    selectMany(collectionItems.map((x) => x.id));
  };

  const handleClearAll = () => deselectAll();

  const handleApproveSelected = () => {
    deselectAll();
    updateCollectionItemsStatusMutation.mutate(
      {
        collectionItemIds: selected,
        status: CollectionItemStatus.ACCEPTED,
        collectionId: filters.collectionId,
      },
      {
        onSuccess: async ({ type }) => {
          switch (type) {
            case CollectionType.Model:
              await queryUtils.model.getAll.invalidate();
              break;
            case CollectionType.Image:
              await queryUtils.image.getInfinite.invalidate();
              break;
            case CollectionType.Post:
              await queryUtils.post.getInfinite.invalidate();
              break;
            case CollectionType.Article:
              await queryUtils.article.getInfinite.invalidate();
              break;
            default:
              break;
          }
        },
      }
    );
  };

  const handleRefresh = () => {
    handleClearAll();
    queryUtils.collection.getAllCollectionItems.invalidate(filters);
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
          disabled={selected.length === collectionItems.length}
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
        message={`Are you sure you want to reject ${selected.length} image(s)?`}
        position="bottom-end"
        onConfirm={handleRejectSelected}
        withArrow
      >
        <ButtonTooltip label="Reject" {...tooltipProps}>
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
