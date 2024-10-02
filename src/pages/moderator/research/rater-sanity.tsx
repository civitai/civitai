import {
  ActionIcon,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Loader,
  Paper,
  Popover,
  SegmentedControl,
  Stack,
  Textarea,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { TooltipProps } from '@mantine/core/lib/Tooltip/Tooltip';
import {
  IconExternalLink,
  IconPlus,
  IconSquareCheck,
  IconSquareOff,
  IconTrash,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { useMergedRef } from '@mantine/hooks';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { useInView } from '~/hooks/useInView';
import { NsfwLevel } from '~/server/common/enums';
import { SanityImage } from '~/server/routers/research.router';
import { getImageEntityUrl } from '~/utils/moderators/moderator.util';
import { trpc } from '~/utils/trpc';

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

export default function RaterSanity() {
  const { data: images, isLoading } = trpc.research.raterGetSanityImages.useQuery(undefined, {
    keepPreviousData: true,
  });
  const [nsfwLevel, setNsfwLevel] = useState<NsfwLevel>(NsfwLevel.PG);

  return (
    <MasonryProvider columnWidth={310} maxColumnCount={7} maxSingleColumnWidth={450}>
      <MasonryContainer py="xl">
        <Stack>
          {images && (
            <Paper
              withBorder
              shadow="lg"
              p={0}
              pr="xs"
              sx={{
                display: 'inline-flex',
                float: 'right',
                alignSelf: 'flex-end',
                marginRight: 6,
                position: 'sticky',
                top: 45,
                marginBottom: -65,
                zIndex: 10,
              }}
            >
              <SegmentedControl
                mr="xs"
                value={nsfwLevel.toString()}
                onChange={(v) => setNsfwLevel(parseInt(v, 10) as NsfwLevel)}
                data={[
                  { value: NsfwLevel.PG.toString(), label: 'PG' },
                  { value: NsfwLevel.PG13.toString(), label: 'PG13' },
                  { value: NsfwLevel.R.toString(), label: 'R' },
                  { value: NsfwLevel.X.toString(), label: 'X' },
                ]}
              />

              <Controls images={images} />
            </Paper>
          )}
          <Group align="flex-end">
            <Title>Rater Sanity Images</Title>
          </Group>

          {isLoading ? (
            <Center py="xl">
              <Loader size="xl" />
            </Center>
          ) : images?.length ? (
            <>
              <MasonryColumns
                data={images.filter((image) => image.nsfwLevel === nsfwLevel)}
                imageDimensions={(data) => {
                  const width = data?.width ?? 450;
                  const height = data?.height ?? 450;
                  return { width, height };
                }}
                maxItemHeight={600}
                render={ImageGridItem}
                itemId={(data) => data.id}
              />
            </>
          ) : (
            <NoContent mt="lg" message="There are no sanity images that match that criteria" />
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
  const entityUrl = getImageEntityUrl(image);

  const { ref: inViewRef, inView } = useInView({ rootMargin: '200%' });
  const ref = useRef<HTMLElement>(null);
  const mergedRef = useMergedRef(inViewRef, ref);

  return (
    <MasonryCard
      shadow="sm"
      p={0}
      withBorder
      ref={mergedRef as any}
      style={{
        minHeight: height,
        outline: selected
          ? `3px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`
          : undefined,
      }}
      onClick={() => toggleSelected(image.id)}
    >
      <>
        <Card.Section sx={{ height: `${height}px` }}>
          {inView && (
            <>
              <Checkbox
                checked={selected}
                size="lg"
                sx={{
                  position: 'absolute',
                  top: 5,
                  right: 5,
                  zIndex: 9,
                }}
              />
              <EdgeMedia
                src={image.url}
                name={image.id.toString()}
                type="image"
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
            </>
          )}
        </Card.Section>
      </>
    </MasonryCard>
  );
}

type ImageGridItemProps = {
  data: {
    id: number;
    url: string;
    width: number;
    height: number;
    nsfwLevel: NsfwLevel;
  };
  index: number;
  width: number;
  height: number;
};

function Controls({ images }: { images: SanityImage[] }) {
  const queryUtils = trpc.useUtils();
  const selected = useStore((state) => Object.keys(state.selected).map(Number));
  const selectMany = useStore((state) => state.selectMany);
  const deselectAll = useStore((state) => state.deselectAll);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const updateSanityImages = trpc.research.raterUpdateSanityImages.useMutation({
    onSettled: async () => {
      await queryUtils.research.raterGetSanityImages.invalidate();
    },
  });

  const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
    position: 'bottom',
    withArrow: true,
    withinPortal: true,
  };

  const handleDeleteSelected = () => {
    deselectAll();
    updateSanityImages.mutate({
      remove: selected,
    });
  };

  const handleSelectAll = () => {
    selectMany(images.map((x) => x.id));
  };

  const [addPopoverOpen, setAddPopoverOpen] = useState(false);
  const handleAdd = () => {
    if (!textareaRef.current) return;
    const values = textareaRef.current.value.split('\n').map((x) => x.trim());
    if (!values) return;

    const ids: number[] = [];
    for (const value of values) {
      let idString = value;
      if (idString.startsWith('http')) {
        idString = idString.split('/').pop()!;
      }
      const id = parseInt(idString, 10);
      if (!isNaN(id)) ids.push(id);
    }

    updateSanityImages.mutate({
      add: ids,
    });

    textareaRef.current.value = '';
    setAddPopoverOpen(false);
  };

  const handleClearAll = () => deselectAll();

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
      <Popover position="bottom-end" width={300} opened={addPopoverOpen}>
        <Popover.Target>
          <ActionIcon variant="outline" color="green" onClick={() => setAddPopoverOpen((x) => !x)}>
            <IconPlus size="1.25rem" />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown px="xs">
          <Stack spacing={4}>
            <Textarea ref={textareaRef} placeholder="Add a link or id per line" autosize />
            <Button fullWidth onClick={() => handleAdd()}>
              Add to Sanity Images
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}
