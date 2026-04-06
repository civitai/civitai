import {
  Badge,
  Center,
  Checkbox,
  Chip,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import type { TooltipProps } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import {
  IconCheck,
  IconExternalLink,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconTrash,
} from '@tabler/icons-react';
import produce from 'immer';
import React, { useCallback, useMemo, useState, createContext, useContext } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { NoContent } from '~/components/NoContent/NoContent';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { CollectionItemStatus, CollectionMode, CollectionType } from '~/shared/utils/prisma/enums';
import type { CollectionItemExpanded } from '~/server/services/collection.service';
import { useRouter } from 'next/router';
import cardClasses from '~/components/Cards/Cards.module.css';
import {
  getCollectionItemReviewData,
  useCollection,
} from '~/components/Collections/collection.utils';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { BackButton } from '~/components/BackButton/BackButton';
import { formatDate } from '~/utils/date-helpers';
import { CollectionReviewSort } from '~/server/common/enums';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CollectionCategorySelect } from '~/components/Collections/components/CollectionCategorySelect';
import type { GetAllCollectionItemsSchema } from '~/server/schema/collection.schema';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { CollectionItemNSFWLevelSelector } from '~/components/Collections/components/ContestCollections/CollectionItemNSFWLevelSelector';
import { ContestCollectionItemScorer } from '~/components/Collections/components/ContestCollections/ContestCollectionItemScorer';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { DurationBadge } from '~/components/DurationBadge/DurationBadge';
import clsx from 'clsx';

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

const ReviewCollectionContext = createContext<GetAllCollectionItemsSchema | null>(null);

export function useReviewCollectionContext() {
  const context = useContext(ReviewCollectionContext);
  return context;
}

const ReviewCollection = () => {
  const router = useRouter();
  const { collectionId: collectionIdString } = router.query;
  const collectionId = Number(collectionIdString);

  const deselectAll = useStore((state) => state.deselectAll);
  const [statuses, setStatuses] = useState<CollectionItemStatus[]>([CollectionItemStatus.REVIEW]);
  const [sort, setSort] = useState<CollectionReviewSort>(CollectionReviewSort.Newest);
  const [collectionTagId, setCollectionTagId] = useState<number | undefined>(undefined);

  const filters = useMemo(
    () => ({
      collectionId,
      statuses,
      forReview: true,
      reviewSort: sort,
      collectionTagId,
      browsingLevel: allBrowsingLevelsFlag,
    }),
    [collectionId, statuses, sort, collectionTagId]
  );

  const { collection, permissions, isLoading: loadingCollection } = useCollection(collectionId);

  const { data, isLoading, isFetching, fetchNextPage, hasNextPage } =
    trpc.collection.getAllCollectionItems.useInfiniteQuery(filters, {
      enabled: !!collection,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  const collectionItems = useMemo(
    () =>
      !collection || !data
        ? []
        : data?.pages.flatMap((x) =>
            x.collectionItems.map((collectionItem) => ({
              ...collectionItem,
              collectionId: collection.id,
              statuses,
            }))
          ),
    [data?.pages, statuses]
  );

  const handleStatusToggle = (value: string[]) => {
    setStatuses(value as CollectionItemStatus[]);
    deselectAll();
  };

  if (loadingCollection) return <PageLoader />;
  if ((!loadingCollection && !collection) || (permissions && !permissions.manage))
    return <NotFound />;

  const isContestCollection = collection?.mode === CollectionMode.Contest;

  return (
    <ReviewCollectionContext.Provider value={filters}>
      <MasonryProvider maxColumnCount={4}>
        <MasonryContainer>
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
                marginBottom: -60,
                zIndex: 1000,
              }}
            >
              <ModerationControls collectionItems={collectionItems} filters={filters} />
            </Paper>

            <Stack gap="sm" mb="lg">
              <Group gap="xs">
                <BackButton url={`/collections/${collectionId}`} />
                <Title order={1}>Collection items that need review</Title>
              </Group>
              <Text c="dimmed">
                You are reviewing items on the collection that are either pending review or have
                been rejected. You can change the status of these to be accepted or rejected.
              </Text>
              {isContestCollection && collection.tags.length > 0 && (
                <CollectionCategorySelect
                  collectionId={collection.id}
                  value={collectionTagId?.toString() ?? 'all'}
                  onChange={(x) =>
                    setCollectionTagId(x && x !== 'all' ? parseInt(x, 10) : undefined)
                  }
                />
              )}
              <Group justify="space-between">
                <Chip.Group value={statuses} onChange={handleStatusToggle} multiple>
                  <Group gap="xs">
                    <Chip value={CollectionItemStatus.REVIEW}>
                      <span>Review</span>
                    </Chip>
                    <Chip value={CollectionItemStatus.REJECTED}>
                      <span>Rejected</span>
                    </Chip>
                    <Chip value={CollectionItemStatus.ACCEPTED}>
                      <span>Accepted</span>
                    </Chip>
                  </Group>
                </Chip.Group>

                <SelectMenuV2
                  label="Sort by"
                  options={Object.values(CollectionReviewSort).map((v) => ({ label: v, value: v }))}
                  value={sort}
                  onClick={(x) => setSort(x as CollectionReviewSort)}
                />
              </Group>
            </Stack>
            {isLoading ? (
              <Center py="xl">
                <Loader size="xl" />
              </Center>
            ) : (
              <div className="relative">
                <MasonryGrid
                  data={collectionItems}
                  empty={<NoContent mt="lg" message="There are no images that need review" />}
                  render={CollectionItemGridItem}
                  withAds={false}
                />
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isFetching}
                    style={{ gridColumn: '1/-1' }}
                  >
                    <Center p="xl" style={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
                {!hasNextPage && collectionItems.length > 0 && <EndOfFeed />}
              </div>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </ReviewCollectionContext.Provider>
  );
};

export default ReviewCollection;

const CollectionItemGridItem = ({ data: collectionItem }: CollectionItemGridItemProps) => {
  const { collectionId, statuses } = collectionItem;
  const currentUser = useCurrentUser();
  const router = useRouter();
  const selected = useStore(
    useCallback((state) => state.selected[collectionItem.id] ?? false, [collectionItem.id])
  );
  const toggleSelected = useStore((state) => state.toggleSelected);
  const reviewData = getCollectionItemReviewData(collectionItem);
  const badgeColor = {
    [CollectionItemStatus.ACCEPTED]: 'green',
    [CollectionItemStatus.REJECTED]: 'red',
    [CollectionItemStatus.REVIEW]: 'yellow',
  };
  const reviewCollectionContext = useReviewCollectionContext();
  const { collection } = useCollection(collectionId);

  const queryUtils = trpc.useUtils();

  const image = reviewData.image;

  return (
    <div className="flex flex-col">
      <CollectionItemNSFWLevelSelector
        collectionId={collectionId}
        collectionItemId={collectionItem.id}
        nsfwLevel={image?.nsfwLevel}
        onNsfwLevelUpdated={(value) => {
          if (reviewCollectionContext) {
            queryUtils.collection.getAllCollectionItems.setInfiniteData(
              { ...reviewCollectionContext },
              produce((data) => {
                if (!data?.pages?.length) return;

                for (const page of data.pages)
                  for (const item of page.collectionItems) {
                    if (item.id === collectionItem.id && item?.type === 'image') {
                      item.data.nsfwLevel = parseInt(value, 10);
                    }
                  }
              })
            );
          }
        }}
      />
      <AspectRatioImageCard
        onClick={() => toggleSelected(collectionItem.id)}
        className={clsx({
          ['opacity-60']:
            selected || (collectionItem.status && !statuses.includes(collectionItem.status)),
        })}
        image={image}
        header={
          <div className="flex w-full items-start justify-between">
            <div className="flex gap-1">
              {collectionItem.status && (
                <Badge
                  variant="filled"
                  color={badgeColor[collectionItem.status]}
                  h={26}
                  radius="xl"
                >
                  {collectionItem.status}
                </Badge>
              )}
              {image?.type === 'video' && image.metadata && 'duration' in image.metadata && (
                <DurationBadge duration={image.metadata.duration ?? 0} h={26} radius="xl" />
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <div>
                {reviewData.url && (
                  <Link href={reviewData.url} passHref legacyBehavior>
                    <LegacyActionIcon
                      component="a"
                      variant="transparent"
                      size="lg"
                      target="_blank"
                      onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
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
                    </LegacyActionIcon>
                  </Link>
                )}
                <Checkbox checked={selected} readOnly size="lg" />
              </div>
              {reviewData.baseModel && <Badge variant="filled">{reviewData.baseModel}</Badge>}
            </div>
          </div>
        }
        footer={
          <div className="flex flex-col gap-1">
            {reviewData.title && (
              <Text className={cardClasses.dropShadow} size="xl" fw={700} lineClamp={2} inline>
                {reviewData.title}
              </Text>
            )}
            {reviewData.user && reviewData.user.id !== -1 && (
              <UnstyledButton
                className="text-white"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.preventDefault();
                  e.stopPropagation();

                  router.push(`/user/${reviewData.user?.username}`);
                }}
              >
                <UserAvatar
                  withUsername
                  user={reviewData.user}
                  avatarProps={{ radius: 'md', size: 32 }}
                  subText={
                    reviewData.itemAddedAt ? (
                      <>
                        <Text size="sm">
                          Added to collection: {formatDate(reviewData.itemAddedAt)}
                        </Text>
                        {reviewData.dataCreatedAt && (
                          <Text size="sm">Created: {formatDate(reviewData.dataCreatedAt)}</Text>
                        )}
                      </>
                    ) : undefined
                  }
                />
              </UnstyledButton>
            )}
          </div>
        }
      />
      {collection?.metadata?.judgesCanScoreEntries && (
        <ContestCollectionItemScorer
          layout="minimal"
          collectionItemId={collectionItem.id}
          // onScoreChanged={handleScoreUpdated}
          currentScore={collectionItem.scores?.find((s) => s.userId === currentUser?.id)?.score}
        />
      )}
    </div>
  );
};

type CollectionItemGridItemProps = {
  data: CollectionItemExpanded & { collectionId: number; statuses: CollectionItemStatus[] };
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
  const queryUtils = trpc.useUtils();
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
          { ...filters },
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
      onError(error) {
        showNotification({
          id: 'error',
          title: 'Error',
          message: error.message,
          color: 'red',
        });
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
          queryUtils.collection.getAllCollectionItems.invalidate(filters);
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
    <Group wrap="nowrap" gap="xs">
      <ButtonTooltip label="Select all" {...tooltipProps}>
        <LegacyActionIcon
          variant="outline"
          onClick={handleSelectAll}
          disabled={selected.length === collectionItems.length}
        >
          <IconSquareCheck size="1.25rem" />
        </LegacyActionIcon>
      </ButtonTooltip>
      <ButtonTooltip label="Clear selection" {...tooltipProps}>
        <LegacyActionIcon variant="outline" disabled={!selected.length} onClick={handleClearAll}>
          <IconSquareOff size="1.25rem" />
        </LegacyActionIcon>
      </ButtonTooltip>
      <PopConfirm
        message={`Are you sure you want to approve ${selected.length} image(s)?`}
        position="bottom-end"
        onConfirm={handleApproveSelected}
        withArrow
      >
        <ButtonTooltip label="Accept" {...tooltipProps}>
          <LegacyActionIcon variant="outline" disabled={!selected.length} color="green">
            <IconCheck size="1.25rem" />
          </LegacyActionIcon>
        </ButtonTooltip>
      </PopConfirm>
      <PopConfirm
        message={`Are you sure you want to reject ${selected.length} image(s)?`}
        position="bottom-end"
        onConfirm={handleRejectSelected}
        withArrow
      >
        <ButtonTooltip label="Reject" {...tooltipProps}>
          <LegacyActionIcon variant="outline" disabled={!selected.length} color="red">
            <IconTrash size="1.25rem" />
          </LegacyActionIcon>
        </ButtonTooltip>
      </PopConfirm>
      <ButtonTooltip label="Refresh" {...tooltipProps}>
        <LegacyActionIcon variant="outline" onClick={handleRefresh} color="blue">
          <IconReload size="1.25rem" />
        </LegacyActionIcon>
      </ButtonTooltip>
    </Group>
  );
}
