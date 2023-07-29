import React, { CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  DragOverlay,
  Modifier,
  useDraggable,
  useDroppable,
  rectIntersection,
  pointerWithin,
} from '@dnd-kit/core';
import { restrictToParentElement } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { trpc } from '~/utils/trpc';
import { HomeBlockGetAll } from '~/types/router';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconGripVertical,
  IconInfoCircle,
  IconPlayerPlay,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { CSS, getEventCoordinates } from '@dnd-kit/utilities';
import { openContext } from '~/providers/CustomModalsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NextLink } from '@mantine/next';
import { closeSpotlight } from '@mantine/spotlight';

const { openModal: openManageHomeBlocksModal, Modal } = createContextModal({
  name: 'manageHomeBlocks',
  title: 'Manage Home Page',
  size: 'md',
  Element: ({ context, props }) => {
    return <ManageHomeBlocks {...props} />;
  },
});

export { openManageHomeBlocksModal };
export default Modal;

function ManageHomeBlocks() {
  const { data: homeBlocks = [], isLoading: isLoadingOwnedHomeBlocks } =
    trpc.homeBlock.getHomeBlocks.useQuery({
      withCoreData: true,
      ownedOnly: true,
    });
  const { data: systemHomeBlocks = [], isLoading: isLoadingSystemHomeBlocks } =
    trpc.homeBlock.getSystemHomeBlocks.useQuery({
      permanent: false,
    });

  const utils = trpc.useContext();

  const isLoading = isLoadingSystemHomeBlocks || isLoadingOwnedHomeBlocks;
  const [items, setItems] = useState<HomeBlockGetAll>(homeBlocks);
  const [activeItem, setActiveItem] = useState<HomeBlockGetAll[number] | null>(null);
  const [activeItemType, setActiveItemType] = useState<'user' | 'system' | null>(null);
  const { setNodeRef: userContentNodeRef, isOver } = useDroppable({ id: 'user' });
  const { setNodeRef: systemContentNodeRef } = useDroppable({ id: 'system' });
  const { mutate: setHomeBlocksOrder, isLoading: isUpdating } =
    trpc.homeBlock.setHomeBlockOrder.useMutation({
      async onSuccess() {
        showSuccessNotification({
          title: 'Home page has been updated',
          message: `Your preferred order has been saved`,
        });

        await utils.homeBlock.getHomeBlocks.invalidate();
      },
      onError(error) {
        showErrorNotification({
          title: 'There was an error updating your home page',
          error: new Error(error.message),
        });
      },
    });

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const availableSystemHomeBlocks = useMemo(() => {
    return systemHomeBlocks.filter((systemHomeBlock) => {
      return !items.find(
        // Check source items & actively selected system home blocks
        (item) => item.sourceId === systemHomeBlock.id || item.id === systemHomeBlock.id
      );
    });
  }, [items, systemHomeBlocks, activeItem]);

  const snapVerticalCenterToCursor = useMemo(() => {
    const mofifier: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
      if (draggingNodeRect && activatorEvent) {
        const activatorCoordinates = getEventCoordinates(activatorEvent);

        if (!activatorCoordinates) {
          return transform;
        }

        const offsetY = activatorCoordinates.y - draggingNodeRect.top;
        return {
          ...transform,
          y: transform.y + offsetY - draggingNodeRect.height / 2,
        };
      }

      return transform;
    };

    return mofifier;
  }, []);

  useEffect(() => {
    if (!isLoadingOwnedHomeBlocks) {
      setItems(homeBlocks);
    }
  }, [homeBlocks, isLoadingOwnedHomeBlocks]);

  const isSystemBlock = useMemo(
    () => (id: number | null) =>
      availableSystemHomeBlocks.find((systemHomeBlock) => id === systemHomeBlock.id),
    [availableSystemHomeBlocks]
  );

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader variant="bars" />
      </Center>
    );
  }

  const onRemoveItem = (id: number) => {
    setItems(items.filter((item) => item.id !== id));
  };

  const handleSave = () => {
    const data = items.map((item, index) => ({ id: item.id, index, userId: item.userId }));
    setHomeBlocksOrder({ homeBlocks: data });
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => {
        const systemHomeBlock = availableSystemHomeBlocks.find((item) => item.id === active.id);

        if (systemHomeBlock) {
          setActiveItem(systemHomeBlock);
          setActiveItemType('system');
          return;
        }

        const item = items.find((item) => item.id === active.id) || null;

        if (item) {
          setActiveItemType('user');
          setActiveItem(item);
        }
      }}
      onDragOver={({ active, over }) => {
        const activeOnItemList = !!items.find((item) => item.id === active.id);
        const isOverItemList = over && !!items.find((item) => item.id === over.id);

        if (isOverItemList && !activeOnItemList && activeItemType === 'system') {
          // Add item at the start of the list.
          const item = availableSystemHomeBlocks.find((item) => item.id === active.id) || null;
          if (item) {
            setItems([item, ...items]);
          }
        }

        if (!over && activeItemType === 'system' && activeOnItemList) {
          // Remove the item.
          setItems(items.filter((item) => item.id !== active.id));
        }
      }}
      onDragEnd={({ active, over, ...other }) => {
        if (over && active.id !== over?.id) {
          const activeIndex = items.findIndex(({ id }) => id === active.id);
          const overIndex = items.findIndex(({ id }) => id === over.id);

          setItems(arrayMove(items, activeIndex, overIndex));
        }

        setActiveItem(null);
        setActiveItemType(null);
      }}
      collisionDetection={rectIntersection}
      onDragCancel={() => setActiveItem(null)}
    >
      <Group
        spacing="xs"
        py="xs"
        sx={(theme) => ({
          borderTop: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
          }`,
        })}
      >
        <Badge color="yellow" variant="light" size="xs">
          Beta
        </Badge>
        <Text size="xs" color="dimmed" inline>
          Expect frequent changes.
        </Text>
      </Group>
      <Box ref={systemContentNodeRef}>
        {availableSystemHomeBlocks.length > 0 && (
          <Stack>
            <Badge gradient={{ from: 'cyan', to: 'blue' }} variant="gradient">
              Civitai Home Blocks
            </Badge>

            {availableSystemHomeBlocks.map((systemHomeBlock) => (
              <SystemHomeBlock key={systemHomeBlock.id} homeBlock={systemHomeBlock} />
            ))}
          </Stack>
        )}
      </Box>

      <Box ref={userContentNodeRef}>
        <Stack>
          <Badge mt="md" gradient={{ from: 'cyan', to: 'blue' }} variant="gradient">
            Your home
          </Badge>
          <SortableContext items={items} strategy={verticalListSortingStrategy}>
            {items.length === 0 && (
              <AlertWithIcon
                py={5}
                my="xs"
                title="No home blocks selected"
                icon={<IconInfoCircle />}
                iconSize="lg"
                radius="md"
              >
                <Text>
                  By removing all your home blocks and saving you will end up with our default
                  recommended home page setup.
                </Text>
              </AlertWithIcon>
            )}

            {items.map((item) => (
              <SortableHomeBlock key={item.id} onRemove={onRemoveItem} homeBlock={item} />
            ))}
          </SortableContext>
        </Stack>
      </Box>

      <DragOverlay modifiers={[restrictToParentElement, snapVerticalCenterToCursor]}>
        {!activeItem || isSystemBlock(activeItem.id) ? null : (
          <SortableHomeBlock key={activeItem.id} homeBlock={activeItem} />
        )}
      </DragOverlay>

      <Stack>
        <Button mt="sm" disabled={isUpdating} onClick={handleSave}>
          {isUpdating ? 'Updating settings...' : 'Save'}
        </Button>
      </Stack>
    </DndContext>
  );
}

function SortableHomeBlock({
  homeBlock,
  onRemove,
}: {
  homeBlock: HomeBlockGetAll[number];
  onRemove?: (id: number) => void;
}) {
  const sortable = useSortable({ id: homeBlock.id });
  const { attributes, listeners, isDragging, setNodeRef, transform, transition } = sortable;

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? 'grabbing' : 'pointer',
    opacity: isDragging ? 0.4 : undefined,
  };
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const homeBlockName = metadata?.title || homeBlock.collection?.name;

  return (
    <Card withBorder style={style} {...attributes} {...listeners} ref={setNodeRef}>
      <Group noWrap align="center">
        <IconGripVertical />
        <Text size="md" lineClamp={1}>
          {homeBlockName}
        </Text>
        {onRemove && (
          <ActionIcon ml="auto" onClick={() => onRemove(homeBlock.id)}>
            <IconTrash size={16} />
          </ActionIcon>
        )}
      </Group>
    </Card>
  );
}

function SystemHomeBlock({ homeBlock }: { homeBlock: HomeBlockGetAll[number] }) {
  const draggable = useDraggable({ id: homeBlock.id });
  const { attributes, listeners, isDragging, setNodeRef, transform } = draggable;

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    cursor: isDragging ? 'grabbing' : 'pointer',
    zIndex: isDragging ? 1 : undefined,
  };

  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const homeBlockName = metadata?.title || homeBlock.collection?.name;

  return (
    <Card withBorder style={style} {...attributes} {...listeners} ref={setNodeRef}>
      <Group align="start">
        <IconGripVertical />
        <Text size="md" lineClamp={1}>
          {homeBlockName}
        </Text>
      </Group>
    </Card>
  );
}
