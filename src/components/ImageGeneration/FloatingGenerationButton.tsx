import { Group, Text } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import { FloatingActionButton } from '~/components/FloatingActionButton/FloatingActionButton';
import { useGenerationStore } from '~/store/generation.store';

export function FloatingGenerationButton() {
  const drawerOpened = useGenerationStore((state) => state.drawerOpened);
  const toggleDrawer = useGenerationStore((state) => state.toggleDrawer);

  return (
    <FloatingActionButton
      transition="pop"
      onClick={() => toggleDrawer()}
      mounted={!drawerOpened}
      px="xs"
    >
      <Group spacing="xs">
        <IconBrush size={20} stroke={2.5} />
        <Text inherit>Create</Text>
      </Group>
    </FloatingActionButton>
  );
}
