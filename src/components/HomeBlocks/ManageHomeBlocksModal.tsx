import React, { CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  Modifier,
  rectIntersection,
} from '@dnd-kit/core';
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
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronUp,
  IconGripVertical,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlus,
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
  const [systemBlocksOpen, setSystemBlocksOpen] = useState(false);
  const [items, setItems] = useState<HomeBlockGetAll>(homeBlocks);
  const [activeItem, setActiveItem] = useState<HomeBlockGetAll[number] | null>(null);
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

  useEffect(() => {
    if (!isLoadingOwnedHomeBlocks) {
      setItems(homeBlocks);
    }
  }, [homeBlocks, isLoadingOwnedHomeBlocks]);

  useEffect(() => {
    if (items.length === 0 && availableSystemHomeBlocks.length) {
      setSystemBlocksOpen(true);
    }
  }, [items, availableSystemHomeBlocks]);

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

  const onAddSystemHomeBlock = (id: number) => {
    const systemHomeBlock = availableSystemHomeBlocks.find(
      (systemHomeBlock) => id === systemHomeBlock.id
    );

    if (systemHomeBlock) {
      setItems([...items, systemHomeBlock]);
    }
  };

  const handleSave = () => {
    const data = items.map((item, index) => ({ id: item.id, index, userId: item.userId }));
    setHomeBlocksOrder({ homeBlocks: data });
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => {
        const item = items.find((item) => item.id === active.id) || null;
        setActiveItem(item);
      }}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over?.id) {
          const activeIndex = items.findIndex(({ id }) => id === active.id);
          const overIndex = items.findIndex(({ id }) => id === over.id);

          setItems(arrayMove(items, activeIndex, overIndex));
        }

        setActiveItem(null);
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
      <Box>
        <Stack>
          <Button
            size="xs"
            fontSize="sm"
            variant="gradient"
            gradient={{ from: 'cyan', to: 'blue' }}
            onClick={() => setSystemBlocksOpen((o) => !o)}
            rightIcon={systemBlocksOpen ? <IconChevronUp /> : <IconChevronDown />}
          >
            Civitai Home Blocks
          </Button>
          <Collapse in={systemBlocksOpen}>
            {availableSystemHomeBlocks.length > 0 ? (
              <Stack>
                {availableSystemHomeBlocks.map((systemHomeBlock) => (
                  <SystemHomeBlock
                    key={systemHomeBlock.id}
                    onAdd={onAddSystemHomeBlock}
                    homeBlock={systemHomeBlock}
                  />
                ))}
              </Stack>
            ) : (
              <AlertWithIcon
                py={5}
                my="xs"
                title="All home blocks selected"
                icon={<IconInfoCircle />}
                iconSize="lg"
                radius="md"
              >
                <Text>All civitai home blocks are already selected.</Text>
              </AlertWithIcon>
            )}
          </Collapse>
        </Stack>
      </Box>

      <Box>
        <Stack>
          <Badge
            mt="md"
            size="md"
            h={30}
            fontSize="sm"
            gradient={{ from: 'cyan', to: 'blue' }}
            variant="gradient"
            style={{ textTransform: 'capitalize' }}
          >
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
                  By leaving this empty you will end up with our default recommended home page
                  setup.
                </Text>
              </AlertWithIcon>
            )}

            {items.map((item) => (
              <SortableHomeBlock key={item.id} onRemove={onRemoveItem} homeBlock={item} />
            ))}
          </SortableContext>
        </Stack>
      </Box>

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
    zIndex: isDragging ? 1 : undefined,
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

function SystemHomeBlock({
  homeBlock,
  onAdd,
}: {
  homeBlock: HomeBlockGetAll[number];
  onAdd?: (id: number) => void;
}) {
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const homeBlockName = metadata?.title || homeBlock.collection?.name;

  return (
    <Card withBorder>
      <Group align="start">
        <IconGripVertical />
        <Text size="md" lineClamp={1}>
          {homeBlockName}
        </Text>

        {onAdd && (
          <ActionIcon ml="auto" onClick={() => onAdd(homeBlock.id)}>
            <IconPlus size={16} />
          </ActionIcon>
        )}
      </Group>
    </Card>
  );
}
