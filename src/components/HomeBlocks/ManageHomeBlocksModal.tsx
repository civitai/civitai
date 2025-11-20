import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, rectIntersection } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { trpc } from '~/utils/trpc';
import type { HomeBlockGetAll } from '~/types/router';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  Modal,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconGripVertical, IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { CSS } from '@dnd-kit/utilities';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogContext';
import classes from './ManageHomeBlocksModal.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export default function ManageHomeBlocksModal() {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} title="Manage Home Page" size="md">
      <ManageHomeBlocks onClose={dialog.onClose} />
    </Modal>
  );
}

type Props = { onClose: VoidFunction };
function ManageHomeBlocks({ onClose }: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { data: homeBlocks = [], isLoading: isLoadingOwnedHomeBlocks } =
    trpc.homeBlock.getHomeBlocks.useQuery({
      withCoreData: true,
      ownedOnly: true,
    });
  const { data: systemHomeBlocks = [], isLoading: isLoadingSystemHomeBlocks } =
    trpc.homeBlock.getSystemHomeBlocks.useQuery({
      permanent: false,
    });

  const utils = trpc.useUtils();

  const isLoading = isLoadingSystemHomeBlocks || isLoadingOwnedHomeBlocks;
  const [items, setItems] = useState<HomeBlockGetAll>(homeBlocks);
  const [activeAccordion, setActionAccordion] = useState<string | null>('system-home-blocks');
  const { mutate: setHomeBlocksOrder, isLoading: isUpdating } =
    trpc.homeBlock.setHomeBlockOrder.useMutation({
      async onSuccess() {
        showSuccessNotification({
          title: 'Home page has been updated',
          message: `Your preferred order has been saved`,
        });

        onClose();
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
  }, [items, systemHomeBlocks]);

  useEffect(() => {
    if (!isLoadingOwnedHomeBlocks) {
      setItems(homeBlocks);
    }
  }, [homeBlocks, isLoadingOwnedHomeBlocks]);

  useEffect(() => {
    if (!isLoading && items.length === 0 && availableSystemHomeBlocks.length > 0) {
      setActionAccordion('system-home-blocks');
    }
  }, [availableSystemHomeBlocks.length, isLoading, items.length]);

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader type="bars" />
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
    const data = items.map((item, index) => ({
      id: item.id,
      index,
      userId: item.userId,
    }));
    setHomeBlocksOrder({ homeBlocks: data });
  };

  return (
    <>
      <Group
        gap="xs"
        py="md"
        style={{
          borderTop: `1px solid ${
            colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
          }`,
        }}
      >
        <Badge color="yellow" variant="light" size="xs">
          Beta
        </Badge>
        <Text size="xs" c="dimmed" inline>
          Expect frequent changes.
        </Text>
      </Group>
      <Accordion
        variant="separated"
        value={activeAccordion}
        onChange={(value) => setActionAccordion(value)}
      >
        <Accordion.Item value="system-home-blocks">
          <Accordion.Control>Civitai Home Blocks</Accordion.Control>
          <Accordion.Panel>
            {availableSystemHomeBlocks.length > 0 ? (
              <Stack gap={8}>
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
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <Stack gap={8}>
        <Badge
          mt="md"
          size="md"
          h={30}
          gradient={{ from: 'cyan', to: 'blue' }}
          variant="gradient"
          className={classes.sectionHeader}
        >
          Your home
        </Badge>

        <DndContext
          sensors={sensors}
          onDragEnd={({ active, over }) => {
            if (over && active.id !== over?.id) {
              const activeIndex = items.findIndex(({ id }) => id === active.id);
              const overIndex = items.findIndex(({ id }) => id === over.id);

              setItems(arrayMove(items, activeIndex, overIndex));
            }
          }}
          collisionDetection={rectIntersection}
        >
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
        </DndContext>
      </Stack>

      <Stack>
        <Button mt="sm" disabled={isUpdating} onClick={handleSave}>
          {isUpdating ? 'Updating settings...' : 'Save'}
        </Button>
      </Stack>
    </>
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
    cursor: isDragging ? 'grabbing' : 'grab',
    zIndex: isDragging ? 1 : undefined,
    touchAction: 'none',
  };
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const homeBlockName = metadata?.title || homeBlock.collection?.name;

  return (
    <Card px="md" py={8} withBorder style={style} {...attributes} {...listeners} ref={setNodeRef}>
      <Group wrap="nowrap" align="center">
        <IconGripVertical />
        <Text size="md" lineClamp={1}>
          {homeBlockName}
        </Text>
        {onRemove && (
          <LegacyActionIcon ml="auto" color="red" onClick={() => onRemove(homeBlock.id)}>
            <IconTrash size={16} />
          </LegacyActionIcon>
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
    <Card px="md" py={8} withBorder>
      <Group>
        <Text size="md" lineClamp={1}>
          {homeBlockName}
        </Text>

        {onAdd && (
          <LegacyActionIcon ml="auto" onClick={() => onAdd(homeBlock.id)}>
            <IconPlus size={16} />
          </LegacyActionIcon>
        )}
      </Group>
    </Card>
  );
}
