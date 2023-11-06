import {
  Box,
  Button,
  Center,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  Loader,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import React, { useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
import { GenericImageCard } from '~/components/Cards/GenericImageCard';
import { IconTrash } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { getAllAvailableProfileSections } from '~/components/Profile/profile.utils';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  rectIntersection,
  UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { SortableItem } from '~/components/ImageUpload/SortableItem';

type ShowcaseItemsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ShowcaseItemSchema[];
  onChange?: (value: ShowcaseItemSchema[]) => void;
  username: string;
  limit?: number;
};

const useStyles = createStyles((theme) => ({
  selectedItemsGrid: {
    display: 'grid',
    gridTemplateColumns: `repeat(5, 1fr)`,
    gridGap: 4,

    [theme.fn.smallerThan('sm')]: {
      gridTemplateColumns: `repeat(2, 1fr)`,
    },
  },
  selectedItemRemove: {
    position: 'absolute',
    top: '-10px',
    left: '-10px',
    width: '30px',
    height: '30px',
    borderRadius: '50%',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

export const ShowcaseItemsInput = ({
  value,
  onChange,
  username,
  limit = 5,
  ...props
}: ShowcaseItemsInputProps) => {
  const { classes } = useStyles();
  const [showcaseItems, setShowcaseItems] = useState<ShowcaseItemSchema[]>(value || []);
  const [error, setError] = useState('');
  const {
    data: coverImages,
    isLoading,
    isRefetching,
  } = trpc.image.getEntitiesCoverImage.useQuery(
    {
      entities: showcaseItems,
    },
    {
      enabled: showcaseItems.length > 0,
      keepPreviousData: true,
    }
  );

  useDidUpdate(() => {
    if (showcaseItems) {
      onChange?.(showcaseItems);
    }
  }, [showcaseItems]);

  useDidUpdate(() => {
    if (!isEqual(value, showcaseItems)) {
      // Value changed outside.
      setShowcaseItems(value || []);
    }
  }, [value]);

  const onItemSelected = (item: ShowcaseItemSchema) => {
    if (
      showcaseItems.find((i) => i.entityId === item.entityId && i.entityType === item.entityType)
    ) {
      // This already has been added.
      return;
    }

    if (showcaseItems.length >= limit) {
      setShowcaseItems((current) => [item, ...current.slice(0, limit - 1)]);
    } else {
      setShowcaseItems((current) => [item, ...current]);
    }
  };

  const onRemoveSelectedItem = (item: ShowcaseItemSchema) => {
    setShowcaseItems((current) =>
      current.filter((i) => !(i.entityId === item.entityId && i.entityType === item.entityType))
    );
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setShowcaseItems((items) => {
        const ids = items.map(
          ({ entityType, entityId }): UniqueIdentifier => `${entityType}-${entityId}`
        );
        const oldIndex = ids.indexOf(active.id);
        const newIndex = ids.indexOf(over.id);
        const sorted = arrayMove(items, oldIndex, newIndex);
        return sorted;
      });
    }
  };

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Stack spacing="xs" mt="sm">
        <QuickSearchDropdown
          supportedIndexes={['models', 'images']}
          onItemSelected={onItemSelected}
          filters={`user.username='${username}'`}
          dropdownItemLimit={25}
        />

        <Paper mt="md">
          <DndContext
            sensors={sensors}
            collisionDetection={rectIntersection}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={showcaseItems.map((item) => `${item.entityType}-${item.entityId}`)}
              strategy={horizontalListSortingStrategy}
            >
              {showcaseItems.length > 0 ? (
                <Box className={classes.selectedItemsGrid}>
                  {showcaseItems.map((item) => {
                    const coverImage = coverImages?.find(
                      (i) => i.entityType === item.entityType && i.entityId === item.entityId
                    );

                    const removeBtn = (
                      <Button
                        onClick={() => onRemoveSelectedItem(item)}
                        className={classes.selectedItemRemove}
                        color="red"
                        variant="filled"
                        radius="xl"
                      >
                        <IconTrash size={15} />
                      </Button>
                    );

                    const key = `${item.entityType}-${item.entityId}`;

                    if (!coverImage) {
                      return (
                        <SortableItem key={key} id={key}>
                          <Paper withBorder radius="md" p="md" pos="relative">
                            <Stack w="100%" h="100%">
                              <Center>
                                {isRefetching || isLoading ? (
                                  <Loader />
                                ) : (
                                  <Text align="center">Could not find cover image</Text>
                                )}
                              </Center>
                            </Stack>
                            {removeBtn}
                          </Paper>
                        </SortableItem>
                      );
                    }

                    return (
                      <SortableItem key={key} id={key}>
                        <Box pos="relative">
                          <GenericImageCard {...item} image={coverImage} disabled />
                          {removeBtn}
                        </Box>
                      </SortableItem>
                    );
                  })}
                </Box>
              ) : (
                <Center>
                  <Text size="sm" color="dimmed">
                    You have not selected any items to showcase.
                  </Text>
                </Center>
              )}
            </SortableContext>
          </DndContext>
        </Paper>
      </Stack>
    </Input.Wrapper>
  );
};
