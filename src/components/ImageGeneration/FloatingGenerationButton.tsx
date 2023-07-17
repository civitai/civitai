import { Group, Text } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import { FloatingActionButton } from '~/components/FloatingActionButton/FloatingActionButton';
import { useGenerationStore } from '~/store/generation.store';

export function FloatingGenerationButton() {
  const opened = useGenerationStore((state) => state.opened);
  const open = useGenerationStore((state) => state.open);

  return (
    <FloatingActionButton transition="pop" onClick={() => open()} mounted={!opened} px="xs">
      <Group spacing="xs">
        <IconBrush size={20} stroke={2.5} />
        <Text inherit>Create</Text>
      </Group>
    </FloatingActionButton>
  );
}
