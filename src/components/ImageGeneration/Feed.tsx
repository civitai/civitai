import {
  ActionIcon,
  Autocomplete,
  Card,
  Center,
  Group,
  Loader,
  Overlay,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  Transition,
  createStyles,
  HoverCard,
  TooltipProps,
  LoadingOverlay,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconCloudUpload,
  IconFilter,
  IconLayoutGrid,
  IconLayoutList,
  IconSearch,
  IconSortDescending2,
  IconSquareOff,
  IconTrash,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { useState, useEffect } from 'react';
import { useInView } from 'react-intersection-observer';

import { CreateVariantsModal } from '~/components/ImageGeneration/CreateVariantsModal';
import { FeedItem } from '~/components/ImageGeneration/FeedItem';
import {
  useDeleteGenerationRequestImages,
  useGetGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { constants } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';

type State = {
  layout: 'list' | 'grid';
  selectedItems: number[];
  variantModalOpened: boolean;
};

/**
 * TODO.generation:
 * - add search by prompt
 * - add sort by
 * - add filter by
 * - add toggle layout
 * - add infinite scroll
 * - handle variant generation
 * - handle post images
 */
export function Feed({
  requests,
  images: feed,
  isLoading,
  fetchNextPage,
  hasNextPage,
  isRefetching,
  isFetching,
  isError,
}: ReturnType<typeof useGetGenerationRequests>) {
  const { ref, inView } = useInView();
  const [state, setState] = useState<State>({
    layout: 'grid',
    selectedItems: [],
    variantModalOpened: false,
  });

  const bulkDeleteImagesMutation = useDeleteGenerationRequestImages({
    onSuccess: () => {
      setState((current) => ({ ...current, selectedItems: [] }));
    },
  });

  const handleDeleteImages = () => {
    openConfirmModal({
      title: 'Delete images',
      children:
        'Are you sure that you want to delete the selected images? This is a destructive action and cannot be undone.',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete them' },
      confirmProps: { color: 'red' },
      onConfirm: () => bulkDeleteImagesMutation.mutate({ ids: state.selectedItems }),
      zIndex: constants.imageGeneration.drawerZIndex + 2,
      centered: true,
    });
  };

  // infinite paging
  useEffect(() => {
    if (inView && !isFetching && !isError) fetchNextPage?.();
  }, [fetchNextPage, inView, isFetching, isError]);

  const { classes } = useStyles();

  return (
    <Stack sx={{ position: 'relative', height: '100%' }} spacing={0}>
      <div className={classes.searchPanel}>
        <HoverCard withArrow>
          <HoverCard.Target>
            <Overlay blur={1} opacity={0.3} color="#000" />
          </HoverCard.Target>
          <HoverCard.Dropdown maw={300}>
            <Text weight={500}>Coming soon!</Text>
            <Text size="xs">
              Search through your generated images by prompt, sort them, filter them by resources
              used, or switch your layout.
            </Text>
          </HoverCard.Dropdown>
        </HoverCard>
        <Card withBorder shadow="xl" p={0}>
          <Group spacing="xs">
            <Autocomplete
              placeholder="Search by prompt"
              // TODO.generation: add search by prompt
              data={[]}
              icon={<IconSearch size={14} />}
              sx={{ flex: 1 }}
              styles={{
                input: {
                  border: 0,
                },
              }}
            />
            <Group spacing={4} pr="md">
              <Tooltip label="Sort items">
                <ActionIcon size="xs">
                  <IconSortDescending2 />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Toggle filter toolbar">
                <ActionIcon size="xs">
                  <IconFilter />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={state.layout === 'grid' ? 'List layout' : 'Grid layout'}>
                <ActionIcon
                  size="xs"
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      layout: current.layout === 'grid' ? 'list' : 'grid',
                    }))
                  }
                >
                  {state.layout === 'grid' ? <IconLayoutList /> : <IconLayoutGrid />}
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        </Card>
      </div>
      <ScrollArea sx={{ flex: 1, marginRight: -16, paddingRight: 16 }}>
        <div className={classes.grid}>
          {feed
            .map((image) => {
              const selected = state.selectedItems.includes(image.id);
              const request = requests.find((request) =>
                request.images?.some((x) => x.id === image.id)
              );

              if (!request) return null;

              return (
                <FeedItem
                  key={image.id}
                  image={image}
                  request={request}
                  selected={selected}
                  onCheckboxClick={({ image, checked }) => {
                    if (checked) {
                      setState((current) => ({
                        ...current,
                        selectedItems: [...current.selectedItems, image.id],
                      }));
                    } else {
                      setState((current) => ({
                        ...current,
                        selectedItems: current.selectedItems.filter((id) => id !== image.id),
                      }));
                    }
                  }}
                  onCreateVariantClick={(image) =>
                    setState((current) => ({
                      ...current,
                      variantModalOpened: true,
                      selectedItems: [image.id],
                    }))
                  }
                />
              );
            })
            .filter(isDefined)}
          {hasNextPage && !isLoading && !isRefetching && (
            <Center p="xl" ref={ref} sx={{ height: 36, gridColumn: '1/-1' }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
        </div>
      </ScrollArea>
      <FloatingActions
        selectCount={state.selectedItems.length}
        onDeselectClick={() =>
          setState((current) => ({
            ...current,
            selectedItems: [],
          }))
        }
        onDeleteClick={handleDeleteImages}
        onPostClick={() => console.log('post images')}
        onUpscaleClick={() => console.log('upscale images')}
        loading={bulkDeleteImagesMutation.isLoading}
      />
      <CreateVariantsModal
        opened={state.variantModalOpened}
        onClose={() =>
          setState((current) => ({ ...current, variantModalOpened: false, selectedItems: [] }))
        }
      />
    </Stack>
  );
}

const tooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
  withinPortal: true,
  withArrow: true,
  color: 'dark',
  zIndex: constants.imageGeneration.drawerZIndex + 1,
};

function FloatingActions({
  selectCount,
  onDeselectClick,
  onDeleteClick,
  loading = false,
}: FloatingActionsProps) {
  return (
    <Transition mounted={selectCount > 0} transition="slide-up">
      {(transitionStyles) => (
        <Card
          p={4}
          radius="sm"
          shadow="xl"
          style={transitionStyles}
          sx={{ position: 'absolute', bottom: 8, left: 8, zIndex: 3 }}
          withBorder
        >
          <LoadingOverlay visible={loading} loaderProps={{ variant: 'bars', size: 'sm' }} />
          <Stack spacing={6}>
            <Text color="dimmed" size="xs" weight={500} inline>
              {selectCount} selected
            </Text>
            <Group spacing={4}>
              <Tooltip label="Deselect all" {...tooltipProps}>
                <ActionIcon size="md" onClick={onDeselectClick} variant="light">
                  <IconSquareOff size={20} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Delete selected" {...tooltipProps}>
                <ActionIcon size="md" onClick={onDeleteClick} color="red">
                  <IconTrash size={20} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Post images" {...tooltipProps}>
                <span>
                  <ActionIcon size="md" variant="light" disabled>
                    <IconCloudUpload size={20} />
                  </ActionIcon>
                </span>
              </Tooltip>
              <Tooltip label="Upscale images" {...tooltipProps}>
                <span>
                  <ActionIcon size="md" variant="light" disabled>
                    <IconWindowMaximize size={20} />
                  </ActionIcon>
                </span>
              </Tooltip>
            </Group>
          </Stack>
        </Card>
      )}
    </Transition>
  );
}

type FloatingActionsProps = {
  selectCount: number;
  onDeselectClick: () => void;
  onPostClick: () => void;
  onUpscaleClick: () => void;
  onDeleteClick: () => void;
  loading?: boolean;
};

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
    gap: theme.spacing.md,
    paddingTop: 4 + 36 + theme.spacing.xs,
    paddingBottom: theme.spacing.md,

    [`@media(max-width: ${theme.breakpoints.xs}px)`]: {
      gridTemplateColumns: '1fr 1fr',
    },
  },
  searchPanel: {
    position: 'absolute',
    top: 4,
    zIndex: 10,
    marginLeft: -4,
    marginRight: -4,
    width: 'calc(100% + 8px)',
  },
}));
