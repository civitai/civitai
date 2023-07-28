import { useEffect, useState } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { trpc } from '~/utils/trpc';
import { HomeBlockGetAll } from '~/types/router';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { Card, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { IconGripVertical } from '@tabler/icons-react';

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
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery({
    withCoreData: true,
    ownedOnly: true,
  });
  const [items, setItems] = useState<HomeBlockGetAll>(homeBlocks);
  const queryUtils = trpc.useContext();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    setItems(homeBlocks);
  }, [homeBlocks]);

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader variant="bars" />
      </Center>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over?.id) {
          const activeIndex = items.findIndex(({ id }) => id === active.id);
          const overIndex = items.findIndex(({ id }) => id === over.id);

          setItems(arrayMove(items, activeIndex, overIndex));
        }
      }}
      collisionDetection={closestCenter}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <Stack>
          {items.map((item) => (
            <SortableHomeBlock key={item.id} homeBlock={item} />
          ))}
        </Stack>
      </SortableContext>
    </DndContext>
  );
}

function SortableHomeBlock({ homeBlock }: { homeBlock: HomeBlockGetAll[number] }) {
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const homeBlockName = metadata?.title || homeBlock.collection?.name;

  return (
    <SortableItem key={homeBlock.id} id={homeBlock.id}>
      <Card withBorder>
        <Group align="start">
          <IconGripVertical />
          <Text size="md" lineClamp={2}>
            {homeBlockName}
          </Text>
        </Group>
      </Card>
    </SortableItem>
  );
}
